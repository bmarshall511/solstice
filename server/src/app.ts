// The Solstice HTTP API. Runs as a single Vercel function in production (api/index.ts) and via server/src/index.ts locally.
import express, { type Request, type Response, type NextFunction } from 'express';
import { q, one, kv, migrate } from './db.js';
import { config } from './config.js';
import { hashPassword, verifyPassword, startSession, endSession, currentUser, requireUser, requireSite, tooManyAttempts, recordAttempt, signState, verifyState, multiUser } from './auth.js';
import { authorizeUrl, exchangeCode } from './tesla/auth.js';
import { teslaFor, localDay, addDays } from './tesla/client.js';
import { refreshLive, refreshSiteInfo, syncSite, saveEnergyRows, saveSoe } from './sync.js';
import { listBills, parsePecPdf, saveBill, type Bill } from './bills.js';
import { reconcile } from './reconcile.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(async (_req, _res, next) => { try { await migrate(); next(); } catch (e) { next(e); } });

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const K = (col: string) => `ROUND((SUM(${col}) / 1000.0)::numeric, 2)::float8`;
const kwhCols = `${K('solar_wh')} solar, ${K('home_wh')} home, ${K('import_wh')} import, ${K('export_wh')} export, ${K('charge_wh')} charge, ${K('discharge_wh')} discharge`;
const r2 = (v: number) => Math.round(v * 100) / 100;
const site = (req: Request) => req.siteId!;

/* ======================= accounts ======================= */
app.get('/api/auth/me', wrap(async (req, res) => {
  if (!multiUser()) { // single-owner mode: no accounts, just the connected site
    const s = await one<{ id: string; name: string }>('SELECT id, name FROM sites WHERE tesla_account_id IS NOT NULL ORDER BY created_at LIMIT 1');
    return res.json({ mode: 'single', user: null, site: s ?? null });
  }
  const user = await currentUser(req);
  const users = Number((await one<{ n: string }>('SELECT COUNT(*) n FROM users'))!.n);
  if (!user) return res.json({ user: null, needsSetup: users === 0, signupsOpen: process.env.ALLOW_SIGNUPS === 'true' });
  const s = await one<{ id: string; name: string }>('SELECT id, name FROM sites WHERE user_id = $1 ORDER BY created_at LIMIT 1', [user.id]);
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role }, site: s ?? null, needsSetup: false });
}));

/** First run: create the owner account with a one-time SETUP_TOKEN, and claim any data migrated from the local install. */
app.post('/api/auth/setup', express.json(), wrap(async (req, res) => {
  const { token, email, password, name } = req.body ?? {};
  if (!process.env.SETUP_TOKEN || token !== process.env.SETUP_TOKEN) return res.status(403).json({ error: 'Invalid setup link' });
  if (Number((await one<{ n: string }>('SELECT COUNT(*) n FROM users'))!.n) > 0) return res.status(409).json({ error: 'Already set up. Sign in instead.' });
  if (!/^\S+@\S+\.\S+$/.test(email ?? '') || String(password ?? '').length < 10) return res.status(400).json({ error: 'Use a valid email and a password of at least 10 characters.' });
  const u = (await one<{ id: number }>(`INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'owner') RETURNING id`, [String(email).toLowerCase(), name ?? null, await hashPassword(password)]))!;
  await q('UPDATE tesla_accounts SET user_id = $1 WHERE user_id IS NULL', [u.id]);
  await q('UPDATE sites SET user_id = $1 WHERE user_id IS NULL', [u.id]);
  await startSession(req, res, u.id);
  res.json({ ok: true });
}));

app.post('/api/auth/signup', express.json(), wrap(async (req, res) => {
  if (process.env.ALLOW_SIGNUPS !== 'true') return res.status(403).json({ error: 'Sign-ups are closed' });
  const { email, password, name } = req.body ?? {};
  if (!/^\S+@\S+\.\S+$/.test(email ?? '') || String(password ?? '').length < 10) return res.status(400).json({ error: 'Use a valid email and a password of at least 10 characters.' });
  if (await one('SELECT 1 FROM users WHERE email = $1', [String(email).toLowerCase()])) return res.status(409).json({ error: 'That email already has an account.' });
  const u = (await one<{ id: number }>('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [String(email).toLowerCase(), name ?? null, await hashPassword(password)]))!;
  await startSession(req, res, u.id);
  res.json({ ok: true });
}));

app.post('/api/auth/login', express.json(), wrap(async (req, res) => {
  const email = String(req.body?.email ?? '').toLowerCase(), password = String(req.body?.password ?? '');
  if (await tooManyAttempts(email)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const u = await one<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = $1', [email]);
  const ok = !!u && await verifyPassword(password, u.password_hash);
  await recordAttempt(email, ok);
  if (!ok) return res.status(401).json({ error: 'Wrong email or password.' });
  await startSession(req, res, u!.id);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', wrap(async (req, res) => { await endSession(req, res); res.json({ ok: true }); }));

/* ======================= Tesla connection ======================= */
app.get('/auth/login', wrap(async (req, res) => {
  if (!multiUser()) return res.redirect(authorizeUrl(signState(0)));
  const user = await currentUser(req);
  if (!user) return res.redirect('/?signin=1');
  res.redirect(authorizeUrl(signState(user.id)));
}));

app.get('/auth/callback', wrap(async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  if (error) return res.redirect(`/?tesla_error=${encodeURIComponent(error_description || error)}`);
  const uid = verifyState(state ?? '');
  let ownerId: number | null = null;
  if (multiUser()) { const user = await currentUser(req); if (!uid || !user || user.id !== uid) return res.redirect('/?tesla_error=Sign-in+expired.+Try+again.'); ownerId = user.id; }
  else if (uid !== 0) return res.redirect('/?tesla_error=Sign-in+expired.+Try+again.');
  const accountId = await exchangeCode(code, ownerId);
  const products = await teslaFor(accountId).products();
  for (const p of products.filter(p => p.energy_site_id)) {
    const id = String(p.energy_site_id);
    await q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, tesla_account_id = excluded.tesla_account_id`, [id, ownerId, accountId, String(p.site_name ?? 'Home')]);
    await refreshSiteInfo(id, accountId);
  }
  res.redirect('/');
}));

/* ======================= nightly sync (Vercel Cron) ======================= */
app.get('/api/cron/sync', wrap(async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  const sites = await q<{ id: string }>('SELECT id FROM sites WHERE tesla_account_id IS NOT NULL');
  const out: Record<string, unknown> = {};
  for (const s of sites) out[s.id] = await syncSite(s.id, Math.floor(50_000 / sites.length)).catch(e => ({ error: e.message }));
  await q(`DELETE FROM readings WHERE ts < $1`, [Date.now() - 3 * 864e5]); // live snapshots are short-lived; history lives in `energy`
  res.json(out);
}));

/* ======================= one-time import from the local install (protected by SETUP_TOKEN) ======================= */
app.post('/api/admin/import', express.json({ limit: '25mb' }), wrap(async (req, res) => {
  if (!process.env.SETUP_TOKEN || req.headers.authorization !== `Bearer ${process.env.SETUP_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
  const { kind, siteId, rows, site } = req.body ?? {};
  if (kind === 'site') {
    const a = site.tokens, existing = await one<{ id: number }>('SELECT id FROM tesla_accounts WHERE user_id IS NULL ORDER BY id LIMIT 1');
    const acct = existing ? (await q('UPDATE tesla_accounts SET access_token=$2, refresh_token=$3, expires_at=$4, scope=$5 WHERE id=$1 RETURNING id', [existing.id, a.access_token, a.refresh_token, a.expires_at, a.scope ?? null]))[0].id
      : (await one<{ id: number }>('INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at, scope) VALUES (NULL,$1,$2,$3,$4) RETURNING id', [a.access_token, a.refresh_token, a.expires_at, a.scope ?? null]))!.id;
    await q(`INSERT INTO sites (id, user_id, tesla_account_id, name, info, info_at) VALUES ($1, NULL, $2, $3, $4, now())
      ON CONFLICT (id) DO UPDATE SET tesla_account_id = excluded.tesla_account_id, info = excluded.info, info_at = now()`, [siteId, acct, site.info?.site_name ?? 'Home', JSON.stringify(site.info ?? {})]);
  } else if (kind === 'energy') await saveEnergyRows(siteId, rows);
  else if (kind === 'soe') await saveSoe(siteId, rows);
  else if (kind === 'outages') for (const e of rows) await q('INSERT INTO backup_events VALUES ($1,$2,$3,$4) ON CONFLICT (site_id, ts) DO UPDATE SET duration_s = excluded.duration_s', [siteId, e.ts, e.epoch, e.duration_s]);
  else if (kind === 'bills') for (const b of rows) await saveBill(siteId, b);
  else if (kind === 'days') await q(`INSERT INTO synced_days SELECT $1, 'day', unnest($2::text[]) ON CONFLICT DO NOTHING`, [siteId, rows]);
  else return res.status(400).json({ error: 'unknown kind' });
  res.json({ ok: true, kind, n: rows?.length ?? 1 });
}));

/* ======================= everything below needs a signed-in user ======================= */
app.use('/api', requireUser);

app.get('/api/settings', wrap(async (req, res) => res.json(req.user ? req.user.settings ?? {} : await kv.get('settings:owner') ?? {})));
app.put('/api/settings', express.json(), wrap(async (req, res) => {
  if (req.user) await q('UPDATE users SET settings = settings || $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify(req.body ?? {})]);
  else await kv.set('settings:owner', { ...(await kv.get<object>('settings:owner') ?? {}), ...(req.body ?? {}) });
  res.json({ ok: true });
}));

app.use('/api', requireSite);

function summary(info: any) {
  info ??= {};
  return {
    name: info.site_name, installed: info.installation_date, utility: info.utility, firmware: info.version,
    batteryCount: info.battery_count, batteries: (info.components?.batteries ?? []).map((b: any) => ({ name: b.part_name, kwh: b.nameplate_energy / 1000, kw: b.nameplate_max_discharge_power / 1000 })),
    capacityKwh: (info.nameplate_energy ?? 0) / 1000, maxPowerKw: (info.nameplate_power ?? 0) / 1000,
    reservePct: info.backup_reserve_percent, mode: info.default_real_mode, stormWatch: info.user_settings?.storm_mode_enabled ?? null,
  };
}
const siteInfo = async (id: string) => (await one<{ info: any }>('SELECT info FROM sites WHERE id = $1', [id]))?.info;

app.get('/api/now', wrap(async (req, res) => {
  const id = site(req);
  let liveError: string | null = null;
  await refreshLive(id).catch(e => { liveError = e.message; });
  const r = await one('SELECT * FROM readings WHERE site_id = $1 ORDER BY ts DESC LIMIT 1', [id]);
  const down = (x: any) => !!x && (x.grid_status !== 'Active' || /off_grid/.test(x.island_status ?? ''));
  let outage: { active: boolean; since?: number } = { active: false };
  if (down(r)) {
    const up = await one<{ ts: string }>(`SELECT ts FROM readings WHERE site_id = $1 AND grid_status = 'Active' AND island_status NOT LIKE '%off_grid%' ORDER BY ts DESC LIMIT 1`, [id]);
    const start = await one<{ ts: string }>('SELECT MIN(ts) ts FROM readings WHERE site_id = $1 AND ts > $2', [id, up?.ts ?? 0]);
    outage = { active: true, since: Number(start?.ts) };
  }
  const lastLive = await kv.get<number>(`${id}:lastLive`), lastHistory = await kv.get<number>(`${id}:lastHistory`);
  const errors = Object.fromEntries(await Promise.all(['siteInfo', 'lastHistory', 'lastBackups'].map(async k => [k, await kv.get(`${id}:error:${k}`) ?? null])));
  res.json({
    reading: r && { ts: Number(r.ts), solarKw: r.solar_w / 1000, homeKw: r.load_w / 1000, batteryKw: r.battery_w / 1000, gridKw: r.grid_w / 1000, soc: r.soc,
      gridStatus: r.grid_status, islandStatus: r.island_status, stormActive: !!r.storm_mode_active },
    today: await one(`SELECT ${kwhCols} FROM energy WHERE site_id = $1 AND day = $2`, [id, localDay()]),
    site: summary(await siteInfo(id)), outage,
    health: { lastLive: lastLive ?? null, lastHistory: lastHistory ?? null, stale: !lastLive || Date.now() - lastLive > 3 * 60_000, liveError, errors },
  });
}));

/** The app calls this on open and every few minutes: pulls today's history and backfills missing days within a time budget. */
app.post('/api/sync', wrap(async (req, res) => res.json(await syncSite(site(req), 8_000))));

app.get('/api/status', wrap(async (req, res) => {
  const id = site(req), d = await one<{ n: number }>(`SELECT COUNT(DISTINCT day)::int n FROM energy WHERE site_id = $1`, [id]);
  res.json({ connected: true, siteId: id, lastLive: await kv.get(`${id}:lastLive`) ?? null, lastHistory: await kv.get(`${id}:lastHistory`) ?? null, backfill: { daysDone: d?.n ?? 0 } });
}));

app.get('/api/day', wrap(async (req, res) => {
  const id = site(req), date = String(req.query.date ?? localDay());
  const b = await q(`SELECT ts, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh FROM energy WHERE site_id = $1 AND day = $2 ORDER BY epoch`, [id, date]);
  const s = await q(`SELECT ts, soe FROM soe WHERE site_id = $1 AND day = $2 ORDER BY epoch`, [id, date]);
  const t = (ts: string) => +ts.slice(11, 13) + +ts.slice(14, 16) / 60;
  res.json({ date,
    buckets: b.map(x => ({ t: t(x.ts), solar: r2(x.solar_wh * 12 / 1000), home: r2(x.home_wh * 12 / 1000), grid: r2((x.import_wh - x.export_wh) * 12 / 1000), battery: r2((x.discharge_wh - x.charge_wh) * 12 / 1000) })),
    soe: s.map(x => ({ t: t(x.ts), soc: x.soe })),
    totals: await one(`SELECT ${kwhCols} FROM energy WHERE site_id = $1 AND day = $2`, [id, date]) });
}));

app.get('/api/daily', wrap(async (req, res) => {
  const id = site(req), days = Math.min(800, Number(req.query.days ?? 30)), from = addDays(localDay(), -days + 1);
  res.json(await q(`SELECT e.day date, ${kwhCols}, s.mn "socMin", s.mx "socMax" FROM energy e
    LEFT JOIN (SELECT day, MIN(soe)::float8 mn, MAX(soe)::float8 mx FROM soe WHERE site_id = $1 AND day >= $2 GROUP BY day) s ON s.day = e.day
    WHERE e.site_id = $1 AND e.day >= $2 GROUP BY e.day, s.mn, s.mx ORDER BY e.day`, [id, from]));
}));

app.get('/api/monthly', wrap(async (req, res) => {
  const months = Math.min(60, Number(req.query.months ?? 13));
  res.json((await q(`SELECT substr(day, 1, 7) AS month, COUNT(DISTINCT day)::int days, ${kwhCols} FROM energy WHERE site_id = $1 GROUP BY month ORDER BY month DESC LIMIT $2`, [site(req), months])).reverse());
}));

app.get('/api/profile', wrap(async (req, res) => {
  const days = Number(req.query.days ?? 14), to = localDay(), from = addDays(to, -days);
  res.json({ days, hours: await q(`SELECT hour::int, (SUM(home_wh) / 1000.0 / $4)::float8 home, (SUM(solar_wh) / 1000.0 / $4)::float8 solar
    FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY hour ORDER BY hour`, [site(req), from, to, days]) });
}));

app.get('/api/grid-days', wrap(async (req, res) => {
  const id = site(req), days = Math.min(90, Number(req.query.days ?? 30)), from = addDays(localDay(), -days + 1);
  const sol = await q(`SELECT day, hour::int, (SUM(solar_wh) / 1000.0)::float8 v FROM energy WHERE site_id = $1 AND day >= $2 GROUP BY day, hour`, [id, from]);
  const soc = await q(`SELECT day, hour::int, AVG(soe)::float8 v FROM soe WHERE site_id = $1 AND day >= $2 GROUP BY day, hour`, [id, from]);
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const grid = (rows: any[]) => { const m = new Map(rows.map(r => [`${r.day}|${r.hour}`, r2(r.v)])); return dates.map(d => Array.from({ length: 24 }, (_, h) => m.get(`${d}|${h}`) ?? null)); };
  res.json({ dates, solar: grid(sol), soc: grid(soc) });
}));

app.get('/api/overnight', wrap(async (req, res) => {
  const from = addDays(localDay(), -Number(req.query.days ?? 60));
  res.json(await q(`SELECT day date, ROUND((SUM(home_wh) / 1000.0 / 4)::numeric, 3)::float8 kw FROM energy WHERE site_id = $1 AND day >= $2 AND hour BETWEEN 1 AND 4 GROUP BY day ORDER BY day`, [site(req), from]));
}));

app.get('/api/records', wrap(async (req, res) => {
  const id = site(req);
  const day = (order: string, col: string) => one(`SELECT day date, ROUND((SUM(${col}) / 1000.0)::numeric, 1)::float8 kwh FROM energy WHERE site_id = $1 GROUP BY day ORDER BY kwh ${order} LIMIT 1`, [id]);
  const [best, big, low, totals, full, soeDays, longest, outages] = await Promise.all([day('DESC', 'solar_wh'), day('DESC', 'home_wh'), day('ASC', 'import_wh'),
    one(`SELECT MIN(day) since, ${kwhCols} FROM energy WHERE site_id = $1`, [id]),
    one<{ n: number }>(`SELECT COUNT(*)::int n FROM (SELECT day FROM soe WHERE site_id = $1 GROUP BY day HAVING MAX(soe) >= 99) x`, [id]),
    one<{ n: number }>(`SELECT COUNT(DISTINCT day)::int n FROM soe WHERE site_id = $1`, [id]),
    one('SELECT ts, duration_s FROM backup_events WHERE site_id = $1 ORDER BY duration_s DESC LIMIT 1', [id]),
    one<{ n: number }>('SELECT COUNT(*)::int n FROM backup_events WHERE site_id = $1', [id])]);
  res.json({ bestSolarDay: best, biggestUsageDay: big, lowestImportDay: low, totals, batteryFullDays: { days: full?.n ?? 0, of: soeDays?.n ?? 0 }, longestOutage: longest ?? null, outages: outages?.n ?? 0 });
}));

app.get('/api/outages', wrap(async (req, res) => res.json(await q('SELECT ts, duration_s FROM backup_events WHERE site_id = $1 ORDER BY epoch DESC', [site(req)]))));
app.get('/api/site', wrap(async (req, res) => { const info = await siteInfo(site(req)); res.json({ summary: summary(info), raw: info ?? null }); }));

/* ---------- bills ---------- */
app.get('/api/bills', wrap(async (req, res) => res.json(await listBills(site(req)))));
app.get('/api/reconcile', wrap(async (req, res) => res.json(await reconcile(site(req)))));
app.post('/api/bills/parse', express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '15mb' }), wrap(async (req, res) => {
  try { res.json(await parsePecPdf(new Uint8Array(req.body as Buffer))); } catch (e) { res.status(422).json({ error: (e as Error).message }); }
}));
app.post('/api/bills', express.json({ limit: '1mb' }), wrap(async (req, res) => {
  const b = req.body as Partial<Bill>;
  if (!b.billDate || !b.period?.from || !b.period?.to || b.deliveredKwh == null || b.total == null) return res.status(400).json({ error: 'billDate, period, deliveredKwh and total are required' });
  const fallback = (await listBills(site(req))).at(-1)?.tariff;
  await saveBill(site(req), { utility: 'PEC', dueDate: null, receivedKwh: 0, charges: [], ...b,
    tariff: b.tariff ?? fallback ?? { importRate: .102346, importRateAllIn: .1064, exportCredit: .071921, fixedMonthly: 32.5, discounts: -2.5, franchisePct: .0396 } } as Bill);
  res.json({ saved: b.billDate });
}));
app.delete('/api/bills/:date', wrap(async (req, res) => { await q('DELETE FROM bills WHERE site_id = $1 AND bill_date = $2', [site(req), req.params.date]); res.json({ deleted: req.params.date }); }));

/* ---------- user-logged events (panel cleanings…) with undo ---------- */
app.get('/api/events', wrap(async (req, res) => res.json(await q('SELECT id, type, day, note, created_at FROM events WHERE site_id = $1 ORDER BY day DESC, id DESC', [site(req)]))));
app.post('/api/events', express.json(), wrap(async (req, res) => {
  const { type, day, note } = req.body ?? {};
  if (!['cleaned', 'note'].includes(type) || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) return res.status(400).json({ error: 'type and day required' });
  res.json(await one('INSERT INTO events (site_id, type, day, note) VALUES ($1, $2, $3, $4) RETURNING id, type, day, note', [site(req), type, day, note ?? null]));
}));
app.delete('/api/events/:id', wrap(async (req, res) => { await q('DELETE FROM events WHERE site_id = $1 AND id = $2', [site(req), Number(req.params.id)]); res.json({ ok: true }); }));

/* ---------- ERCOT grid conditions (their CORS blocks browsers) ---------- */
app.get('/api/ercot', wrap(async (_req, res) => {
  const cached = await kv.get<{ at: number; data: unknown }>('ercot');
  if (cached && Date.now() - cached.at < 5 * 60_000) return res.json(cached.data);
  const [prc, sd] = await Promise.all(['daily-prc', 'supply-demand'].map(n => fetch(`https://www.ercot.com/api/1/services/read/dashboards/${n}.json`).then(r => r.json()))) as [any, any];
  const latest = (sd.data as any[]).filter(x => x.demand > 0).at(-1);
  const data = { condition: prc.current_condition?.state ?? null, title: prc.current_condition?.title ?? null, note: prc.current_condition?.condition_note ?? null,
    eea: prc.current_condition?.eea_level ?? 0, demandMw: latest?.demand ?? null, capacityMw: latest?.capacity ?? null, at: sd.lastUpdated };
  await kv.set('ercot', { at: Date.now(), data });
  res.json(data);
}));

/* ---------- what-if: replay the last 12 months (hourly) with a different system ---------- */
app.get('/api/whatif', wrap(async (req, res) => {
  const id = site(req), addPanels = Number(req.query.panels ?? 0), addPw = Number(req.query.powerwalls ?? 0), extra = Number(req.query.extra ?? 0), panelW = Number(req.query.panelW ?? 400);
  const to = localDay(), from = addDays(to, -365);
  const rows = await q<{ day: string; hour: number; s: number; h: number }>(`SELECT day, hour::int, (SUM(solar_wh) / 1000.0)::float8 s, (SUM(home_wh) / 1000.0)::float8 h
    FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY day, hour ORDER BY day, hour`, [id, from, to]);
  const peak = await one<{ p: number }>(`SELECT (MAX(solar_wh) * 12 / 1000.0)::float8 p FROM energy WHERE site_id = $1 AND day >= $2`, [id, from]);
  const tariff = (await listBills(id)).at(-1)?.tariff ?? { importRateAllIn: .1064, exportCredit: .0719 } as Bill['tariff'];
  const info = summary(await siteInfo(id)), cap0 = info.capacityKwh || 27, pw0 = info.batteryCount || 2, reserve = (info.reservePct ?? 20) / 100;
  const kwpNow = Math.round((peak?.p ?? 9) / .85 * 10) / 10, scale = 1 + addPanels * panelW / 1000 / kwpNow;
  function replay(solarScale: number, cap: number, maxKw: number) {
    let soc = .5, imp = 0, exp = 0, solar = 0, home = 0; const full = new Set<string>();
    for (const r of rows) {
      const s = r.s * solarScale, h = r.h + (r.hour >= 17 && r.hour < 23 ? extra / 6 : 0);
      let net = s - h;
      if (net > 0) { const c = Math.min(net, maxKw, (1 - soc) * cap / .95); soc += c * .95 / cap; net -= c; if (soc > .995) full.add(r.day); exp += net; }
      else { const d = Math.min(-net, maxKw, Math.max(0, soc - reserve) * cap * .95); soc -= d / .95 / cap; imp += -net - d; }
      solar += s; home += h;
    }
    return { importKwh: Math.round(imp), exportKwh: Math.round(exp), solarKwh: Math.round(solar), homeKwh: Math.round(home), selfPowered: home ? Math.round((1 - imp / home) * 100) : 0,
      batteryFullDays: full.size, netCost: Math.round(imp * tariff.importRateAllIn - exp * (tariff.exportCredit ?? 0)) };
  }
  const baseline = replay(1, cap0, pw0 * 5), upgraded = replay(scale, cap0 + addPw * 13.5, pw0 * 5 + addPw * 11.5);
  const actual = await one(`SELECT ROUND((SUM(import_wh) / 1000.0)::numeric)::float8 "importKwh", ROUND((SUM(export_wh) / 1000.0)::numeric)::float8 "exportKwh" FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3`, [id, from, to]);
  const cost = addPanels * panelW * 2.75 + addPw * 11500, saves = baseline.netCost - upgraded.netCost;
  res.json({ days: new Set(rows.map(r => r.day)).size, kwpNow, panels: 30, assumptions: { panelW, dollarsPerW: 2.75, powerwallCost: 11500, tariff },
    actual, baseline, upgraded, cost, savesPerYear: saves, paybackYears: saves > 0 && cost ? Math.round(cost / saves * 10) / 10 : null,
    backupHoursEvening: { now: Math.round(cap0 * .8 / 4.5), upgraded: Math.round((cap0 + addPw * 13.5) * .8 / 4.5) } });
}));

/* ---------- CSV export ---------- */
app.get('/api/export.csv', wrap(async (req, res) => {
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="solstice-${localDay()}.csv"` });
  res.write('timestamp,solar_wh,home_wh,import_wh,export_wh,battery_charge_wh,battery_discharge_wh\n');
  const rows = await q('SELECT ts, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh FROM energy WHERE site_id = $1 ORDER BY epoch', [site(req)]);
  for (const r of rows) res.write(`${r.ts},${r.solar_wh},${r.home_wh},${r.import_wh},${r.export_wh},${r.charge_wh},${r.discharge_wh}\n`);
  res.end();
}));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});
