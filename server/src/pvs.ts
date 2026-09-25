// Per-panel production from the SunPower PVS6 (docs/audit-designs/enhancements.md V1). The PVS is only reachable on the
// owner's LAN, so scripts/pvs-relay.mjs polls it every 5 minutes and pushes one batch per poll to POST /api/pvs/readings.
// One row per inverter per poll in `pvs_readings`, holding only ts, serial, kW, volts and heat-sink °C. The day roll-up
// (5-minute series and per-panel kWh) is computed on read. Every route here is owner-only through requireOwner in app.ts.
import express, { type Request, type Response, type NextFunction } from 'express';
import { q } from './db.js';
import { localDay, localMidnight, addDays } from './tesla/client.js';

export const PVS_LIMITS = {
  maxInverters: 60,              // 30 on this roof; room for an expansion, not for junk
  futureMs: 5 * 60_000,          // clock skew allowed between the relay's Mac and the server
  pastMs: 7 * 864e5,             // a batch older than this is refused (the relay only ever sends the current poll)
  latestLookbackMs: 7 * 864e5,   // /latest looks back this far from the newest reading
};
const BUCKET_MS = 5 * 60_000;

export type PvsReading = { sn: string; kw: number; v: number | null; tempC: number | null };
export type PvsBatch = { ts: Date; inverters: PvsReading[] };

const SN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Validates the relay's `{ ts, inverters: [{ sn, kw, v, tempC }] }` and keeps only those fields. */
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
    const { sn, kw, v, tempC } = x as Record<string, unknown>;
    if (typeof sn !== 'string' || !SN.test(sn)) return bad(`inverters[${i}].sn must be 1-40 letters, digits or . _ : -`);
    if (seen.has(sn)) return bad(`inverters[${i}].sn is repeated`);
    if (!num(kw, -1, 1)) return bad(`inverters[${i}].kw must be a number from -1 to 1`);
    if (v != null && !num(v, -1000, 1000)) return bad(`inverters[${i}].v must be null or a number from -1000 to 1000`);
    if (tempC != null && !num(tempC, -60, 150)) return bad(`inverters[${i}].tempC must be null or a number from -60 to 150`);
    seen.add(sn);
    out.push({ sn, kw: round(kw as number, 5), v: v == null ? null : round(v as number, 2), tempC: tempC == null ? null : round(tempC as number, 2) });
  }
  return { ok: true, batch: { ts: new Date(ms), inverters: out } };
}

/** Inserts one poll. A reading already stored for the same (ts, sn) is left as it is, so a retried POST changes nothing. */
export async function ingestPvs(batch: PvsBatch): Promise<{ inserted: number; duplicates: number }> {
  const params: unknown[] = [batch.ts.toISOString()];
  const rows = batch.inverters.map(r => { params.push(r.sn, r.kw, r.v, r.tempC); const n = params.length; return `($1::timestamptz, $${n - 3}, $${n - 2}::numeric, $${n - 1}::numeric, $${n}::numeric)`; });
  const ins = await q(`INSERT INTO pvs_readings (ts, sn, kw, v, temp_c) VALUES ${rows.join(', ')} ON CONFLICT (ts, sn) DO NOTHING RETURNING sn`, params);
  return { inserted: ins.length, duplicates: batch.inverters.length - ins.length };
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** One local (America/Chicago) day: each inverter's 5-minute series (bucket averages, null where it has no reading) and
 *  its kWh, the sum of bucket average kW × 5 minutes. Only buckets with a reading count, so a gap (the Mac asleep) reads
 *  low rather than being guessed; `buckets` says how many 5-minute buckets each inverter has. */
export async function pvsDay(date: string) {
  const start = localMidnight(date), end = localMidnight(addDays(date, 1));
  const rows = await q<{ sn: string; b: number; kw: number; v: number | null; t: number | null }>(
    `SELECT sn, floor(extract(epoch FROM ts) / 300)::int AS b, avg(kw)::float8 AS kw, avg(v)::float8 AS v, avg(temp_c)::float8 AS t
       FROM pvs_readings WHERE ts >= $1::timestamptz AND ts < $2::timestamptz GROUP BY sn, b ORDER BY b, sn`,
    [start.toISOString(), end.toISOString()]);
  const buckets = [...new Set(rows.map(r => Number(r.b)))].sort((a, b) => a - b), at = new Map(buckets.map((b, i) => [b, i]));
  const bySn = new Map<string, { kw: (number | null)[]; v: (number | null)[]; tempC: (number | null)[] }>();
  for (const r of rows) {
    let s = bySn.get(r.sn);
    if (!s) bySn.set(r.sn, s = { kw: buckets.map(() => null), v: buckets.map(() => null), tempC: buckets.map(() => null) });
    const i = at.get(Number(r.b))!;
    s.kw[i] = round(r.kw, 4); s.v[i] = r.v == null ? null : round(r.v, 1); s.tempC[i] = r.t == null ? null : round(r.t, 1);
  }
  const inverters = [...bySn.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sn, s]) => {
    const kws = s.kw.filter((x): x is number => x != null), temps = s.tempC.filter((x): x is number => x != null);
    return {
      sn, kwh: round(kws.reduce((a, k) => a + Math.max(0, k), 0) * BUCKET_MS / 3600_000, 3),
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

/** The newest reading of each inverter seen within 7 days of the newest reading overall, with its age in seconds.
 *  (Bounded so the query stays a range scan on the primary key; an inverter silent for longer drops out, which a
 *  count below the expected 30 shows.) */
export async function pvsLatest(now = Date.now()) {
  const rows = await q<{ sn: string; ms: number; kw: number; v: number | null; t: number | null }>(
    `SELECT DISTINCT ON (sn) sn, (extract(epoch FROM ts) * 1000)::float8 AS ms, kw::float8 AS kw, v::float8 AS v, temp_c::float8 AS t
       FROM pvs_readings WHERE ts >= (SELECT max(ts) FROM pvs_readings) - $1::interval ORDER BY sn, ts DESC`,
    [`${PVS_LIMITS.latestLookbackMs / 1000} seconds`]);
  const age = (ms: number) => Math.max(0, Math.round((now - ms) / 1000));
  const newest = rows.length ? Math.max(...rows.map(r => Number(r.ms))) : null;
  return {
    at: newest == null ? null : new Date(newest).toISOString(), ageS: newest == null ? null : age(newest), count: rows.length,
    inverters: rows.map(r => ({ sn: r.sn, ts: new Date(Number(r.ms)).toISOString(), ageS: age(Number(r.ms)), kw: r.kw, v: r.v, tempC: r.t })),
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d: string) => { const ms = DAY.test(d) ? Date.parse(`${d}T12:00:00Z`) : NaN; return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d; };

/** Mounted at /api/pvs in app.ts, after the owner gate. */
export const pvsRouter = express.Router();
pvsRouter.post('/readings', express.json({ limit: '64kb', type: () => true }), async (req: Request, res: Response) => {
  const p = parsePvsBatch(req.body);
  if (!p.ok) return res.status(400).json({ error: p.error });
  res.json({ ok: true, ...await ingestPvs(p.batch) });
});
pvsRouter.get('/day', async (req: Request, res: Response) => {
  const date = req.query.date === undefined ? localDay() : String(req.query.date);
  if (!validDay(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  res.json(await pvsDay(date));
});
pvsRouter.get('/latest', async (_req: Request, res: Response) => res.json(await pvsLatest()));
// A malformed or oversized body is the caller's mistake (400/413), not a server error.
pvsRouter.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'body is not valid JSON' });
  next(err);
});
