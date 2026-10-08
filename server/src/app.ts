// The Solstice HTTP API. Runs as a single Vercel function in production (api/index.ts) and via server/src/index.ts locally.
import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { q, one, kv, migrate, hourWh } from './db.js';
import { config } from './config.js';
import { hashPassword, verifyPassword, startSession, endSession, currentUser, requireUser, requireSite, tooManyAttempts, recordAttempt, signState, verifyState, multiUser,
  ownerKey, checkOwnerKey, startOwnerSession, endOwnerSession, endOtherOwnerSessions, endOwnerSessionById, listOwnerSessions, ownerAttemptLimited, guestAttempts, clientIp,
  signOwnerState, consumeOwnerState, setCookie, readCookie, safeEqual } from './auth.js';
import { gate, presenceHidden, setPreview, PREVIEW_COOKIE } from './access.js';
import { createShare, listShares, revokeShare, revokeAllShares, redeemShare, pruneShares, guestMaxAge, EXPIRY, DEFAULT_EXPIRY, LABEL_MAX, GUEST_COOKIE } from './share.js';
import { authorizeUrl, exchangeCode, OtherSiteError } from './tesla/auth.js';
import { teslaFor, localDay, addDays } from './tesla/client.js';
import { refreshLive, refreshSiteInfo, syncSite, storedDays } from './sync.js';
import { recordsFor, refreshRecords } from './records.js';
import { deepTick, deepStatus, deepDue, notePass, DEEP_STOP_MS } from './deepBackfill.js';
import { listBills, parsePecPdf, saveBill, type Bill } from './bills.js';
import { reconcile } from './reconcile.js';
import { SOLAR, warrantedDcPct, systemYear, yearsSinceInstall } from './system.js';
import { siteLocation, exactLocation } from './site.js';
import { currentTariff, netEnergyCost, NO_TARIFF } from './tariff.js';
import { appliances, comingSoon } from './appliances/index.js';
import { powerModel, measuredPoints } from './appliances/pool.js';
import { poolDetail, applyPlan, restorePrevious, poolCommand, PoolUnavailable, goalPatchError, scheduleError, saveSchedule, rebaseline, POOL_DEFAULTS, activeClearUp, startClearUp, extendClearUp, endClearUp, finishClearUpIfDue, clearUpError, CLEARUP_DAYS_MAX } from './appliances/pool.js';
import { readPool, configured as poolConfigured } from './appliances/screenlogic.js';
import { learnAcKw, acKwFor } from './appliances/ac.js';
import { acDetail, acTick, startHold, resumeHold, holdToMorning, AC_DEFAULTS, acPatchError, patchedAc, suggestionPatch, dismissSuggestion, recordNest, observeHold } from './appliances/ac.js';
import { oidcError, eventOf, seenEvent, applyTraits, isSettingEvent, eventTime } from './appliances/nestEvents.js';
import { applianceDay } from './appliances/day.js';
import { cronTick } from './appliances/sampling.js';
import { nestAuthorizeUrl, nestExchangeCode, nestConfigured, readNest, ownerCommand, type NestState } from './appliances/nest.js';
import { GuardRefusal, explainRefusal, type ManualCommand, type PoolOwnerCommand } from './appliances/guards.js';
import { pvsRouter, prunePvs } from './pvs.js';
import { panelsDay, panelAlerts, panelWatch } from './panels.js';
import { flowsFor, FlowsInputError } from './flows.js';
import { overnightSplit, breakdownFor, alwaysOnWatch } from './breakdown.js';
import { loadsRoutes, loadsNightly } from './loads.js';
import { outageDetail } from './outage.js';

import { alertRoutes, notify } from './notify.js';
import { ercotNow, fiveMinuteWatch, nightlyWatch, cronSites, fiveMinuteSteps, nightlySteps } from './watch.js';
import { gridWatch, isDown } from './gridwatch.js';
import { poolChanges, dismissPoolSuggestion } from './appliances/poolLearn.js';
import { pruneOld } from './retention.js';
import { refreshCapacity, capacityOf, modelKwh, type Capacity } from './capacity.js';
import { homeForecast } from './learn/homeModel.js';
import { fc48Correction } from './learn/bias.js';
import { soilingFor, soilingNightly } from './soiling.js';
import { poolWater, addTest, deleteTest, testError, poolTestReminder } from './appliances/poolTests.js';
import { spareWatch, spareHistory } from './spare.js';
import { digestRoutes, maybeWeeklyDigest } from './digest.js';
import { presenceRoutes, setPresence } from './appliances/presence.js';
import { powerwallRoutes, powerwallTick, powerwallNightly } from './powerwall.js';
import { runLearn } from './learn/nightly.js';
import { changedFor, ChangedInputError } from './learn/changed.js';
import { stripCard, stripWatch } from './stripwatch.js';
import { learnRouter } from './learn/api.js';
import { vacationRoutes, vacationTick, finishTrip, tripHooks, departure } from './vacation/index.js';
import { leftOn, cloudyWater } from './vacation/pool.js';
import { liveTrip, patchTripData, tripDays, endedWithoutReport, lastEnded } from './vacation/trip.js';
import { freshTripAc, tripAcEnd } from './vacation/ac.js';
import { vacationWatch, heldSummary } from './vacation/watch.js';
import { tripReport, reportPush, estimateTrip } from './vacation/report.js';
import { tripPlanDay } from './appliances/autopilot.js';
import { confidenceMap } from './learn/confidence.js';
import { patchSettings, changedKeys, PREV_KEY } from './settings.js';
import { ledger, cronHealth, cronWatch, markOf } from './cronLedger.js';
import { INFLATED_WH } from './learn/rules.js';

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
    // A guest (or the owner previewing as one) learns that it is a guest; never the link's private label. It also gets the
    // name the owner chose to show on invites and its own link's expiry (null: never, or the owner's preview), for the
    // welcome card, the "Shared by" chip and the Settings "Shared with you" row.
    if (req.guestView) return res.json({ mode: 'single', owner: false, guest: true, label: null, ownerName: await inviteName(),
      expiresAt: req.guestShareLookup?.expiresAt ?? null, ...(req.preview ? { preview: true } : {}) });
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
/** Owner only: sign one other device out (the devices sheet), by the short id the list shows. This device signs out with /signout. */
app.post('/api/auth/devices/:id/signout', wrap(async (req, res) => {
  const r = await endOwnerSessionById(req, String(req.params.id));
  if (r === 'current') return res.status(400).json({ error: 'this_device' });
  if (!r) return res.status(404).json({ error: 'no such device' });
  res.json({ ok: true, id: req.params.id });
}));
/** Anyone: forget the share link on this device (the guest's "Leave"). Clears the guest cookie; the link itself stays live. */
app.post('/api/auth/leave', (_req, res) => { setCookie(res, GUEST_COOKIE, '', 0); res.json({ ok: true }); });

/** The name guests see on invites ("Name shown on invites", owner settings `ownerName`): trimmed, printable, at most 40 characters. */
async function inviteName() {
  const n = (await kv.get<Record<string, any>>('settings:owner'))?.ownerName;
  const clean = typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '';
  return clean || 'The owner';
}

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
  // fixed codes only: Tesla's own error text is never reflected into the page (main.js maps each code to a sentence)
  if (error) { console.warn(`[solstice] Tesla sign-in: ${error} ${error_description ?? ''}`); return res.redirect(`/?tesla_error=${error === 'access_denied' ? 'denied' : 'failed'}`); }
  const uid = verifyState(state ?? '');
  let ownerId: number | null = null;
  if (multiUser()) { const user = await currentUser(req); if (!uid || !user || user.id !== uid) return res.redirect('/?tesla_error=expired'); ownerId = user.id; }
  else if (!(await consumeOwnerState(state ?? '', 'tesla'))) return res.redirect('/?tesla_error=expired');
  // single owner, one site: a re-link must be the account that has the linked site, or nothing is saved (tesla/auth.ts)
  const linked = multiUser() ? [] : (await q<{ id: string }>('SELECT id FROM sites WHERE tesla_account_id IS NOT NULL')).map(s => s.id);
  let accountId: number;
  try { accountId = await exchangeCode(code, ownerId, { expectSites: linked }); }
  catch (e) { if (e instanceof OtherSiteError) { console.warn('[solstice] Tesla re-link refused: a different account'); return res.redirect('/?tesla_error=othersite'); } throw e; }
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
/** Vercel Cron's bearer, compared in constant time. */
const cronOk = (req: Request) => !!process.env.CRON_SECRET && safeEqual(String(req.headers.authorization ?? ''), `Bearer ${process.env.CRON_SECRET}`);
app.get('/api/cron/sync', wrap(async (req, res) => {
  if (!cronOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const sites = await q<{ id: string }>('SELECT id FROM sites WHERE tesla_account_id IS NOT NULL');
  const out: Record<string, unknown> = {};
  const t0 = Date.now(), L = ledger('sync', t0);   // B2-11: the run's ledger (kv cron:sync:last)
  // the sync gets 30 s, leaving the learning layer, the nightly alerts and the prune room inside Vercel's 60 s (it had 50 s)
  for (const s of sites) out[s.id] = await L.step('sync', () => syncSite(s.id, Math.floor(30_000 / sites.length), { nightly: true })).catch(e => ({ error: e.message }));
  await L.step('readings', () => q(`DELETE FROM readings WHERE ts < $1`, [Date.now() - 3 * 864e5])); // live snapshots are short-lived; history lives in `energy`
  await L.step('shares', () => pruneShares()).catch(e => console.error('[solstice] pruning share links', e)); // revoked/expired links leave the owner's list after 30 days
  for (const s of sites) out[`capacity:${s.id}`] = await L.step('capacity', () => refreshCapacity(s.id)).catch(e => ({ error: e.message }));   // capacity.ts: before the learning layer's forecast reads it
  out.pruned = await L.step('prune', () => pruneOld()).catch(e => { console.error('[solstice] pruning old rows', e); return { error: e.message }; });   // retention.ts: the tables that grew forever

  // learning layer (server/src/learn/nightly.ts): score yesterday's predictions, trims, anomalies, today's predictions; skips what won't fit by 55 s
  for (const s of sites) out[`learn:${s.id}`] = await L.step('learn', () => runLearn(s.id, { deadline: t0 + 55_000 })).catch(e => ({ error: e.message }));
  // the sync and learning core are done: mark it now, so a slow tail (alerts, trip report, prune) cut off at 60 s can't fire the
  // 5-minute watchdog (below), which alerts when this is more than 26 h old (code review C-06)
  await kv.set(SYNC_DONE_KEY, Date.now());
  // records.ts (Batch 7): History › Records' days through yesterday into kv, so GET /api/records reads kv and today only. Skipped
  // past 45 s (the first /api/records read then aggregates instead), so the watch steps below keep their time
  for (const s of sites) out[`records:${s.id}`] = Date.now() - t0 < RECORDS_BY_MS ? await L.step('records', () => refreshRecords(s.id).then(r => ({ through: r.through })))
    .catch(e => ({ error: e.message })) : (L.mark('records', 'skipped'), { skipped: 'out of time; the first read aggregates' });
  // watch.ts: bill due and the other nightly alert checks; a step with under 5 s left before the deadline is skipped and said so
  for (const s of sites) out[`watch:${s.id}`] = await nightlyWatch(s.id, Date.now(), { deadline: t0 + 55_000, onStep: (n, ms, r) => L.mark(`watch.${n}`, markOf(r, ms)) });
  // raw per-panel readings older than 90 days go, after the learning layer has written the day's per-panel figures (pvs.ts)
  const pvsTime = Date.now() - t0 < 55_000; if (!pvsTime) L.mark('pvsPrune', 'skipped');
  out.pvsPrune = pvsTime ? await L.step('pvsPrune', () => prunePvs()).catch(e => ({ error: e.message })) : { skipped: 'out of time; tomorrow night' };
  out.ms = Date.now() - t0;
  await L.finish();
  res.json(out);
}));

/* ---------- per-panel data from the SunPower PVS6 (server/src/pvs.ts; owner-only like every /api route, no Tesla site needed) ----------
 *  POST /api/pvs/readings and POST /api/pvs/heartbeat (the LAN relay, scripts/pvs-relay.mjs) · GET /api/pvs/day?date=YYYY-MM-DD · GET /api/pvs/latest */
// Per-panel health (panels.ts, mockup u-panels): GET /api/pvs/panels?date= by roof position only (guests get it through redact.ts);
// GET/POST /api/pvs/layout (owner-only) on the router. A panel silent through an hour of daylight, or the relay itself, is a `panel` push.
app.get('/api/pvs/panels', wrap(async (req, res) => {
  const date = req.query.date === undefined ? localDay() : String(req.query.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const body = await panelsDay(date);
  res.json(req.guestView ? body : { ...body, alerts: await panelAlerts(body.anomalies.map(a => a.kind)) });
}));
app.use('/api/pvs', pvsRouter);

/* ======================= everything below needs a signed-in user ======================= */
app.use('/api', requireUser);

const settingsFor = async (req: Request) => (req.user ? req.user.settings ?? {} : await kv.get<Record<string, any>>('settings:owner') ?? {}) as Record<string, any>;
app.get('/api/settings', wrap(async (req, res) => res.json({ ...await settingsFor(req), location: exactLocation() })));
/**
 * Why a PUT /api/settings body is unusable, or null. Only the app's own preferences pass (calm, ownerName, alerts) plus the
 * system figures for the payback card. Pool, AC and Powerwall settings have their own validated routes, so this one can never
 * flip an Autopilot or point a write at another circuit (security review M4).
 */
export function settingsPatchError(b: unknown): string | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'settings must be an object';
  const o = b as Record<string, unknown>, bad = Object.keys(o).filter(k => !['calm', 'ownerName', 'alerts', 'system'].includes(k));
  if (bad.length) return `not settable here: ${bad.join(', ').replace(/[^\w ,]/g, '')}`;
  if ('calm' in o && typeof o.calm !== 'boolean' && !(o.calm && typeof o.calm === 'object' && typeof (o.calm as any).enabled === 'boolean')) return 'calm must be true or false';
  if ('ownerName' in o && (typeof o.ownerName !== 'string' || o.ownerName.length > 200)) return 'ownerName must be text';   // cleaned to 40 printable characters on read (inviteName)
  if ('alerts' in o) { const a = o.alerts; if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).length > 30 || Object.values(a).some(v => typeof v !== 'boolean')) return 'alerts must be an object of on/off switches'; }
  if ('system' in o) {
    const sy = o.system, keys = ['priceUsd', 'taxCreditPct', 'loanYears', 'loanRatePct'];
    if (!sy || typeof sy !== 'object' || Array.isArray(sy) || Object.entries(sy).some(([k, v]) => !keys.includes(k) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e7)) return `system takes only ${keys.join(', ')}, as non-negative numbers`;
  }
  return null;
}
app.put('/api/settings', express.json({ limit: '8kb' }), wrap(async (req, res) => {
  const bad = settingsPatchError(req.body); if (bad) return res.status(400).json({ error: bad });
  if (req.user) await q('UPDATE users SET settings = settings || $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify(req.body)]);
  else { const { before } = await patchSettings([], req.body, { by: 'you' }); await kv.set(PREV_KEY, before); }   // B2-10: one atomic merge; one level of undo
  res.json({ ok: true });
}));

app.use('/api', requireSite);

function summary(info: any, cap: Capacity | null = null) {
  info ??= {};
  const nameplate = (info.nameplate_energy ?? 0) / 1000;
  return {
    name: info.site_name, installed: info.installation_date, utility: info.utility, firmware: info.version,
    batteryCount: info.battery_count, batteries: (info.components?.batteries ?? []).map((b: any) => ({ name: b.part_name, kwh: b.nameplate_energy / 1000, kw: b.nameplate_max_discharge_power / 1000 })),
    capacityKwh: nameplate, maxPowerKw: (info.nameplate_power ?? 0) / 1000,
    // mockup af: the kWh a full charge delivers, measured nightly (capacity.ts), and the capacity the battery models use (they take 95% on the way out)
    measuredKwh: cap?.measuredKwh ?? null, modelKwh: modelKwh(cap, nameplate),
    reservePct: info.backup_reserve_percent, mode: info.default_real_mode, stormWatch: info.user_settings?.storm_mode_enabled ?? null,
    solar: { ...SOLAR, year: systemYear(), warrantedDcPct: warrantedDcPct(systemYear()) },
  };
}
const siteInfo = async (id: string) => (await one<{ info: any }>('SELECT info FROM sites WHERE id = $1', [id]))?.info;

app.get('/api/now', wrap(async (req, res) => {
  const id = site(req);
  let liveError: string | null = null;
  // S-07: a guest's read (or the owner previewing as one) never calls Tesla; the owner's stale reads share one call (sync.ts `single`)
  if (!req.guestView) await refreshLive(id, undefined, { single: true }).catch(e => { liveError = e.message; });
  const r = await one('SELECT * FROM readings WHERE site_id = $1 ORDER BY ts DESC LIMIT 1', [id]);
  const down = (x: any) => !!x && isDown(x);   // a missing or empty grid status is unknown, not an outage
  let outage: { active: boolean; since?: number } = { active: false };
  if (down(r)) {
    const up = await one<{ ts: string }>(`SELECT ts FROM readings WHERE site_id = $1 AND grid_status = 'Active' AND island_status NOT LIKE '%off_grid%' ORDER BY ts DESC LIMIT 1`, [id]);
    const start = await one<{ ts: string }>('SELECT MIN(ts) ts FROM readings WHERE site_id = $1 AND ts > $2', [id, up?.ts ?? 0]);
    outage = { active: true, since: Number(start?.ts) };
  }
  const lastLive = await kv.get<number>(`${id}:lastLive`), lastHistory = await kv.get<number>(`${id}:lastHistory`);
  const errors = Object.fromEntries(await Promise.all(['siteInfo', 'lastHistory', 'lastBackups', 'live'].map(async k => [k, await kv.get(`${id}:error:${k}`) ?? null])));
  res.json({
    reading: r && { ts: Number(r.ts), solarKw: r.solar_w / 1000, homeKw: r.load_w / 1000, batteryKw: r.battery_w / 1000, gridKw: r.grid_w / 1000, soc: r.soc,
      gridStatus: r.grid_status, islandStatus: r.island_status, stormActive: !!r.storm_mode_active },
    today: await one(`SELECT ${kwhCols} FROM energy WHERE site_id = $1 AND day = $2`, [id, localDay()]),
    site: summary(await siteInfo(id), await capacityOf(id)), outage,
    health: { lastLive: lastLive ?? null, lastHistory: lastHistory ?? null, stale: !r || Date.now() - Number(r.ts) > 3 * 60_000, liveError, errors, crons: await cronHealth() },   // crons: B2-11 (owner only; redact.ts leaves it out)   // by the reading's own time (mockup x), not the fetch's
  });
}));

/** The app calls this on open and every few minutes: pulls today's history and backfills missing days within a time budget. */
app.post('/api/sync', wrap(async (req, res) => res.json(await syncSite(site(req), 8_000))));

app.get('/api/status', wrap(async (req, res) => {
  // daysDone: the distinct days of energy history, from the synced-day marks (sync.ts storedDays; Batch 7: no full energy scan)
  const id = site(req), daysDone = await storedDays(id);
  // deep: the back-fill to the install date (deepBackfill.ts, I-16); owner only: the guest view's allow-list (redact.ts) leaves it out
  res.json({ connected: true, siteId: id, lastLive: await kv.get(`${id}:lastLive`) ?? null, lastHistory: await kv.get(`${id}:lastHistory`) ?? null,
    backfill: { daysDone, deep: await deepStatus(id) } });
}));

app.get('/api/day', wrap(async (req, res) => {
  const id = site(req), date = String(req.query.date ?? localDay());
  const b = await q(`SELECT ts, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh FROM energy WHERE site_id = $1 AND day = $2 ORDER BY epoch`, [id, date]);
  const s = await q(`SELECT ts, soe FROM soe WHERE site_id = $1 AND day = $2 ORDER BY epoch`, [id, date]);
  const t = (ts: string) => +ts.slice(11, 13) + +ts.slice(14, 16) / 60;
  // B2-12 (b): the day's peaks leave out solar buckets above the inverter limit (Tesla's bucket inflation, not output)
  const ok = b.filter(x => !(x.solar_wh > INFLATED_WH));
  res.json({ date,
    buckets: b.map(x => ({ t: t(x.ts), solar: r2(x.solar_wh * 12 / 1000), home: r2(x.home_wh * 12 / 1000), grid: r2((x.import_wh - x.export_wh) * 12 / 1000), battery: r2((x.discharge_wh - x.charge_wh) * 12 / 1000) })),
    peaks: { solarKw: r2(Math.max(0, ...ok.map(x => x.solar_wh * 12 / 1000))), homeKw: r2(Math.max(0, ...b.map(x => x.home_wh * 12 / 1000))), inflated: b.length - ok.length },
    soe: s.map(x => ({ t: t(x.ts), soc: x.soe })),
    totals: await one(`SELECT ${kwhCols} FROM energy WHERE site_id = $1 AND day = $2`, [id, date]) });
}));

/** Insights › Home "Where your energy goes" (mockup y, breakdown.ts): kWh a day by part, today's big loads, the always-on trend. Owner-only. */
app.get('/api/breakdown', wrap(async (req, res) => {
  const range = String(req.query.range ?? 'week');
  if (!['today', 'week', 'month'].includes(range)) return res.status(400).json({ error: 'range must be today, week or month' });
  res.json(await breakdownFor(site(req), range as 'today' | 'week' | 'month', await settingsFor(req)));
}));
/** I-22 load signatures (loads.ts, mockup am frames 4–5): GET /api/loads (the clusters) and POST /api/loads/label. Owner-only (no guest view). */
loadsRoutes(app, site, wrap);
/** History "Where every kWh went": seven paths for a day or the 30 days ending on `date`, with pool/AC and "unaccounted" (flows.ts). */
app.get('/api/flows', wrap(async (req, res) => {
  try { res.json(await flowsFor(site(req), String(req.query.range ?? 'day'), req.query.date == null ? undefined : String(req.query.date), await settingsFor(req))); }
  catch (e) { if (e instanceof FlowsInputError) return res.status(400).json({ error: e.message }); throw e; }
}));

/** I-18 "What changed" (mockup am frames 1–3, 8; learn/changed.ts): a day or a week split against its baseline. A guest's is computed
 *  without trip awareness and goes through redact.ts's view. */
app.get('/api/changed', wrap(async (req, res) => {
  try { res.json(await changedFor(site(req), String(req.query.scope ?? 'day'), req.query.date == null ? undefined : String(req.query.date), { guest: !!req.guestView })); }
  catch (e) { if (e instanceof ChangedInputError) return res.status(400).json({ error: e.message }); throw e; }
}));

/** Mockup ad: days with spare solar and kWh sent to PEC by month, and whether there is spare solar now (owner only). */
app.get('/api/spare', wrap(async (req, res) => res.json(await spareHistory(site(req)))));
app.get('/api/daily', wrap(async (req, res) => {
  const id = site(req), days = Math.min(800, Number(req.query.days ?? 30)), from = addDays(localDay(), -days + 1);
  const rows = await q(`SELECT e.day date, ${kwhCols}, s.mn "socMin", s.mx "socMax" FROM energy e
    LEFT JOIN (SELECT day, MIN(soe)::float8 mn, MAX(soe)::float8 mx FROM soe WHERE site_id = $1 AND day >= $2 GROUP BY day) s ON s.day = e.day
    WHERE e.site_id = $1 AND e.day >= $2 GROUP BY e.day, s.mn, s.mx ORDER BY e.day`, [id, from]);
  // mockup ak: History marks trip days (owner only; the guest view keeps only its listed keys)
  const trips = req.guestView ? new Set<string>() : await tripDays(id, from, localDay());
  res.json(trips.size ? rows.map(r => trips.has(r.date) ? { ...r, trip: true } : r) : rows);
}));

app.get('/api/monthly', wrap(async (req, res) => {
  const months = Math.min(60, Math.max(1, Math.floor(Number(req.query.months ?? 13)) || 13));
  // bounded to the first day of the oldest month asked for (I-16: with history back to the install date, an unbounded GROUP BY read every row)
  const t = localDay(), back = +t.slice(0, 4) * 12 + +t.slice(5, 7) - 1 - (months - 1), since = `${Math.floor(back / 12)}-${String(back % 12 + 1).padStart(2, '0')}-01`;
  res.json((await q(`SELECT substr(day, 1, 7) AS month, COUNT(DISTINCT day)::int days, ${kwhCols} FROM energy WHERE site_id = $1 AND day >= $3 GROUP BY month ORDER BY month DESC LIMIT $2`, [site(req), months, since])).reverse());
}));

/** `days` as a whole number from 1 to `max`; anything unusable is `dflt` (S-07: a guest's ?days=100000 can't make a 270-year scan). */
const daysParam = (v: unknown, dflt: number, max: number) => { const n = Math.floor(Number(v ?? dflt)); return Number.isFinite(n) && n >= 1 ? Math.min(max, n) : dflt; };
export const PROFILE_DAYS_MAX = 60, OVERNIGHT_DAYS_MAX = 120;
app.get('/api/profile', wrap(async (req, res) => {
  const days = daysParam(req.query.days, 14, PROFILE_DAYS_MAX), to = localDay(), from = addDays(to, -days);
  const trips = [...await tripDays(site(req), from, to)].filter(d => d < to);   // mockup ak: home use is an at-home day's; solar keeps every day
  res.json({ days, hours: await q(`SELECT hour::int, (SUM(h) FILTER (WHERE NOT (day = ANY($5::text[]))) / 1000.0 / GREATEST(1, $4 - cardinality($5::text[])))::float8 home, (SUM(s) / 1000.0 / $4)::float8 solar
    FROM (SELECT day, hour, ${hourWh('home_wh')} h, ${hourWh('solar_wh')} s FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY day, hour) x GROUP BY hour ORDER BY hour`, [site(req), from, to, days, trips]),
    conf: await confidenceMap(site(req), ['fc48.solar', 'fc48.home', 'fc48.soc']),   // learning layer: trust in the 48-hour forecast built on this profile
    scale: (await homeForecast(site(req)).catch(() => null))?.scale ?? {},   // mockup ah: each day's total from its forecast high (learn/homeModel.ts)
    correction: await fc48Correction(site(req)) }); // B2-2: the 30-day bias per horizon band the 48-hour road divides out (learn/bias.ts)
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
  const from = addDays(localDay(), -daysParam(req.query.days, 60, OVERNIGHT_DAYS_MAX));
  res.json(await overnightSplit(site(req), from));   // breakdown.ts (mockup z): the 1–5 AM average with always-on, AC and pump
}));

/** History › Records (records.ts, Batch 7): the days through yesterday from the nightly's kv aggregate, today's added live. */
app.get('/api/records', wrap(async (req, res) => res.json(await recordsFor(site(req)))));

app.get('/api/outages', wrap(async (req, res) => res.json(await q('SELECT ts, duration_s FROM backup_events WHERE site_id = $1 ORDER BY epoch DESC', [site(req)]))));
/** Outage readiness (Insights → Home): backup hours, the load ladder, the island simulation, 12 months of outages, storm state. Read-only. */
app.get('/api/outage', wrap(async (req, res) => res.json(await outageDetail(site(req), await settingsFor(req)))));
app.get('/api/site', wrap(async (req, res) => { const info = await siteInfo(site(req)); res.json({ summary: summary(info, await capacityOf(site(req))), raw: info ?? null }); }));
app.get('/api/capacity', wrap(async (req, res) => res.json(await capacityOf(site(req)))));   // mockup af: the Powerwall capacity card (owner only)

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
  // 'cleaned': the panels (soiling.ts); 'filter_cleaned': the pool's D.E. filter (B2-6: the pump's clean-filter baseline restarts from it)
  if (!['cleaned', 'filter_cleaned', 'note'].includes(type) || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) return res.status(400).json({ error: 'type and day required' });
  res.json(await one('INSERT INTO events (site_id, type, day, note) VALUES ($1, $2, $3, $4) RETURNING id, type, day, note', [site(req), type, day, note ?? null]));
}));
app.delete('/api/events/:id', wrap(async (req, res) => { await q('DELETE FROM events WHERE site_id = $1 AND id = $2', [site(req), Number(req.params.id)]); res.json({ ok: true }); }));

app.get('/api/soiling', wrap(async (req, res) => res.json(await soilingFor(site(req)))));
/* ---------- the pool water log (mockup aj; appliances/poolTests.ts): owner only, nothing written to the controller ---------- */
app.get('/api/pool/water', wrap(async (req, res) => res.json(await poolWater(site(req)))));
app.post('/api/pool/tests', express.json({ limit: '2kb' }), wrap(async (req, res) => {
  const b = req.body ?? {}, bad = typeof b === 'object' && !Array.isArray(b) ? testError(b) : 'a test must be an object';
  if (bad) return res.status(400).json({ error: bad });
  await addTest(site(req), b); res.json(await poolWater(site(req)));
}));
app.delete('/api/pool/tests/:id', wrap(async (req, res) => { await deleteTest(site(req), Number(req.params.id)); res.json(await poolWater(site(req))); }));   // mockup ai: the Cleaning check card (owner only; the cached weather)

/* ---------- ERCOT grid conditions (their CORS blocks browsers) ---------- */
app.get('/api/ercot', wrap(async (_req, res) => res.json(await ercotNow())));   // watch.ts: the same 5-minute kv cache the alert watch reads

/* ---------- what-if: replay the last 12 months (hourly) with a different system ---------- */
/** S-07: what-if replays kept per Chicago day (the year it replays ends yesterday, so a day's answer can't change), at most this many queries. */
export const WHATIF_CACHE_MAX = 24;
type WhatifCache = { day: string; entries: Array<{ k: string; v: any }> };   // a list, oldest first (jsonb doesn't keep an object's key order)
const finiteOr = (v: unknown, d: number) => { const n = Number(v ?? d); return Number.isFinite(n) ? n : d; };
app.get('/api/whatif', wrap(async (req, res) => {
  const id = site(req), addPanels = finiteOr(req.query.panels, 0), addPw = finiteOr(req.query.powerwalls, 0), extra = finiteOr(req.query.extra, 0), panelW = finiteOr(req.query.panelW, 400);
  const to = localDay(), from = addDays(to, -365);
  const tariff = await currentTariff(id); // null until a bill is parsed: kWh still replay, every cost is null
  const info = summary(await siteInfo(id)), cap0 = info.capacityKwh || 27, pw0 = info.batteryCount || 2, reserve = (info.reservePct ?? 20) / 100;
  // the as-built array is 30 × 320 W DC (9.6 kW); added panels scale real production by their share of that nameplate
  const kwpNow = SOLAR.dcKw, scale = 1 + addPanels * panelW / 1000 / kwpNow;
  // the cache key: the normalized query plus everything else the replay reads (the tariff, the battery), so a new bill re-replays
  const ck = `${addPanels}|${addPw}|${extra}|${panelW}|${cap0}|${pw0}|${reserve}|${createHash('sha256').update(JSON.stringify(tariff)).digest('base64url').slice(0, 12)}`;
  const cacheKey = `${id}:whatif:cache`, cache = await kv.get<WhatifCache>(cacheKey), hit = cache?.day === to ? cache.entries.find(e => e.k === ck)?.v : undefined;
  const { days, actual, baseline, upgraded, noSystem } = hit ?? await (async () => {   // a miss: replay the year and keep the answer
    const rows = await q<{ day: string; hour: number; s: number; h: number }>(`SELECT day, hour::int, (SUM(solar_wh) / 1000.0)::float8 s, (SUM(home_wh) / 1000.0)::float8 h
      FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3 GROUP BY day, hour ORDER BY day, hour`, [id, from, to]);
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
    const out = { days: new Set(rows.map(r => r.day)).size, baseline: replay(1, cap0, pw0 * 5), upgraded: replay(scale, cap0 + addPw * 13.5, pw0 * 5 + addPw * 11.5), noSystem: replay(0, 0, 0),
      actual: await one(`SELECT ROUND((SUM(import_wh) / 1000.0)::numeric)::float8 "importKwh", ROUND((SUM(export_wh) / 1000.0)::numeric)::float8 "exportKwh" FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3`, [id, from, to]) };
    const kept = (cache?.day === to ? cache.entries : []).filter(e => e.k !== ck).slice(-(WHATIF_CACHE_MAX - 1));   // oldest out first
    await kv.set(cacheKey, { day: to, entries: [...kept, { k: ck, v: out }] } satisfies WhatifCache);
    return out;
  })();
  const cost = addPanels * panelW * 2.75 + addPw * 11500, saves = tariff ? baseline.netCost! - upgraded.netCost! : null;
  // what the existing system saves per year vs. having no solar and no batteries, and what it cost (owner settings, never in git)
  const sys = (await settingsFor(req)).system as { priceUsd?: number; taxCreditPct?: number; loanYears?: number; loanRatePct?: number } | undefined;
  const savesNow = tariff ? noSystem.netCost! - baseline.netCost! : null;
  let system = null;
  if (sys?.priceUsd) {
    const net = Math.round(sys.priceUsd * (1 - (sys.taxCreditPct ?? 0) / 100)), years = yearsSinceInstall();
    const r = (sys.loanRatePct ?? 0) / 100 / 12, n = (sys.loanYears ?? 0) * 12;
    const payment = n && r ? Math.round(sys.priceUsd * r / (1 - (1 + r) ** -n)) : n ? Math.round(sys.priceUsd / n) : null;
    system = { priceUsd: sys.priceUsd, taxCreditPct: sys.taxCreditPct ?? 0, netUsd: net, loanYears: sys.loanYears ?? null, loanRatePct: sys.loanRatePct ?? null, monthlyPayment: payment,
      savesPerYear: savesNow, yearsSinceInstall: years, paybackYears: savesNow != null && savesNow > 0 ? Math.round(net / savesNow * 10) / 10 : null, installedOn: SOLAR.installedOn };
  }
  res.json({ days, kwpNow, acKw: SOLAR.acKw, panels: SOLAR.panels, panelWdc: SOLAR.panelWdc, assumptions: { panelW, dollarsPerW: 2.75, powerwallCost: 11500, tariff },
    actual, baseline, upgraded, noSystem, cost, savesPerYear: saves, paybackYears: saves != null && saves > 0 && cost ? Math.round(cost / saves * 10) / 10 : null, system, ...(tariff ? {} : { reason: NO_TARIFF }),
    backupHoursEvening: { now: Math.round(cap0 * .8 / 4.5), upgraded: Math.round((cap0 + addPw * 13.5) * .8 / 4.5) } });
}));

/* ---------- appliances: pool pump (ScreenLogic), AC next ---------- */
const rateFor = async (id: string) => (await currentTariff(id))?.importRateAllIn ?? null; // null: costs unknown until a bill is parsed
app.get('/api/appliances', wrap(async (req, res) => {
  const id = site(req), settings = presenceHidden(req, await settingsFor(req)), rate = await rateFor(id);
  const list = await Promise.all(appliances.filter(a => a.available()).map(a => a.summary(id, settings, rate).catch(e => ({ id: a.id, name: a.name, status: 'estimated' as const, watts: null, kwhPerDay: null, savesPerMonth: null, error: e.message }))));
  if (nestConfigured()) list.push(await acDetail(id, settings, rate, await acSlope(id), { readOnly: !!req.guestView }).then(d => ({ id: 'ac', name: 'AC', status: d.linked ? 'linked' as const : 'estimated' as const, watts: d.state?.hvac === 'COOLING' ? Math.round(d.learned.acKw * 1000) : 0, kwhPerDay: d.todayKwh, savesPerMonth: null })).catch(e => ({ id: 'ac', name: 'AC', status: 'estimated' as const, watts: null, kwhPerDay: null, savesPerMonth: null, error: e.message })));
  res.json([...list, ...comingSoon()]);
}));
// ?fresh=1 forces a device read: the owner's only. S-07: a guest's read never reaches the controller (the stored snapshot, however
// old); the owner's stale reads share one read per minute (pool.ts single flight)
app.get('/api/appliances/pool', wrap(async (req, res) => res.json(await poolDetail(site(req), await settingsFor(req), await rateFor(site(req)), { fresh: !req.guestView && req.query.fresh === '1', readOnly: !!req.guestView }))));
/** Writes the smarter schedule to ScreenLogic: replaces the pump programs' schedules and speeds, keeps everything else (lights, spa, freeze protection). */
// S-14: like /schedule, neither apply route writes during a Clear-up (it owns the pump until it ends), checked before the controller is read
const CLEARUP_BUSY = 'A Clear-up is running; end it first';
app.post('/api/appliances/pool/apply', wrap(async (req, res) => {
  const id = site(req);
  if (await activeClearUp(id)) return res.status(409).json({ error: CLEARUP_BUSY });
  const d = await poolDetail(id, await settingsFor(req), await rateFor(id), { fresh: true });
  if (!d.snapshot) return res.status(409).json({ error: d.error ?? 'ScreenLogic is not linked' });
  res.json(await applyPlan(id, d.plan, d.snapshot, d.settings));
}));
app.post('/api/appliances/pool/apply-tomorrow', wrap(async (req, res) => {
  const id = site(req);
  if (await activeClearUp(id)) return res.status(409).json({ error: CLEARUP_BUSY });
  // S-14: only the plan made for tomorrow (Chicago) may be applied; one left from an earlier evening is stale (its weather, its water)
  const waiting = await kv.get<{ date?: string } | null>(`${id}:pool:pending`);
  if (!waiting) return res.status(409).json({ error: 'Nothing is waiting to be applied' });
  if (waiting.date !== addDays(localDay(), 1)) return res.status(409).json({ error: 'That suggestion was for another day; tonight\u2019s plan replaces it' });
  const d = await poolDetail(id, await settingsFor(req), await rateFor(id), { fresh: true });
  if (!d.snapshot) return res.status(409).json({ error: d.error ?? 'ScreenLogic is not linked' });
  if (!d.pending || d.pending.date !== waiting.date) return res.status(409).json({ error: 'Nothing is waiting to be applied' });
  const r = await applyPlan(id, d.pending.plan, d.snapshot, d.settings);
  await kv.set(`${id}:pool:pending`, null as any);
  res.json(r);
}));
/** The owner's own pool commands (mockup w): {kind:'circuit', id, on, minutes}, {kind:'speed', id, rpm} or {kind:'spaHeat', on, setF}; answers the fresh Pool card. */
app.post('/api/appliances/pool/command', express.json({ limit: '1kb' }), wrap(async (req, res) => {
  const b = req.body ?? {}, kind = String(b.kind ?? ''), id = Number(b.id);
  const cmd = kind === 'circuit' ? { kind, id, on: b.on === true ? true : b.on === false ? false : (null as any), minutes: b.minutes == null ? undefined : Number(b.minutes) }
    : kind === 'speed' ? { kind, id, rpm: Number(b.rpm) }
    : kind === 'spaHeat' ? { kind, on: b.on === true ? true : b.on === false ? false : (null as any), setF: b.setF == null ? undefined : Number(b.setF) } : null;
  if (!cmd) return res.status(400).json({ error: 'unknown pool command' });
  const sid = site(req);
  try { await poolCommand(sid, cmd as PoolOwnerCommand); }
  catch (e) { if (e instanceof GuardRefusal) return res.status(400).json({ error: e.reason }); if (e instanceof PoolUnavailable) return res.status(503).json({ error: e.message }); throw e; }
  res.json(await poolDetail(sid, await settingsFor(req), await rateFor(sid)));
}));
/** Mockup ae: a pool suggestion. {action:'accept'|'dismiss', key:'skim:16'|'goal:3.5'}; accepting writes only Solstice's settings. */
app.post('/api/appliances/pool/suggestion', express.json({ limit: '1kb' }), wrap(async (req, res) => {
  const sid = site(req), action = String(req.body?.action ?? ''), key = String(req.body?.key ?? ''), m = /^(skim|goal):(\d{1,2}(?:\.5)?)$/.exec(key);
  if (!m || !['accept', 'dismiss'].includes(action)) return res.status(400).json({ error: 'action must be accept or dismiss, with a skim or goal key' });
  const settings = await settingsFor(req), cur = { ...POOL_DEFAULTS, ...(settings.pool ?? {}) }, live = await poolChanges(sid, { goal: cur.turnoverGoal, skimAt: cur.skimAt });
  if (!live.suggestions.some(s => s.key === key)) return res.status(409).json({ error: 'That suggestion is no longer open' });
  if (action === 'dismiss') await dismissPoolSuggestion(sid, key);
  else {
    const patch = m[1] === 'skim' ? { skimAt: Number(m[2]) } : { turnoverGoal: Number(m[2]) }, bad = m[1] === 'goal' ? goalPatchError(patch) : null; if (bad) return res.status(400).json({ error: bad });
    await patchSettings(['pool'], patch, { merge: true, by: 'you' });   // B2-10: only the accepted key
  }
  res.json(await poolDetail(sid, await settingsFor(req), await rateFor(sid)));
}));
/** Frame 7: save the Pool and High Speed runs ({schedules:[{circuitId,start,stop}], speeds?:[{circuitId,rpm}]}); answers the fresh Pool card. */
app.post('/api/appliances/pool/schedule', express.json({ limit: '4kb' }), wrap(async (req, res) => {
  const sid = site(req), settings = await settingsFor(req), rate = await rateFor(sid), bad = scheduleError(req.body, { ...POOL_DEFAULTS, ...(settings.pool ?? {}) });
  if (bad) return res.status(400).json({ error: bad });
  if (await activeClearUp(sid)) return res.status(409).json({ error: 'A Clear-up is running; end it first' });
  try { await saveSchedule(sid, req.body, settings); }
  catch (e) { if (e instanceof GuardRefusal) return res.status(400).json({ error: e.reason }); throw e; }
  res.json(await poolDetail(sid, await settingsFor(req), rate));
}));
/** Frame 6: Clear-up. {action:'start', days, rpm}, {action:'extend'} or {action:'end'}; answers the fresh Pool card. */
app.post('/api/appliances/pool/clearup', express.json({ limit: '1kb' }), wrap(async (req, res) => {
  const b = req.body ?? {}, sid = site(req), settings = await settingsFor(req), rate = await rateFor(sid);
  try {
    if (b.action === 'start') { const bad = clearUpError(b); if (bad) return res.status(400).json({ error: bad }); if (await activeClearUp(sid)) return res.status(409).json({ error: 'A Clear-up is already running' }); await startClearUp(sid, { days: b.days, rpm: b.rpm }, settings); }
    else if (b.action === 'extend') { const c = await activeClearUp(sid); if (!c) return res.status(409).json({ error: 'No Clear-up is running' }); if (c.days >= CLEARUP_DAYS_MAX + 2) return res.status(400).json({ error: 'That is long enough; end it and start a new one if the water needs more' }); await extendClearUp(sid); }
    else if (b.action === 'end') { if (!(await activeClearUp(sid))) return res.status(409).json({ error: 'No Clear-up is running' }); await endClearUp(sid, settings, rate, 'you'); }
    else return res.status(400).json({ error: 'action must be start, extend or end' });
  } catch (e) { if (e instanceof GuardRefusal) return res.status(400).json({ error: e.reason }); throw e; }
  res.json(await poolDetail(sid, settings, rate));
}));
/** Frame 5's goal: turnovers a day and the daily skim hours. Saved with the owner's pool settings; the next plan uses them. */
app.post('/api/appliances/pool/goal', express.json({ limit: '1kb' }), wrap(async (req, res) => {
  const bad = goalPatchError(req.body); if (bad) return res.status(400).json({ error: bad });
  const patch = Object.fromEntries(['turnoverGoal', 'skimHours'].filter(k => k in req.body).map(k => [k, req.body[k]]));
  const cur = (await settingsFor(req)).pool ?? {};
  if (req.user) await q('UPDATE users SET settings = settings || $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify({ pool: { ...cur, ...patch } })]);
  else await patchSettings(['pool'], patch, { merge: true, by: 'you' });   // B2-10: only the goal's keys
  const sid = site(req);
  res.json(await poolDetail(sid, await settingsFor(req), await rateFor(sid)));
}));
app.post('/api/appliances/pool/autopilot', express.json(), wrap(async (req, res) => {
  const mode = String(req.body?.mode ?? ''); if (!['off', 'suggest', 'auto'].includes(mode)) return res.status(400).json({ error: 'mode must be off, suggest or auto' });
  const cur = (await settingsFor(req)).pool ?? {};
  if (req.user) await q('UPDATE users SET settings = settings || $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify({ pool: { ...cur, autopilot: mode } })]);
  else await patchSettings(['pool', 'autopilot'], mode, { by: 'you' });   // B2-10: atomic, and logged in settings:changes
  // choosing Auto means "plan over what runs now": the controller's programs become the baseline, so they are not taken for an outside edit
  const snap = mode === 'auto' ? await kv.get<any>(`${site(req)}:pool:last`) : null;
  if (snap?.schedules) await rebaseline(site(req), snap, { ...POOL_DEFAULTS, ...cur }, 'auto');
  res.json({ ok: true, mode });
}));
/** Nightly at 01:15 UTC (8:15 PM CDT, 7:15 PM CST): Autopilot re-plans tomorrow for every site; Auto mode writes it, Suggest stores it. */
app.get('/api/cron/pool', wrap(async (req, res) => {
  if (!cronOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const sites = await q<{ id: string }>('SELECT id FROM sites WHERE tesla_account_id IS NOT NULL'), out: Record<string, unknown> = {}, L = ledger('pool');   // B2-11: kv cron:pool:last
  for (const s of sites) { const settings = await kv.get<Record<string, any>>('settings:owner') ?? {}; await L.step('clearUp', async () => finishClearUpIfDue(s.id, settings, await rateFor(s.id))).catch(e => console.error('[solstice] clear-up end failed', e.message));
    out[s.id] = await L.step('plan', async () => poolDetail(s.id, settings, await rateFor(s.id), { fresh: true, act: true }).then(d => d.autopilot)).catch(e => ({ error: e.message })); }
  await L.finish();
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
    const loc = siteLocation(), w = loc && await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${addDays(localDay(), -120)}&end_date=${localDay()}&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=America%2FChicago`, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).catch(() => null) as any;
    const byDay = Object.fromEntries((w?.daily?.time ?? []).map((d: string, i: number) => [d, w.daily.temperature_2m_max[i]]));
    // a failed fetch keeps the last good highs (it used to cache an empty set for 12 h)
    if (Object.keys(byDay).length) { highs = { at: Date.now(), byDay }; await kv.set('wx:highs', highs); } else highs = highs ?? { at: 0, byDay: {} };
  }
  const pts = rows.map(r => ({ t: highs!.byDay[r.day], u: r.kwh })).filter(p => p.t != null && p.t >= 80 && p.u > 5);
  let slope = 2.5;
  if (pts.length >= 10) { const mx = pts.reduce((a, p) => a + p.t, 0) / pts.length, my = pts.reduce((a, p) => a + p.u, 0) / pts.length; slope = pts.reduce((a, p) => a + (p.t - mx) * (p.u - my), 0) / pts.reduce((a, p) => a + (p.t - mx) ** 2, 0); }
  await kv.set(`${id}:ac:slope`, { at: Date.now(), slope: Math.max(.5, Math.min(6, slope || 2.5)) });
  return Math.max(.5, Math.min(6, slope || 2.5));
}
// S-07/S-10: a guest's read never reaches Nest and starts, ends or logs no hold; the owner's stale reads share one SDM read per minute (ac.ts)
app.get('/api/appliances/ac', wrap(async (req, res) => { const id = site(req); res.json(await acDetail(id, presenceHidden(req, await settingsFor(req)), await rateFor(id), await acSlope(id), { fresh: !req.guestView && req.query.fresh === '1', readOnly: !!req.guestView })); }));
/** Mockup am frame 6 (I-15): the Strip heat card, from the database only (stripwatch.ts). Owner only: no guest view in redact.ts. Writes nothing. */
app.get('/api/appliances/ac/strip', wrap(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await stripCard(site(req))); }));
/** The Now card's whole-home twin: one Chicago day hour by hour (energy, pool, AC) from the database only; never reads ScreenLogic or Nest. */
app.get('/api/appliances/day', wrap(async (req, res) => {
  const date = String(req.query.date ?? localDay());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  res.set('Cache-Control', 'no-store');   // owner data never stays in the browser cache after sign-out
  res.json(await applianceDay(site(req), date, req.user ? req.user.settings ?? {} : undefined));
}));
/** Approve today's plan: the 5-minute cron then applies each setpoint step at its hour. */
app.post('/api/appliances/ac/apply', wrap(async (req, res) => { const id = site(req); await kv.set(`${id}:ac:plan`, { date: localDay(), approved: true, lastStepHour: null }); res.json(await acTick(id, await settingsFor(req), await rateFor(id), await acSlope(id))); }));
app.post('/api/appliances/ac/settings', express.json(), wrap(async (req, res) => {
  const cur = (await settingsFor(req)).ac ?? {}, patch = req.body ?? {};
  if (typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: 'settings must be an object' });
  const bad = acPatchError(patch, cur); if (bad) return res.status(400).json({ error: bad });   // ac.ts: known keys, 65–85°, lows ≤ highs
  const next = patchedAc(cur, patch);   // mockup ag: a target change stores all four targets and the band they stand for
  if (req.user) await q('UPDATE users SET settings = settings || $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify({ ac: next })]);
  else await patchSettings(['ac'], changedKeys(cur, next), { merge: true, by: 'you' });   // B2-10: only the keys this change touched
  if (patch.presence === 'home' && (await liveTrip(site(req)))?.state === 'active') await finishTrip(site(req), 'you');   // Home during a trip is "I'm home" (mockup ak)
  if (patch.presence) await setPresence(site(req), { state: patch.presence, until: null });   // presence.ts: the switch is the manual mark
  // marking away/home takes effect right away when the plan is approved or Autopilot is Auto
  const id = site(req); if (patch.presence) { const rec = await kv.get<any>(`${id}:ac:plan`); if (rec) { rec.lastStepHour = null; await kv.set(`${id}:ac:plan`, rec); } await acTick(id, await settingsFor(req), await rateFor(id), await acSlope(id)).catch(() => {}); }
  res.json({ ok: true, ac: next });
}));
/* ---------- the owner's own thermostat controls (mockup v): owner-only like every write (access.ts) ---------- */
/** One command: {kind:'cool'|'heat', f} | {kind:'range', heatF, coolF} | {kind:'mode', mode} | {kind:'eco', on} | {kind:'fan', seconds}.
 *  A setpoint or mode change starts a hold (hold.ts), so Autopilot leaves it alone until the plan's next step (2–8 h). */
app.post('/api/appliances/ac/command', express.json({ limit: '2kb' }), wrap(async (req, res) => {
  const b = req.body ?? {}, kind = String(b.kind ?? '');
  const cmd = kind === 'cool' || kind === 'heat' ? { kind, f: Number(b.f) } : kind === 'range' ? { kind, heatF: Number(b.heatF), coolF: Number(b.coolF) }
    : kind === 'mode' ? { kind, mode: String(b.mode ?? '').toUpperCase() } : kind === 'eco' ? { kind, on: b.on === true } : kind === 'fan' ? { kind, seconds: Number(b.seconds) } : null;
  if (!cmd) return res.status(400).json({ error: 'unknown thermostat command' });
  const id = site(req), settings = await settingsFor(req), rate = await rateFor(id), slope = await acSlope(id);
  try { await ownerCommand(cmd as ManualCommand); }
  catch (e) { if (e instanceof GuardRefusal) return res.status(400).json({ error: explainRefusal(e.reason) }); throw e; }
  const d = await acDetail(id, settings, rate, slope);
  if (kind !== 'eco' && kind !== 'fan' && d.state) await startHold(id, 'app', d.state, d.plan, d.settings);
  res.json(await acDetail(id, settings, rate, slope));
}));
/** The hold banner: {action:'resume'} ends it (the step due now applies), {action:'morning'} runs it to the morning step. */
app.post('/api/appliances/ac/hold', express.json({ limit: '1kb' }), wrap(async (req, res) => {
  const id = site(req), action = String(req.body?.action ?? ''), settings = await settingsFor(req), rate = await rateFor(id), slope = await acSlope(id);
  if (action === 'resume') { await resumeHold(id); await acTick(id, settings, rate, slope).catch(e => console.warn(`[solstice] tick after resume: ${e?.message ?? e}`)); }
  else if (action === 'morning') await holdToMorning(id, { nightTo: { ...AC_DEFAULTS, ...(settings.ac ?? {}) }.nightTo });
  else return res.status(400).json({ error: 'action must be resume or morning' });
  res.json(await acDetail(id, settings, rate, slope));
}));
/**
 * Mockup ag: "Too cold" / "Too warm". {dir: 1 | -1, keep: true} moves the target for this part of the day (day or night) 1° and puts the
 * thermostat on the plan's new step now (Auto: any hold ends and the step applies through Autopilot's guard; Suggest/Off: one owner
 * command); {keep: false} is "just for now": 1° from the current setpoint as an owner command, held until the next step like any app change.
 */
app.post('/api/appliances/ac/nudge', express.json({ limit: '1kb' }), wrap(async (req, res) => {
  const dir = Number(req.body?.dir), keep = req.body?.keep === true;
  if (dir !== 1 && dir !== -1) return res.status(400).json({ error: 'dir must be 1 or -1' });
  const id = site(req), settings = await settingsFor(req), rate = await rateFor(id), slope = await acSlope(id);
  const d = await acDetail(id, settings, rate, slope);
  if (!d.state || d.state.mode !== 'COOL' || d.state.coolF == null) return res.status(400).json({ error: 'The thermostat isn\u2019t cooling, so there is nothing to nudge' });
  const cmd = async (f: number) => {
    try { await ownerCommand({ kind: 'cool', f } as ManualCommand); } catch (e) { if (e instanceof GuardRefusal) return explainRefusal(e.reason); throw e; }
    const after = await acDetail(id, await settingsFor(req), rate, slope); if (after.state) await startHold(id, 'app', after.state, after.plan, after.settings); return null;
  };
  if (!keep) { const bad = await cmd(Math.round(d.state.coolF) + dir); if (bad) return res.status(400).json({ error: bad }); return res.json(await acDetail(id, settings, rate, slope)); }
  const h = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }), night = +h >= d.settings.nightFrom || +h < d.settings.nightTo;
  const cur = settings.ac ?? {}, patch = night ? { nightF: d.settings.nightF + dir } : { dayF: d.settings.dayF + dir }, bad = acPatchError(patch, cur);
  if (bad) return res.status(400).json({ error: bad });
  await patchSettings(['ac'], changedKeys(cur, patchedAc(cur, patch)), { merge: true, by: 'you' });   // B2-10
  const now = await settingsFor(req);
  if (d.settings.autopilot === 'auto') { await resumeHold(id); const rec = await kv.get<any>(`${id}:ac:plan`); if (rec) { rec.lastStepHour = null; await kv.set(`${id}:ac:plan`, rec); }
    await acTick(id, now, rate, slope).catch(e => console.warn(`[solstice] tick after nudge: ${e?.message ?? e}`)); }
  else { const nd = await acDetail(id, now, rate, slope), step = [...nd.plan.steps].reverse().find(x => x.hour <= +h) ?? nd.plan.steps.at(-1)!; const err = await cmd(step.coolF); if (err) return res.status(400).json({ error: err }); }
  res.json(await acDetail(id, now, rate, slope));
}));
/** Frame 7: {action:'accept', key} sets the target the suggestion describes (Autopilot plans it from the next step); {action:'dismiss', key} hides it 14 days. */
app.post('/api/appliances/ac/suggestion', express.json({ limit: '1kb' }), wrap(async (req, res) => {
  const id = site(req), action = String(req.body?.action ?? ''), key = String(req.body?.key ?? ''), settings = await settingsFor(req), rate = await rateFor(id), slope = await acSlope(id);
  const d = await acDetail(id, settings, rate, slope), sg = d.suggestion;
  if (!sg || sg.key !== key) return res.status(409).json({ error: 'That suggestion is no longer current' });
  if (action === 'dismiss') await dismissSuggestion(id, key);
  else if (action === 'accept') {
    const cur = settings.ac ?? {}, patch = suggestionPatch(sg), bad = acPatchError(patch, cur); if (bad) return res.status(400).json({ error: bad });
    await patchSettings(['ac'], changedKeys(cur, patchedAc(cur, patch)), { merge: true, by: 'you' });   // B2-10
    await dismissSuggestion(id, key);   // accepted: don't offer it again
  } else return res.status(400).json({ error: 'action must be accept or dismiss' });
  res.json(await acDetail(id, await settingsFor(req), rate, slope));
}));
/* ---------- learning layer: GET /api/models (the model report), POST /api/appliances/ac/untrim (server/src/learn/api.ts) ---------- */
app.use('/api', learnRouter);
/* ---------- alerts feed and Web Push (notify.ts): /api/alerts, /api/alerts/:id/read, /api/push/key, /api/push/subscribe ---------- */
alertRoutes(app);
/* ---------- weekly digest (digest.ts): GET /api/digest?week=; built Monday 07:00 Chicago by whichever cron tick comes first ---------- */
digestRoutes(app);
/* ---------- presence (appliances/presence.ts): GET/POST /api/presence; a mark re-runs the AC tick like the AC card's switch ---------- */
presenceRoutes(app, async id => { const rec = await kv.get<any>(`${id}:ac:plan`); if (rec) { rec.lastStepHour = null; await kv.set(`${id}:ac:plan`, rec); }
  const settings = await kv.get<Record<string, any>>('settings:owner') ?? {}; return acTick(id, settings, await rateFor(id), await acSlope(id)); });
/* ---------- Vacation mode (vacation/; mockup ak): GET/POST/PATCH /api/vacation, POST /api/vacation/end; owner-only ---------- */
vacationRoutes(app);
// "Before you go" (frame 1): read-only. The pool's last reading (a fresh one when it is over 10 minutes old), the last water test, a
// Clear-up, and the thermostat as last read; "Turn off" on the sheet is the owner's own pool command (POST /api/appliances/pool/command)
departure.check = async id => {
  const s = await ownerSettings(), pool = { ...POOL_DEFAULTS, ...(s.pool ?? {}) };
  let snap = await kv.get<any>(`${id}:pool:last`) ?? null;
  if (poolConfigured() && (!snap || Date.now() - snap.at > 10 * 60_000)) snap = await poolDetail(id, s, await rateFor(id), { fresh: true }).then(d => d.snapshot).catch(() => snap);
  const W = powerModel(await measuredPoints(id)), nest = await kv.get<NestState>('nest:last');
  return { pool: { linked: !!snap, leftOn: leftOn(snap, pool.loads, W), water: await cloudyWater(id), clearUp: !!(await activeClearUp(id)), autopilot: pool.autopilot },
    nest: nestConfigured() ? { linked: !!nest, eco: !!nest?.eco, mode: nest?.mode ?? null, autopilot: { ...AC_DEFAULTS, ...(s.ac ?? {}) }.autopilot } : null };
};
// frame 2's estimate: this house's models, the pool's normal plan and the trip plan for the next day at today's water temperature
departure.estimate = async (id, leaveAt, backAt) => {
  const s = await ownerSettings(), learned = await learnAcKw(id), pool = await poolDetail(id, s, await rateFor(id)).catch(() => null);
  const days = await kv.get<{ days: any[] }>('pool:forecast'), day = days?.days?.find(d => d.date === localDay(new Date(Math.max(leaveAt, Date.now()) + 864e5))) ?? days?.days?.at(-1);
  const trip = pool && day ? tripPlanDay({ day, heatDays: 0, waterTemp: pool.live?.waterTemp ?? pool.plan.waterTemp, settings: pool.settings, W: powerModel(await measuredPoints(id)), rate: null, names: new Map() }) : null;
  return estimateTrip(id, { leaveAt, backAt, acKw: acKwFor(learned.coolKw, await acSlope(id)), poolNormalKwhDay: pool?.plan?.kwhPerDay ?? null, poolTripKwhDay: trip?.plan.kwhPerDay ?? null });
};
// the AC's part: remember the setpoints the trip starts from, then the first trip step at once; at the end, heat put back and the plan resumes
const ownerSettings = async () => await kv.get<Record<string, any>>('settings:owner') ?? {};
tripHooks.start.ac = async (id, trip) => { await patchTripData(trip.id, { ac: freshTripAc(await kv.get<NestState>('nest:last') ?? null) });
  return nestConfigured() ? acTick(id, await ownerSettings(), await rateFor(id), await acSlope(id)) : { skipped: 'nest not configured' }; };
tripHooks.end.ac = async (id, trip) => { if (!nestConfigured()) return { skipped: 'nest not configured' };
  const s = await ownerSettings(), r = await tripAcEnd(id, trip, { ...AC_DEFAULTS, ...(s.ac ?? {}) }.autopilot); await acTick(id, s, await rateFor(id), await acSlope(id)).catch(() => {}); return r; };
/* ---------- Powerwall rules (powerwall.ts, tesla/commands.ts; scope energy_cmds): /api/tesla/scopes, /api/powerwall/rules[/:id[/apply]];
 *  storm every 5 minutes, reserve once after 17:00, export nightly; only Auto rules send, Suggest waits for Apply ---------- */
powerwallRoutes(app);
fiveMinuteSteps.powerwall = powerwallTick; nightlySteps.powerwall = powerwallNightly;
fiveMinuteSteps.digest = maybeWeeklyDigest; nightlySteps.digest = maybeWeeklyDigest;
fiveMinuteSteps.panels = panelWatch;
fiveMinuteSteps.grid = gridWatch;
fiveMinuteSteps.strip = stripWatch;   // mockup am frame 7: one strip-heat alert at 10:00 Chicago; every other tick returns before the database
fiveMinuteSteps.vacation = (id, now) => vacationWatch(id, now, (sid, text) => finishTrip(sid, 'home', Date.now(), text));   // mockup ak: trip alerts, "Looks like you're away"
tripHooks.end.held = (id, trip, now) => heldSummary(id, trip, now);   // the pushes held during the trip, as one summary
// the trip report (frame 6): built by the nightly job once the trip has ended (its energy is in), pushed from 7:00 the next morning
/** The trip report needs this long (the house model's fit; ~12 s before 2026-10-07); with less left before the deadline it waits a night. */
export const TRIP_REPORT_MIN_MS = 15_000;
nightlySteps.tripReport = async (id, _now, o) => {
  const trips = await endedWithoutReport(id); if (!trips.length) return { none: true };
  // like pvsPrune: out of time tonight → skipped and said so; endedWithoutReport keeps a trip for 7 days, so the next night builds it
  if (o.deadline != null && o.deadline - Date.now() < TRIP_REPORT_MIN_MS) return { skipped: 'out of time; tomorrow night', trips: trips.map(t => t.id) };
  const s = await ownerSettings(), learned = await learnAcKw(id), pool = await poolDetail(id, s, await rateFor(id)).catch(() => null);
  const deps = { acKw: acKwFor(learned.coolKw, await acSlope(id)), poolNormalKwhDay: pool?.plan?.kwhPerDay ?? null, uv: pool?.settings?.uv ?? true };
  const out: unknown[] = []; for (const t of trips) out.push(await tripReport(id, t, deps).then(r => ({ trip: t.id, usedKwh: r.usedKwh }))); return out;
};
fiveMinuteSteps.tripReport = async (id, now) => { const t = await lastEnded(id); return t ? reportPush(id, t, now) : { none: true }; };
fiveMinuteSteps.spare = spareWatch;   // mockup ad: the pool speeds up on real spare solar (Auto only)   // mockup ab: grid down / Powerwalls low / grid back (after the storm step's live read)
nightlySteps.soiling = soilingNightly;
nightlySteps.poolTest = poolTestReminder;   // poolTests.ts (mockup aj): one "time to test" push per test, 4 days warm / 7 cool   // soiling.ts (mockup ai): the weather for the Cleaning check card, and one push per dusty spell
nightlySteps.alwaysOn = alwaysOnWatch;   // breakdown.ts: one push when the always-on base stays up three nights
nightlySteps.loads = loadsNightly;   // loads.ts (I-22): yesterday's bursts and the back-fill, then a recluster; stops 8 s before the deadline
/* Watchdog: Vercel never retries a cron, so a nightly run that died (timeout, deploy, outage) would be silent. The 5-minute tick
 * pushes one alert a day while the last finished nightly run is more than 26 hours old. */
const SYNC_DONE_KEY = 'cron:sync:done';
/** The nightly's records step (records.ts) starts only within this long of the run's start. */
const RECORDS_BY_MS = 45_000;
// B2-11 (cronLedger.ts): the crons watch each other: a quiet 5-minute tick, a missed pool plan, a nightly over 50 s; the nightly
// re-checks the 5-minute tick (if every tick has stopped, only it can tell)
fiveMinuteSteps.crons = (id, now) => cronWatch(id, now);
nightlySteps.crons = (id, now) => cronWatch(id, now, ['nest']);
fiveMinuteSteps.watchdog = async (id, now) => {
  const done = await kv.get<number>(SYNC_DONE_KEY); if (done == null) { await kv.set(SYNC_DONE_KEY, now); return { armed: true }; }   // first run after deploy
  const h = (now - done) / 3600e3; if (h <= 26) return { ok: true, hours: Math.round(h * 10) / 10 };
  return notify(id, 'anomaly', 'The nightly update didn\u2019t run', `Solstice's nightly job last finished ${Math.round(h)} hours ago, so history, learning and alerts may be stale. It runs at 5:15 AM; check Vercel's cron logs if this repeats.`,
    { hours: Math.round(h) }, { key: `watchdog:sync:${localDay(new Date(now))}`, now, url: '/?go=v-set' });
};   // panels.ts: a panel silent through an hour of daylight, or the relay itself (read-only)
/**
 * Fires every 5 minutes; sampling.ts decides what is due. Nest (with acTick: AC learning and due plan steps) every 5 minutes 10:00–22:00
 * in cooling season, every 15 minutes otherwise; a read-only pool read every 15 minutes of scheduled pump hours plus 02:00 and 05:00.
 * A tick with nothing due answers without touching the database.
 */
app.get('/api/cron/nest', wrap(async (req, res) => {
  if (!cronOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const t0 = Date.now();
  // vacation/index.ts: a trip whose leave time has come starts before the thermostat sample, so the AC plan goes away in the same tick
  const vacation: Record<string, unknown> = {}, L = ledger('nest');   // B2-11: kv cron:nest:last
  for (const id of await cronSites()) vacation[id] = await L.step('vacation', () => vacationTick(id)).catch(e => ({ error: (e as Error).message }));
  // a failed sampling tick (the pool read is bounded at 20 s by withUnit) never stops the watch steps below (code review C-01)
  const tick = await L.step('sampling', () => cronTick(Date.now(), {
    sites: async () => (await q<{ id: string }>('SELECT id FROM sites WHERE tesla_account_id IS NOT NULL')).map(s => s.id),
    acTick: async id => acTick(id, await kv.get<Record<string, any>>('settings:owner') ?? {}, await rateFor(id), await acSlope(id)),
  })).catch((e: Error) => { console.error(`[solstice] cron sampling failed: ${e.message}`); return { error: e.message }; });
  // watch.ts: storm, Storm Watch and ERCOT alerts every tick (read-only), plus what other modules register
  const watch: Record<string, unknown> = {};
  for (const id of await cronSites()) watch[id] = await fiveMinuteWatch(id, Date.now(), (n, ms, r) => L.mark(`watch.${n}`, markOf(r, ms)));
  // deepBackfill.ts (I-16): history back to the install date, 01:30–06:00 only, ≤ 3 days a tick, nothing new after t0 + 40 s.
  // Outside the window this adds no query; once done, none either (the done flag is cached per instance, the site list skipped).
  const deep: Record<string, unknown> = {}, deepRan = deepDue(t0);
  if (deepRan) {
    for (const id of await cronSites()) deep[id] = await L.step('deep', () => deepTick(id, Date.now(), { stopAt: t0 + DEEP_STOP_MS })).catch(e => ({ error: (e as Error).message }));
    notePass(deep);
  }
  await L.finish();   // after the watch: its cron step read the previous tick's record to see a gap
  res.json({ ...tick, vacation, watch, ...(deepRan ? { deep } : {}) });
}));
/* ---------- Nest change events (Google Pub/Sub push; appliances/nestEvents.ts) ----------
 * Open route: Pub/Sub signs each push with the subscription's service account (NEST_EVENTS_SA) for NEST_EVENTS_AUDIENCE, and anything
 * else is refused. A setting change (mode, setpoint, Eco) runs the manual-change detection at once; a reading (temperature, humidity,
 * HVAC) just updates the stored state and the readings. Nothing here writes to Nest. 204 acknowledges; Pub/Sub retries anything else. */
app.post('/api/nest/events', express.json({ limit: '64kb' }), wrap(async (req, res) => {
  const audience = process.env.NEST_EVENTS_AUDIENCE ?? '', email = process.env.NEST_EVENTS_SA ?? '';
  if (!audience || !email) return res.status(503).json({ error: 'nest events are not configured' });
  const h = String(req.headers.authorization ?? ''), bad = h.startsWith('Bearer ') ? await oidcError(h.slice(7), { audience, email }) : 'no token';
  if (bad) { console.warn(`[solstice] nest event refused: ${bad}`); return res.status(401).json({ error: 'unauthorized' }); }
  const ev = eventOf(req.body);
  if (!ev?.resourceUpdate || await seenEvent(ev.eventId)) return res.status(204).end();   // relation events and redeliveries: nothing to do
  const prev = await kv.get<NestState>('nest:last'), at = eventTime(ev.timestamp);   // S-13: at most a minute ahead of now
  if (!prev || ev.resourceUpdate.name !== prev.deviceId || at < prev.at) return res.status(204).end();   // another device, or older than what we have
  const next = applyTraits(prev, ev.resourceUpdate.traits ?? {}, at);
  await kv.set('nest:last', next); await kv.set('nest:eventAt', Date.now());
  const [id] = await cronSites(); if (!id) return res.status(204).end();
  await recordNest(id, next);
  if (isSettingEvent(ev)) {
    const settings = await kv.get<Record<string, any>>('settings:owner') ?? {}, d = await acDetail(id, settings, await rateFor(id), await acSlope(id));
    await observeHold(id, prev, next, d.plan, d.settings, d.presence);
  }
  res.status(204).end();
}));

/* ---------- Google (Nest) OAuth ---------- */
app.get('/auth/google', (req, res) => { if (!nestConfigured()) return res.status(503).send('Nest is not configured'); res.redirect(nestAuthorizeUrl(signOwnerState('nest', 60 * 60_000))); }); // owner-only; Google's permissions page can take a while
app.get('/auth/google/callback', wrap(async (req, res) => {
  if (!(await consumeOwnerState(String(req.query.state ?? ''), 'nest'))) return res.redirect('/?nest_error=expired');
  try { await nestExchangeCode(String(req.query.code)); await readNest(); res.redirect('/?nest=linked'); } catch (e: any) { console.error('nest link', e); res.redirect('/?nest_error=failed'); }
}));

/* ---------- CSV export ---------- */
app.get('/api/export.csv', wrap(async (req, res) => {
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="solstice-${localDay()}.csv"` });
  res.write('timestamp,solar_wh,home_wh,import_wh,export_wh,battery_charge_wh,battery_discharge_wh\n');
  // every row, as before, but read 90 days at a time (I-16: the whole history is ~650k rows, too many to hold in one result)
  const id = site(req), first = (await one<{ d: string | null }>('SELECT MIN(day) d FROM energy WHERE site_id = $1', [id]))?.d, today = localDay();
  for (let from = first; from && from <= today; from = addDays(from, 90)) {
    const rows = await q('SELECT ts, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh FROM energy WHERE site_id = $1 AND day >= $2 AND day < $3 ORDER BY epoch', [id, from, addDays(from, 90)]);
    for (const r of rows) res.write(`${r.ts},${r.solar_wh},${r.home_wh},${r.import_wh},${r.export_wh},${r.charge_wh},${r.discharge_wh}\n`);
  }
  res.end();
}));

/** The owner sees what went wrong (a device error, say); anyone else gets a fixed message and an id to match the log line. */
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const id = Math.random().toString(36).slice(2, 10);
  console.error(`[solstice] error ${id} ${req.method} ${req.path}:`, err);
  if (res.headersSent) return res.end();
  res.status(500).json(req.role === 'owner' ? { error: err.message, id } : { error: 'internal error', id });
});
