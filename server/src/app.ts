// The Solstice HTTP API. Runs as a single Vercel function in production (api/index.ts) and via server/src/index.ts locally.
import express, { type Request, type Response, type NextFunction } from 'express';
import { q, one, kv, migrate } from './db.js';
import { config } from './config.js';
import { hashPassword, verifyPassword, startSession, endSession, currentUser, requireUser, requireSite, tooManyAttempts, recordAttempt, signState, verifyState, multiUser,
  ownerKey, checkOwnerKey, startOwnerSession, endOwnerSession, endOtherOwnerSessions, listOwnerSessions, ownerAttemptLimited, guestAttempts, clientIp,
  signOwnerState, consumeOwnerState, setCookie, readCookie } from './auth.js';
import { gate, presenceHidden, setPreview, PREVIEW_COOKIE } from './access.js';
import { createShare, listShares, revokeShare, revokeAllShares, redeemShare, pruneShares, guestMaxAge, EXPIRY, DEFAULT_EXPIRY, LABEL_MAX, GUEST_COOKIE } from './share.js';
import { authorizeUrl, exchangeCode } from './tesla/auth.js';
import { teslaFor, localDay, addDays } from './tesla/client.js';
import { refreshLive, refreshSiteInfo, syncSite } from './sync.js';
import { listBills, parsePecPdf, saveBill, type Bill } from './bills.js';
import { reconcile } from './reconcile.js';
import { SOLAR, warrantedDcPct, systemYear } from './system.js';
import { siteLocation, exactLocation } from './site.js';
import { currentTariff, netEnergyCost, NO_TARIFF } from './tariff.js';
import { appliances, comingSoon } from './appliances/index.js';
import { poolDetail, applyPlan, restorePrevious } from './appliances/pool.js';
import { readPool } from './appliances/screenlogic.js';
import { acDetail, acTick } from './appliances/ac.js';
import { cronTick } from './appliances/sampling.js';
import { nestAuthorizeUrl, nestExchangeCode, nestConfigured, readNest } from './appliances/nest.js';
import { pvsRouter } from './pvs.js';
import { flowsFor, FlowsInputError } from './flows.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
// Nothing this app serves may be cached by a browser, proxy or CDN, or reused for a request with other cookies (owner, guest).
app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.vary('Cookie'); next(); });
app.use(async (_req, _res, next) => { try { await migrate(); next(); } catch (e) { next(e); } });

/* The gate (access.ts): the owner cookie opens every /api and /auth route, reads included; a guest share-link cookie opens
 * only the allow-listed reads, each through its redaction view (redact.ts); anonymous gets OPEN_ROUTES only (the two unlocks,
 * /api/auth/me, the bearer-protected crons and the state-verified OAuth callbacks). */
if (!ownerKey()) console.warn('[solstice] OWNER_KEY is not set (or is shorter than 32 characters). Failing closed: every /api and /auth route except /api/auth/me, the crons and the OAuth callbacks answers 401. Set OWNER_KEY in .env / Vercel env, then open /#owner=<key> once per device.');
app.use('/api', gate);
app.use('/auth', gate);

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const K = (col: string) => `ROUND((SUM(${col}) / 1000.0)::numeric, 2)::float8`;
const kwhCols = `${K('solar_wh')} solar, ${K('home_wh')} home, ${K('import_wh')} import, ${K('export_wh')} export, ${K('charge_wh')} charge, ${K('discharge_wh')} discharge`;
const r2 = (v: number) => Math.round(v * 100) / 100;
const site = (req: Request) => req.siteId!;

/* ======================= accounts ======================= */
app.get('/api/auth/me', wrap(async (req, res) => {
  if (!multiUser()) { // single-owner mode: no accounts; a non-owner learns the mode and nothing else
    // A guest (or the owner previewing as one) learns that it is a guest; never the link's private label.
    if (req.guestView) return res.json({ mode: 'single', owner: false, guest: true, label: null, ...(req.preview ? { preview: true } : {}) });
    if (req.role !== 'owner') {
      const reason = req.guestShareLookup?.state;   // a guest cookie whose link was revoked or has expired
      return res.json({ mode: 'single', owner: false, ...(reason === 'revoked' || reason === 'expired' ? { reason } : {}) });
    }
    const s = await one<{ id: string; name: string }>('SELECT id, name FROM sites WHERE tesla_account_id IS NOT NULL ORDER BY created_at LIMIT 1');
    return res.json({ mode: 'single', owner: true, user: null, site: s ?? null });
  }
  const user = await currentUser(req);
  const users = Number((await one<{ n: string }>('SELECT COUNT(*) n FROM users'))!.n);
  if (!user) return res.json({ user: null, needsSetup: users === 0, signupsOpen: process.env.ALLOW_SIGNUPS === 'true' });
  const s = await one<{ id: string; name: string }>('SELECT id, name FROM sites WHERE user_id = $1 ORDER BY created_at LIMIT 1', [user.id]);
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role }, site: s ?? null, needsSetup: false });
}));

/* ---------- owner identity (single-owner mode): OWNER_KEY → an owner_sessions row + the solstice_owner cookie ---------- */
const FAIL_MS = 500; // every failed unlock answers after the same delay, so response time says nothing about the key
app.post('/api/auth/owner', express.text({ type: () => true, limit: '4kb' }), wrap(async (req, res) => {
  const t0 = Date.now();
  const fail = async (status: number, error: string) => { await new Promise(r => setTimeout(r, Math.max(0, t0 + FAIL_MS - Date.now()))); res.status(status).json({ error }); };
  if (!ownerKey()) return fail(503, 'owner_key_not_configured');
  if (ownerAttemptLimited(clientIp(req))) return fail(429, 'too_many_attempts');
  let key = ''; try { key = String(JSON.parse(String(req.body || '{}'))?.key ?? ''); } catch { /* a malformed body is a wrong key */ }
  if (!checkOwnerKey(key)) return fail(401, 'invalid_owner_key');
  await startOwnerSession(req, res);
  if (readCookie(req, PREVIEW_COOKIE)) setPreview(res, false);   // opening the owner link always brings back the owner's own view
  res.json({ ok: true });
}));
/** Sign this device out; sign every other device out; list the owner's devices (for the later devices sheet). Owner-only. */
app.post('/api/auth/signout', wrap(async (req, res) => { await endOwnerSession(req, res); res.json({ ok: true }); }));
app.post('/api/auth/signout-others', wrap(async (req, res) => res.json({ ok: true, signedOut: await endOtherOwnerSessions(req) })));
app.get('/api/auth/devices', wrap(async (req, res) => res.json(await listOwnerSessions(req))));

/* ---------- guest share links (share.ts): the owner creates, lists and revokes; anyone may open one ---------- */
/** Trade a share token (from the #s=<token> fragment) for the solstice_guest cookie, which lives until the link expires. */
app.post('/api/auth/guest', express.text({ type: () => true, limit: '4kb' }), wrap(async (req, res) => {
  const ip = clientIp(req);
  if (guestAttempts.limited(ip)) return res.status(429).json({ error: 'too_many_attempts' });
  let token = ''; try { token = String(JSON.parse(String(req.body || '{}'))?.token ?? ''); } catch { /* a malformed body is an unknown link */ }
  const r = await redeemShare(token.trim(), String(req.headers['user-agent'] ?? ''));
  if (!r.ok) { guestAttempts.failed(ip); return res.status(401).json({ error: 'invalid_share', reason: r.reason }); }
  setCookie(res, GUEST_COOKIE, token.trim(), guestMaxAge(r.expiresAt));
  res.json({ ok: true, guest: true, expiresAt: r.expiresAt });
}));
/** Owner only: see the app exactly as a guest would (reads only) for the next hour, or stop. */
app.post('/api/auth/preview', express.json(), wrap(async (req, res) => {
  const on = req.body?.on;
  if (typeof on !== 'boolean') return res.status(400).json({ error: 'on must be true or false' });
  setPreview(res, on);
  res.json({ ok: true, preview: on });
}));
/** Owner only: a new link. The token is in this response and nowhere else; only its SHA-256 is stored. */
app.post('/api/share', express.json(), wrap(async (req, res) => {
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '', expiresIn = req.body?.expiresIn ?? DEFAULT_EXPIRY;
  if (!label || label.length > LABEL_MAX) return res.status(400).json({ error: `label is required (at most ${LABEL_MAX} characters)` });
  if (typeof expiresIn !== 'string' || !Object.hasOwn(EXPIRY, expiresIn)) return res.status(400).json({ error: `expiresIn must be one of ${Object.keys(EXPIRY).join(', ')}` });
  const s = await createShare(label, expiresIn), fragment = `#s=${s.token}`;
  res.json({ ...s, fragment, url: `${req.protocol}://${req.get('host')}/${fragment}` });
}));
app.get('/api/share', wrap(async (_req, res) => res.json(await listShares())));
app.post('/api/share/revoke-all', wrap(async (_req, res) => res.json({ ok: true, revoked: await revokeAllShares() })));
app.post('/api/share/:id/revoke', wrap(async (req, res) => {
  if (!(await revokeShare(String(req.params.id)))) return res.status(404).json({ error: 'no live link with that id' });
  res.json({ ok: true, id: req.params.id });
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
  if (!multiUser()) return res.redirect(authorizeUrl(signOwnerState('tesla', 10 * 60_000))); // owner-only route (requireOwner)
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
  else if (!(await consumeOwnerState(state ?? '', 'tesla'))) return res.redirect('/?tesla_error=Sign-in+expired.+Try+again.');
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
  for (const s of sites) out[s.id] = await syncSite(s.id, Math.floor(50_000 / sites.length), { nightly: true }).catch(e => ({ error: e.message }));
  await q(`DELETE FROM readings WHERE ts < $1`, [Date.now() - 3 * 864e5]); // live snapshots are short-lived; history lives in `energy`
  await pruneShares().catch(e => console.error('[solstice] pruning share links', e)); // revoked/expired links leave the owner's list after 30 days
  res.json(out);
}));

/* ---------- per-panel data from the SunPower PVS6 (server/src/pvs.ts; owner-only like every /api route, no Tesla site needed) ----------
 *  POST /api/pvs/readings (the LAN relay, scripts/pvs-relay.mjs) · GET /api/pvs/day?date=YYYY-MM-DD · GET /api/pvs/latest */
app.use('/api/pvs', pvsRouter);

/* ======================= everything below needs a signed-in user ======================= */
app.use('/api', requireUser);

const settingsFor = async (req: Request) => (req.user ? req.user.settings ?? {} : await kv.get<Record<string, any>>('settings:owner') ?? {}) as Record<string, any>;
app.get('/api/settings', wrap(async (req, res) => res.json({ ...await settingsFor(req), location: exactLocation() })));
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
    solar: { ...SOLAR, year: systemYear(), warrantedDcPct: warrantedDcPct(systemYear()) },
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

/** History "Where every kWh went": seven paths for a day or the 30 days ending on `date`, with pool/AC and "unaccounted" (flows.ts). */
app.get('/api/flows', wrap(async (req, res) => {
  try { res.json(await flowsFor(site(req), String(req.query.range ?? 'day'), req.query.date == null ? undefined : String(req.query.date), await settingsFor(req))); }
  catch (e) { if (e instanceof FlowsInputError) return res.status(400).json({ error: e.message }); throw e; }
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
  // saveBill stores only toStoredBill's fields, whatever else the body carries (the PEC account number, a file name…)
  await saveBill(site(req), { utility: 'PEC', dueDate: null, receivedKwh: 0, charges: [], ...b,
    tariff: b.tariff ?? null } as Bill);
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
  const tariff = await currentTariff(id); // null until a bill is parsed: kWh still replay, every cost is null
  const info = summary(await siteInfo(id)), cap0 = info.capacityKwh || 27, pw0 = info.batteryCount || 2, reserve = (info.reservePct ?? 20) / 100;
  // the as-built array is 30 × 320 W DC (9.6 kW); added panels scale real production by their share of that nameplate
  const kwpNow = SOLAR.dcKw, scale = 1 + addPanels * panelW / 1000 / kwpNow;
  function replay(solarScale: number, cap: number, maxKw: number) {
    let soc = .5, imp = 0, exp = 0, solar = 0, home = 0; const full = new Set<string>();
    for (const r of rows) {
      const s = r.s * solarScale, h = r.h + (r.hour >= 17 && r.hour < 23 ? extra / 6 : 0);
      let net = s - h;
      if (net > 0) { const c = cap ? Math.min(net, maxKw, (1 - soc) * cap / .95) : 0; if (cap) soc += c * .95 / cap; net -= c; if (soc > .995) full.add(r.day); exp += net; }
      else { const d = cap ? Math.min(-net, maxKw, Math.max(0, soc - reserve) * cap * .95) : 0; if (cap) soc -= d / .95 / cap; imp += -net - d; }
      solar += s; home += h;
    }
    return { importKwh: Math.round(imp), exportKwh: Math.round(exp), solarKwh: Math.round(solar), homeKwh: Math.round(home), selfPowered: home ? Math.round((1 - imp / home) * 100) : 0,
      batteryFullDays: full.size, netCost: netEnergyCost(tariff, imp, exp) };
  }
  const baseline = replay(1, cap0, pw0 * 5), upgraded = replay(scale, cap0 + addPw * 13.5, pw0 * 5 + addPw * 11.5), noSystem = replay(0, 0, 0);
  const actual = await one(`SELECT ROUND((SUM(import_wh) / 1000.0)::numeric)::float8 "importKwh", ROUND((SUM(export_wh) / 1000.0)::numeric)::float8 "exportKwh" FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3`, [id, from, to]);
  const cost = addPanels * panelW * 2.75 + addPw * 11500, saves = tariff ? baseline.netCost! - upgraded.netCost! : null;
  // what the existing system saves per year vs. having no solar and no batteries, and what it cost (owner settings, never in git)
  const sys = (await settingsFor(req)).system as { priceUsd?: number; taxCreditPct?: number; loanYears?: number; loanRatePct?: number } | undefined;
  const savesNow = tariff ? noSystem.netCost! - baseline.netCost! : null;
  let system = null;
  if (sys?.priceUsd) {
    const net = Math.round(sys.priceUsd * (1 - (sys.taxCreditPct ?? 0) / 100)), years = (Date.now() - Date.parse(SOLAR.installedOn)) / (365.25 * 864e5);
    const r = (sys.loanRatePct ?? 0) / 100 / 12, n = (sys.loanYears ?? 0) * 12;
    const payment = n && r ? Math.round(sys.priceUsd * r / (1 - (1 + r) ** -n)) : n ? Math.round(sys.priceUsd / n) : null;
    system = { priceUsd: sys.priceUsd, taxCreditPct: sys.taxCreditPct ?? 0, netUsd: net, loanYears: sys.loanYears ?? null, loanRatePct: sys.loanRatePct ?? null, monthlyPayment: payment,
      savesPerYear: savesNow, yearsSinceInstall: Math.round(years * 10) / 10, paybackYears: savesNow != null && savesNow > 0 ? Math.round(net / savesNow * 10) / 10 : null, installedOn: SOLAR.installedOn };
  }
  res.json({ days: new Set(rows.map(r => r.day)).size, kwpNow, acKw: SOLAR.acKw, panels: SOLAR.panels, panelWdc: SOLAR.panelWdc, assumptions: { panelW, dollarsPerW: 2.75, powerwallCost: 11500, tariff },
    actual, baseline, upgraded, noSystem, cost, savesPerYear: saves, paybackYears: saves != null && saves > 0 && cost ? Math.round(cost / saves * 10) / 10 : null, system, ...(tariff ? {} : { reason: NO_TARIFF }),
    backupHoursEvening: { now: Math.round(cap0 * .8 / 4.5), upgraded: Math.round((cap0 + addPw * 13.5) * .8 / 4.5) } });
}));

/* ---------- appliances: pool pump (ScreenLogic), AC next ---------- */
const rateFor = async (id: string) => (await currentTariff(id))?.importRateAllIn ?? null; // null: costs unknown until a bill is parsed
app.get('/api/appliances', wrap(async (req, res) => {
  const id = site(req), settings = presenceHidden(req, await settingsFor(req)), rate = await rateFor(id);
  const list = await Promise.all(appliances.filter(a => a.available()).map(a => a.summary(id, settings, rate).catch(e => ({ id: a.id, name: a.name, status: 'estimated' as const, watts: null, kwhPerDay: null, savesPerMonth: null, error: e.message }))));
  if (nestConfigured()) list.push(await acDetail(id, settings, rate, await acSlope(id)).then(d => ({ id: 'ac', name: 'AC', status: d.linked ? 'linked' as const : 'estimated' as const, watts: d.state?.hvac === 'COOLING' ? Math.round(d.learned.acKw * 1000) : 0, kwhPerDay: d.todayKwh, savesPerMonth: d.plan.costSavedMonth })).catch(e => ({ id: 'ac', name: 'AC', status: 'estimated' as const, watts: null, kwhPerDay: null, savesPerMonth: null, error: e.message })));
  res.json([...list, ...comingSoon()]);
}));
// ?fresh=1 forces a device read: the owner's only (a guest's reads come from the 60 s cache, whatever it asks)
app.get('/api/appliances/pool', wrap(async (req, res) => res.json(await poolDetail(site(req), await settingsFor(req), await rateFor(site(req)), { fresh: !req.guestView && req.query.fresh === '1' }))));
/** Writes the smarter schedule to ScreenLogic: replaces the pump programs' schedules and speeds, keeps everything else (lights, spa, freeze protection). */
app.post('/api/appliances/pool/apply', wrap(async (req, res) => {
  const id = site(req), d = await poolDetail(id, await settingsFor(req), await rateFor(id), { fresh: true });
  if (!d.snapshot) return res.status(409).json({ error: d.error ?? 'ScreenLogic is not linked' });
  res.json(await applyPlan(id, d.plan, d.snapshot, d.settings));
}));
app.post('/api/appliances/pool/apply-tomorrow', wrap(async (req, res) => {
  const id = site(req), d = await poolDetail(id, await settingsFor(req), await rateFor(id), { fresh: true });
  if (!d.snapshot) return res.status(409).json({ error: d.error ?? 'ScreenLogic is not linked' });
  if (!d.pending) return res.status(409).json({ error: 'Nothing is waiting to be applied' });
  const r = await applyPlan(id, d.pending.plan, d.snapshot, d.settings);
  await kv.set(`${id}:pool:pending`, null as any);
  res.json(r);
}));
app.post('/api/appliances/pool/autopilot', express.json(), wrap(async (req, res) => {
  const mode = String(req.body?.mode ?? ''); if (!['off', 'suggest', 'auto'].includes(mode)) return res.status(400).json({ error: 'mode must be off, suggest or auto' });
  const cur = (await settingsFor(req)).pool ?? {};
  if (req.user) await q('UPDATE users SET settings = settings || $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify({ pool: { ...cur, autopilot: mode } })]);
  else await kv.set('settings:owner', { ...(await kv.get<object>('settings:owner') ?? {}), pool: { ...cur, autopilot: mode } });
  res.json({ ok: true, mode });
}));
/** Nightly (8:15 PM Central): Autopilot re-plans tomorrow for every site; Auto mode writes it, Suggest stores it. */
app.get('/api/cron/pool', wrap(async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  const sites = await q<{ id: string }>('SELECT id FROM sites WHERE tesla_account_id IS NOT NULL'), out: Record<string, unknown> = {};
  for (const s of sites) { const settings = await kv.get<Record<string, any>>('settings:owner') ?? {}; out[s.id] = await poolDetail(s.id, settings, await rateFor(s.id), { fresh: true, act: true }).then(d => d.autopilot).catch(e => ({ error: e.message })); }
  res.json(out);
}));
app.post('/api/appliances/pool/restore', wrap(async (req, res) => { await restorePrevious(site(req), await readPool()); res.json({ ok: true }); }));

/* ---------- appliances: AC via Nest ---------- */
/** kWh per degree of daily high above 80°F, from the last 120 days: the heat model the app already shows on the Home panel. */
async function acSlope(id: string) {
  const cached = await kv.get<{ at: number; slope: number }>(`${id}:ac:slope`); if (cached && Date.now() - cached.at < 6 * 3600_000) return cached.slope;
  const rows = await q<{ day: string; kwh: number }>(`SELECT day, (SUM(home_wh) / 1000.0)::float8 kwh FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY day`, [id, addDays(localDay(), -120), localDay()]);
  let highs = await kv.get<{ at: number; byDay: Record<string, number> }>('wx:highs');
  if (!highs || Date.now() - highs.at > 12 * 3600_000) { // daily highs for the last 120 days from Open-Meteo's archive
    const loc = siteLocation(), w = loc && await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${addDays(localDay(), -120)}&end_date=${localDay()}&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=America%2FChicago`).then(r => r.json()).catch(() => null) as any;
    highs = { at: Date.now(), byDay: Object.fromEntries((w?.daily?.time ?? []).map((d: string, i: number) => [d, w.daily.temperature_2m_max[i]])) }; await kv.set('wx:highs', highs);
  }
  const pts = rows.map(r => ({ t: highs!.byDay[r.day], u: r.kwh })).filter(p => p.t != null && p.t >= 80 && p.u > 5);
  let slope = 2.5;
  if (pts.length >= 10) { const mx = pts.reduce((a, p) => a + p.t, 0) / pts.length, my = pts.reduce((a, p) => a + p.u, 0) / pts.length; slope = pts.reduce((a, p) => a + (p.t - mx) * (p.u - my), 0) / pts.reduce((a, p) => a + (p.t - mx) ** 2, 0); }
  await kv.set(`${id}:ac:slope`, { at: Date.now(), slope: Math.max(.5, Math.min(6, slope || 2.5)) });
  return Math.max(.5, Math.min(6, slope || 2.5));
}
app.get('/api/appliances/ac', wrap(async (req, res) => { const id = site(req); res.json(await acDetail(id, presenceHidden(req, await settingsFor(req)), await rateFor(id), await acSlope(id), { fresh: !req.guestView && req.query.fresh === '1' })); }));
/** Approve today's plan: the 5-minute cron then applies each setpoint step at its hour. */
app.post('/api/appliances/ac/apply', wrap(async (req, res) => { const id = site(req); await kv.set(`${id}:ac:plan`, { date: localDay(), approved: true, lastStepHour: null }); res.json(await acTick(id, await settingsFor(req), await rateFor(id), await acSlope(id))); }));
app.post('/api/appliances/ac/settings', express.json(), wrap(async (req, res) => {
  const cur = (await settingsFor(req)).ac ?? {}, patch = req.body ?? {}, next = { ...cur, ...patch, band: { ...(cur.band ?? {}), ...(patch.band ?? {}) } };
  if (patch.autopilot && !['off', 'suggest', 'auto'].includes(patch.autopilot)) return res.status(400).json({ error: 'bad mode' });
  if (patch.presence && !['home', 'away'].includes(patch.presence)) return res.status(400).json({ error: 'bad presence' });
  if (req.user) await q('UPDATE users SET settings = settings || $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify({ ac: next })]);
  else await kv.set('settings:owner', { ...(await kv.get<object>('settings:owner') ?? {}), ac: next });
  // marking away/home takes effect right away when the plan is approved or Autopilot is Auto
  const id = site(req); if (patch.presence) { const rec = await kv.get<any>(`${id}:ac:plan`); if (rec) { rec.lastStepHour = null; await kv.set(`${id}:ac:plan`, rec); } await acTick(id, await settingsFor(req), await rateFor(id), await acSlope(id)).catch(() => {}); }
  res.json({ ok: true, ac: next });
}));
/**
 * Fires every 5 minutes; sampling.ts decides what is due. Nest (with acTick: AC learning and due plan steps) every 5 minutes 10:00–22:00
 * in cooling season, every 15 minutes otherwise; a read-only pool read every 15 minutes of scheduled pump hours plus 02:00 and 05:00.
 * A tick with nothing due answers without touching the database.
 */
app.get('/api/cron/nest', wrap(async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  res.json(await cronTick(Date.now(), {
    sites: async () => (await q<{ id: string }>('SELECT id FROM sites WHERE tesla_account_id IS NOT NULL')).map(s => s.id),
    acTick: async id => acTick(id, await kv.get<Record<string, any>>('settings:owner') ?? {}, await rateFor(id), await acSlope(id)),
  }));
}));
/* ---------- Google (Nest) OAuth ---------- */
app.get('/auth/google', (req, res) => { if (!nestConfigured()) return res.status(503).send('Nest is not configured'); res.redirect(nestAuthorizeUrl(signOwnerState('nest', 60 * 60_000))); }); // owner-only; Google's permissions page can take a while
app.get('/auth/google/callback', wrap(async (req, res) => {
  if (!(await consumeOwnerState(String(req.query.state ?? ''), 'nest'))) return res.redirect('/?nest_error=bad+state');
  try { await nestExchangeCode(String(req.query.code)); await readNest(); res.redirect('/?nest=linked'); } catch (e: any) { console.error('nest link', e); res.redirect('/?nest_error=' + encodeURIComponent(e.message)); }
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
