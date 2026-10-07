// Per-panel production from the SunPower PVS6 (docs/audit-designs/enhancements.md V1). The PVS is only reachable on the
// owner's LAN, so scripts/pvs-relay.mjs polls it every 5 minutes and pushes one batch per poll to POST /api/pvs/readings.
// One row per inverter per poll in `pvs_readings`, holding only ts, serial, AC kW, DC kW, volts, heat-sink °C and the
// inverter's lifetime kWh counter. The day roll-up (5-minute series and per-panel kWh) is computed on read. Every route here is owner-only through requireOwner in app.ts.
import express, { type Request, type Response, type NextFunction } from 'express';
import { q, one, kv } from './db.js';
import { localDay, localMidnight, addDays } from './tesla/client.js';
import { learnLayout, getLayout, applyMoves, layoutView, LAYOUT_KEY } from './panels.js';

export const PVS_LIMITS = {
  maxInverters: 60,              // 30 on this roof; room for an expansion, not for junk
  futureMs: 5 * 60_000,          // clock skew allowed between the relay's Mac and the server
  pastMs: 7 * 864e5,             // a batch older than this is refused (the relay only ever sends the current poll)
  latestRecentMs: 864e5,         // /latest reads the last day first…
  latestLookbackMs: 7 * 864e5,   // …and, with nothing in it, looks back this far from the newest reading
};
const BUCKET_MS = 5 * 60_000;

/* ---------------- retention ----------------
 * Raw readings are kept PVS_KEEP_DAYS (~4,300 rows a day; Neon's free plan has 0.5 GB). The nightly per-panel figures
 * (daily_metrics pvs.*, learn/nightly.ts) are kept for good, and nightly.ts recomputes them from the last 21 days, so the
 * window must stay well above 21. kv pvs:since keeps the relay's first reading, so "per-panel data since …" survives the prune. */
export const PVS_KEEP_DAYS = 90;
export const SINCE_KEY = 'pvs:since';
/** Epoch ms of the relay's first reading ever: kv pvs:since, else the oldest stored reading, else null. */
export async function pvsSince(): Promise<number | null> {
  const k = await kv.get<number>(SINCE_KEY);
  if (typeof k === 'number') return k;
  const r = await one<{ ms: number | null }>(`SELECT (extract(epoch FROM min(ts)) * 1000)::float8 AS ms FROM pvs_readings`);
  return r?.ms == null ? null : Number(r.ms);
}
/** Nightly (the sync cron, after the learning layer has written the day's figures): records pvs:since if it is not yet
 *  recorded, then deletes readings older than PVS_KEEP_DAYS. Returns how many rows went. */
export async function prunePvs(now = Date.now()): Promise<{ deleted: number; since: string | null }> {
  const since = await pvsSince();
  if (since != null && (await kv.get(SINCE_KEY)) == null) await kv.set(SINCE_KEY, since);
  const rows = await q(`DELETE FROM pvs_readings WHERE ts < $1::timestamptz RETURNING 1 AS x`, [new Date(now - PVS_KEEP_DAYS * 864e5).toISOString()]);
  return { deleted: rows.length, since: since == null ? null : new Date(since).toISOString() };
}

/* ---------------- the relay's heartbeat (kv pvs:heartbeat) ----------------
 * Every contact from the relay: a stored poll (POST /readings) writes { pvs: 'ok' }; a poll that failed on the PVS side posts
 * POST /heartbeat { pvs, http, error, uptimeS }. panels.ts reads it to tell "the Mac is off" from "the relay runs, the PVS refused". */
export const HEARTBEAT_KEY = 'pvs:heartbeat';
export const PVS_STATUSES = ['ok', 'unreachable', 'login-refused', 'certificate', 'refused', 'no-inverters', 'error'] as const;
export type PvsStatus = typeof PVS_STATUSES[number];
/** `at` is the server's clock when the relay last got through; `error` is the relay's own text (owner-only, it may name the PVS's LAN address). */
export type Heartbeat = { at: number; pvs: PvsStatus; http: number | null; error: string | null; uptimeS: number | null };

export function parseHeartbeat(body: unknown, now = Date.now()): { ok: true; hb: Heartbeat } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object { pvs, http, error, uptimeS }' };
  const { pvs, http, error, uptimeS } = body as Record<string, unknown>;
  if (typeof pvs !== 'string' || !(PVS_STATUSES as readonly string[]).includes(pvs)) return { ok: false, error: `pvs must be one of ${PVS_STATUSES.join(', ')}` };
  if (http != null && !(Number.isInteger(http) && (http as number) >= 100 && (http as number) <= 599)) return { ok: false, error: 'http must be null or an HTTP status' };
  if (error != null && typeof error !== 'string') return { ok: false, error: 'error must be null or a string' };
  if (uptimeS != null && !(typeof uptimeS === 'number' && Number.isFinite(uptimeS) && uptimeS >= 0)) return { ok: false, error: 'uptimeS must be null or a number of seconds' };
  return { ok: true, hb: { at: now, pvs: pvs as PvsStatus, http: (http as number | null) ?? null,
    error: error == null ? null : String(error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300), uptimeS: uptimeS == null ? null : Math.round(uptimeS as number) } };
}
export const getHeartbeat = async () => (await kv.get<Heartbeat>(HEARTBEAT_KEY)) ?? null;

/** kw = AC output (p3phsumKw), kwDc = DC input (pMppt1Kw), kwhLifetime = the inverter's lifetime energy counter (ltea3phsumKwh). */
export type PvsReading = { sn: string; kw: number | null; kwDc: number | null; v: number | null; tempC: number | null; kwhLifetime: number | null };
export type PvsBatch = { ts: Date; inverters: PvsReading[] };

const SN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Validates the relay's `{ ts, inverters: [{ sn, kw, kwDc, v, tempC, kwhLifetime }] }` and keeps only those fields. Only sn is
 *  required; each number may be null or left out. */
export function parsePvsBatch(body: unknown, now = Date.now()): { ok: true; batch: PvsBatch } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be a JSON object { ts, inverters }');
  const { ts, inverters } = body as Record<string, unknown>;
  const ms = typeof ts === 'number' ? ts : typeof ts === 'string' && ISO_WITH_ZONE.test(ts) ? Date.parse(ts) : NaN;
  if (!Number.isFinite(ms)) return bad('ts must be an ISO 8601 time with a zone, or epoch milliseconds');
  if (ms > now + PVS_LIMITS.futureMs) return bad('ts is in the future');
  if (ms < now - PVS_LIMITS.pastMs) return bad('ts is more than 7 days old');
  if (!Array.isArray(inverters) || inverters.length === 0) return bad('inverters must be a non-empty array');
  if (inverters.length > PVS_LIMITS.maxInverters) return bad(`at most ${PVS_LIMITS.maxInverters} inverters per batch`);
  const out: PvsReading[] = [], seen = new Set<string>();
  const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  for (const [i, x] of inverters.entries()) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return bad(`inverters[${i}] must be an object`);
    const { sn, kw, kwDc, v, tempC, kwhLifetime } = x as Record<string, unknown>;
    if (typeof sn !== 'string' || !SN.test(sn)) return bad(`inverters[${i}].sn must be 1-40 letters, digits or . _ : -`);
    if (seen.has(sn)) return bad(`inverters[${i}].sn is repeated`);
    if (kw != null && !num(kw, 0, 2)) return bad(`inverters[${i}].kw must be null or a number from 0 to 2`);
    if (kwDc != null && !num(kwDc, 0, 2)) return bad(`inverters[${i}].kwDc must be null or a number from 0 to 2`);
    if (kwhLifetime != null && !num(kwhLifetime, 0, Number.MAX_SAFE_INTEGER)) return bad(`inverters[${i}].kwhLifetime must be null or a number of at least 0`);
    if (v != null && !num(v, -1000, 1000)) return bad(`inverters[${i}].v must be null or a number from -1000 to 1000`);
    if (tempC != null && !num(tempC, -60, 150)) return bad(`inverters[${i}].tempC must be null or a number from -60 to 150`);
    seen.add(sn);
    const r = (x: unknown, d: number) => x == null ? null : round(x as number, d);
    out.push({ sn, kw: r(kw, 5), kwDc: r(kwDc, 5), v: r(v, 2), tempC: r(tempC, 2), kwhLifetime: r(kwhLifetime, 6) });
  }
  return { ok: true, batch: { ts: new Date(ms), inverters: out } };
}

/** Inserts one poll. A reading already stored for the same (ts, sn) is left as it is, so a retried POST changes nothing. */
export async function ingestPvs(batch: PvsBatch): Promise<{ inserted: number; duplicates: number }> {
  const params: unknown[] = [batch.ts.toISOString()];
  const rows = batch.inverters.map(r => {
    params.push(r.sn, r.kw, r.v, r.tempC, r.kwDc, r.kwhLifetime); const n = params.length;
    return `($1::timestamptz, $${n - 5}, $${n - 4}::numeric, $${n - 3}::numeric, $${n - 2}::numeric, $${n - 1}::numeric, $${n}::numeric)`;
  });
  const ins = await q(`INSERT INTO pvs_readings (ts, sn, kw, v, temp_c, kw_dc, kwh_lifetime) VALUES ${rows.join(', ')} ON CONFLICT (ts, sn) DO NOTHING RETURNING sn`, params);
  await learnLayout(batch.inverters.map(r => r.sn));   // panels.ts: a serial seen for the first time gets the next roof position
  return { inserted: ins.length, duplicates: batch.inverters.length - ins.length };
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** One local (America/Chicago) day: each inverter's 5-minute series (bucket averages, null where it has no reading) and
 *  its kWh. The kWh is the inverter's lifetime counter at its last reading of the day minus its first (`kwhSource:
 *  'lifetime'`), which is exact across gaps; without two such readings, or if the counter went backwards (a replaced
 *  inverter), it falls back to the sum of bucket average AC kW × 5 minutes (`kwhSource: 'integrated'`). That sum counts
 *  only buckets with a reading, so a gap (the Mac asleep) reads low rather than being guessed; `buckets` says how many
 *  5-minute buckets each inverter has. */
export async function pvsDay(date: string) {
  const start = localMidnight(date), end = localMidnight(addDays(date, 1));
  const rows = await q<{ sn: string; b: number; kw: number | null; v: number | null; t: number | null }>(
    `SELECT sn, floor(extract(epoch FROM ts) / 300)::int AS b, avg(kw)::float8 AS kw, avg(v)::float8 AS v, avg(temp_c)::float8 AS t
       FROM pvs_readings WHERE ts >= $1::timestamptz AND ts < $2::timestamptz GROUP BY sn, b ORDER BY b, sn`,
    [start.toISOString(), end.toISOString()]);
  const ends = await q<{ sn: string; first: number | null; last: number | null; n: number }>(
    `SELECT sn, (array_agg(kwh_lifetime ORDER BY ts))[1]::float8 AS first, (array_agg(kwh_lifetime ORDER BY ts DESC))[1]::float8 AS last, count(*)::int AS n
       FROM pvs_readings WHERE ts >= $1::timestamptz AND ts < $2::timestamptz AND kwh_lifetime IS NOT NULL GROUP BY sn`,
    [start.toISOString(), end.toISOString()]);
  const lifetime = new Map(ends.filter(e => Number(e.n) >= 2 && e.first != null && e.last != null && e.last >= e.first).map(e => [e.sn, e.last! - e.first!]));
  const buckets = [...new Set(rows.map(r => Number(r.b)))].sort((a, b) => a - b), at = new Map(buckets.map((b, i) => [b, i]));
  const bySn = new Map<string, { kw: (number | null)[]; v: (number | null)[]; tempC: (number | null)[] }>();
  for (const r of rows) {
    let s = bySn.get(r.sn);
    if (!s) bySn.set(r.sn, s = { kw: buckets.map(() => null), v: buckets.map(() => null), tempC: buckets.map(() => null) });
    const i = at.get(Number(r.b))!;
    s.kw[i] = r.kw == null ? null : round(r.kw, 4); s.v[i] = r.v == null ? null : round(r.v, 1); s.tempC[i] = r.t == null ? null : round(r.t, 1);
  }
  const inverters = [...bySn.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sn, s]) => {
    const kws = s.kw.filter((x): x is number => x != null), temps = s.tempC.filter((x): x is number => x != null);
    const life = lifetime.get(sn);
    return {
      sn, kwh: round(life ?? (kws.reduce((a, k) => a + Math.max(0, k), 0) * BUCKET_MS / 3600_000), 3),
      kwhSource: life == null ? 'integrated' as const : 'lifetime' as const,
      peakKw: kws.length ? Math.max(...kws) : null, maxTempC: temps.length ? Math.max(...temps) : null, buckets: kws.length, ...s,
    };
  });
  const kwhs = inverters.map(i => i.kwh);
  return {
    date, timeZone: 'America/Chicago', start: start.toISOString(), end: end.toISOString(), bucketMinutes: BUCKET_MS / 60_000,
    times: buckets.map(b => b * BUCKET_MS),   // bucket starts, epoch ms
    inverters,
    total: { kwh: round(kwhs.reduce((a, k) => a + k, 0), 3), inverters: inverters.length, medianKwh: median(kwhs) },
  };
}

/** The newest reading of each inverter seen within the last 24 hours, with its age in seconds; with none in that window (the
 *  relay quiet for a day), within 7 days of the newest reading overall. (Bounded so the query stays a range scan on the primary key
 *  and the 5-minute watch sorts a day of rows, not a week (code review C-12); an inverter silent for longer drops out, which a count
 *  below the expected 30 shows.) */
export async function pvsLatest(now = Date.now()) {
  type Row = { sn: string; ms: number; kw: number | null; kw_dc: number | null; v: number | null; t: number | null; kwh: number | null };
  const cols = `DISTINCT ON (sn) sn, (extract(epoch FROM ts) * 1000)::float8 AS ms, kw::float8 AS kw, kw_dc::float8 AS kw_dc, v::float8 AS v,
            temp_c::float8 AS t, kwh_lifetime::float8 AS kwh`;
  let rows = await q<Row>(`SELECT ${cols} FROM pvs_readings WHERE ts >= $1::timestamptz ORDER BY sn, ts DESC`, [new Date(now - PVS_LIMITS.latestRecentMs).toISOString()]);
  if (!rows.length) rows = await q<Row>(`SELECT ${cols} FROM pvs_readings WHERE ts >= (SELECT max(ts) FROM pvs_readings) - $1::interval ORDER BY sn, ts DESC`,
    [`${PVS_LIMITS.latestLookbackMs / 1000} seconds`]);
  const age = (ms: number) => Math.max(0, Math.round((now - ms) / 1000));
  const newest = rows.length ? Math.max(...rows.map(r => Number(r.ms))) : null;
  return {
    at: newest == null ? null : new Date(newest).toISOString(), ageS: newest == null ? null : age(newest), count: rows.length,
    inverters: rows.map(r => ({ sn: r.sn, ts: new Date(Number(r.ms)).toISOString(), ageS: age(Number(r.ms)), kw: r.kw, kwDc: r.kw_dc, v: r.v, tempC: r.t,
      kwhLifetime: r.kwh })),
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d: string) => { const ms = DAY.test(d) ? Date.parse(`${d}T12:00:00Z`) : NaN; return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d; };

/** Mounted at /api/pvs in app.ts, after the owner gate. */
export const pvsRouter = express.Router();
pvsRouter.post('/readings', express.json({ limit: '64kb', type: () => true }), async (req: Request, res: Response) => {
  const p = parsePvsBatch(req.body);
  if (!p.ok) return res.status(400).json({ error: p.error });
  const r = await ingestPvs(p.batch);
  await kv.set(HEARTBEAT_KEY, { at: Date.now(), pvs: 'ok', http: 200, error: null, uptimeS: null } satisfies Heartbeat);
  res.json({ ok: true, ...r });
});
pvsRouter.post('/heartbeat', express.json({ limit: '4kb', type: () => true }), async (req: Request, res: Response) => {
  const p = parseHeartbeat(req.body);
  if (!p.ok) return res.status(400).json({ error: p.error });
  await kv.set(HEARTBEAT_KEY, p.hb);
  res.json({ ok: true });
});
pvsRouter.get('/day', async (req: Request, res: Response) => {
  const date = req.query.date === undefined ? localDay() : String(req.query.date);
  if (!validDay(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  res.json(await pvsDay(date));
});
pvsRouter.get('/latest', async (_req: Request, res: Response) => res.json(await pvsLatest()));
// The roof positions (panels.ts; mockup u-panels): positions only, never a serial. POST { moves: { "r1c3": "r2c5", "r2c5": "r1c3" } }
// corrects the learned map (owner-only: a guest has no view for either route, so access.ts answers 401).
pvsRouter.get('/layout', async (_req: Request, res: Response) => res.json(layoutView(await getLayout())));
pvsRouter.post('/layout', express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
  const cur = await getLayout();
  if (!cur) return res.status(409).json({ error: 'no layout yet: it is learned from the first relay poll' });
  const r = applyMoves(cur, req.body?.moves);
  if (!r.ok) return res.status(400).json({ error: r.error });
  await kv.set(LAYOUT_KEY, r.layout);
  res.json({ ok: true, ...layoutView(r.layout) });
});
// A malformed or oversized body is the caller's mistake (400/413), not a server error.
pvsRouter.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'body is not valid JSON' });
  next(err);
});
