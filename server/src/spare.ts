// Spare solar (mockup ad): solar is spare only when the Powerwalls are nearly full and power is going out to PEC. Anything else is
// the Powerwalls charging for the evening, which is not free. Used by the AC pre-cool test (appliances/ac.ts), the pool speed-up below
// (the 5-minute watch, Auto only) and the Insights › Home card (GET /api/spare). Reads the live readings the watch already takes.
import { q, one, kv } from './db.js';
import { localDay, addDays } from './tesla/client.js';
import { writeOwnerPool, configured, type PoolSnapshot } from './appliances/screenlogic.js';
import { POOL_DEFAULTS, activeClearUp, recordReading, powerModel, measuredPoints, type PoolSettings } from './appliances/pool.js';

export const SPARE_SOC = 95, SPARE_WINDOW_MS = 15 * 60_000, SPARE_START_W = 1000, SPARE_KEEP_W = 300, SPEEDUP_RUN_MIN = 60, SPEEDUP_GAP_MS = 3600e3;
/** A day with spare solar: the Powerwalls reached 95% or more than 2 kWh went to PEC (the card's count). */
export const SPARE_DAY_EXPORT_KWH = 2;

/** The last 15 minutes of live readings: average export (W, 0 when buying) and charge, or null with fewer than two readings. */
export async function spareNow(siteId: string, now = Date.now()) {
  const r = await one<{ n: number; exp: number | null; soc: number | null; surplus: number | null }>(
    `SELECT COUNT(*)::int n, AVG(GREATEST(0, -grid_w))::float8 exp, AVG(soc)::float8 soc, AVG(solar_w - load_w)::float8 surplus FROM readings WHERE site_id = $1 AND ts > $2`, [siteId, now - SPARE_WINDOW_MS]);
  if (!r || r.n < 2 || r.soc == null) return null;
  return { exportW: Math.round(r.exp ?? 0), soc: Math.round(r.soc), surplusW: Math.round(r.surplus ?? 0), full: r.soc >= SPARE_SOC };
}
/** Spare = full Powerwalls and at least `minW` going out to PEC. */
export const isSpare = (s: Awaited<ReturnType<typeof spareNow>>, minW = SPARE_START_W) => !!s && s.full && s.exportW >= minW;

/** The card: days with spare solar and kWh sent to PEC per month for the last 12 full months and this one, plus now. */
export async function spareHistory(siteId: string, now = Date.now()) {
  const today = localDay(new Date(now)), from = `${addDays(today, -365).slice(0, 7)}-01`;
  const rows = await q<{ day: string; exp: number; mx: number | null }>(`SELECT e.day, (SUM(e.export_wh) / 1000.0)::float8 exp, s.mx FROM energy e
    LEFT JOIN (SELECT day, MAX(soe)::float8 mx FROM soe WHERE site_id = $1 AND day >= $2 GROUP BY day) s ON s.day = e.day
    WHERE e.site_id = $1 AND e.day >= $2 GROUP BY e.day, s.mx`, [siteId, from]);
  const byMonth = new Map<string, { days: number; exportKwh: number }>();
  for (const r of rows) { const m = r.day.slice(0, 7), x = byMonth.get(m) ?? { days: 0, exportKwh: 0 };
    if ((r.mx ?? 0) >= SPARE_SOC || r.exp > SPARE_DAY_EXPORT_KWH) x.days++; x.exportKwh += r.exp; byMonth.set(m, x); }
  const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, v]) => ({ month, days: v.days, exportKwh: Math.round(v.exportKwh) }));
  const live = await spareNow(siteId, now);
  return { months, days: months.reduce((a, m) => a + m.days, 0), exportKwh: months.reduce((a, m) => a + m.exportKwh, 0),
    now: live ? { ...live, spare: isSpare(live, SPARE_KEEP_W) } : null };
}

/* ---------- the pool speed-up (Auto only) ---------- */
type SpeedUp = { since: number; until: number; lastStart: number };
const key = (siteId: string) => `${siteId}:pool:spare`;
/** Whether the Pool program runs at this minute of the Chicago day, from the last stored controller snapshot. */
function poolProgramNow(snap: PoolSnapshot | null, s: PoolSettings, now: number) {
  const t = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now));
  const m = +t.find(p => p.type === 'hour')!.value * 60 + +t.find(p => p.type === 'minute')!.value;
  return (snap?.schedules ?? []).some(x => x.circuitId === s.poolCircuit && (x.stop > x.start ? m >= x.start && m < x.stop : m >= x.start || m < x.stop));
}
const logLine = async (siteId: string, text: string, delta?: string) => {
  const log = await kv.get<Array<{ at: number; day: string; text: string; delta?: string }>>(`${siteId}:pool:autolog`) ?? [];
  log.unshift({ at: Date.now(), day: localDay(), text, delta }); await kv.set(`${siteId}:pool:autolog`, log.slice(0, 30));
};
/**
 * Every 5 minutes. While there is spare solar and the Pool program is running, Auto turns on the boost circuit (High Speed, its saved
 * 2,400 RPM) for an hour on the controller's timer, renewed while the spare lasts; when the export stays under 0.3 kW (or the Powerwalls
 * drop under 95%) for 15 minutes it turns it off. Never during a Clear-up or a boost the owner started; at most one start an hour.
 * `write` is injectable for tests.
 */
export async function spareWatch(siteId: string, now = Date.now(), write: typeof writeOwnerPool = writeOwnerPool) {
  const settings = await kv.get<Record<string, any>>('settings:owner') ?? {}, s: PoolSettings = { ...POOL_DEFAULTS, ...(settings.pool ?? {}) };
  const st = await kv.get<SpeedUp | null>(key(siteId)), live = await spareNow(siteId, now), snap = await kv.get<PoolSnapshot | null>(`${siteId}:pool:last`);
  const boostOn = !!snap?.circuits.find(c => c.id === s.boostCircuit)?.on, can = write !== writeOwnerPool || configured();
  const turn = async (on: boolean) => { const after = await write(on ? { kind: 'circuit', id: s.boostCircuit, on: true, minutes: SPEEDUP_RUN_MIN } : { kind: 'circuit', id: s.boostCircuit, on: false }); await recordReading(siteId, after); };
  // a speed-up of ours is under way (until > 0): renew it near the end of its timer while the spare lasts, end it when the spare goes
  if (st && st.until > 0) {
    if (isSpare(live, SPARE_KEEP_W) && s.autopilot === 'auto' && !(await activeClearUp(siteId, now))) {
      if (st.until - now > 10 * 60_000 || !can) return { running: true };
      await turn(true); await kv.set(key(siteId), { ...st, until: now + SPEEDUP_RUN_MIN * 60_000 });
      return { renewed: true };
    }
    if (boostOn && st.until > now && can) await turn(false);    // past its timer the controller has already turned it off
    await kv.set(key(siteId), { ...st, until: 0 });
    const W = powerModel(await measuredPoints(siteId)), base = snap?.pump?.circuits.find(c => c.circuitId === s.poolCircuit)?.speed ?? 0;
    const end = Math.min(now, st.until), h = (end - st.since) / 3600e3, kwh = Math.round((W(s.boostRpm) - W(base)) * h / 100) / 10, mins = Math.round((end - st.since) / 60_000);
    await logLine(siteId, `Spare solar ended: back to ${base.toLocaleString()} RPM after ${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} m` : `${mins} m`} (about ${kwh} kWh used here instead of sent out)`, 'spare');
    return { ended: true, kwh };
  }
  if (!isSpare(live)) return { spare: false };
  if (s.autopilot !== 'auto') {   // Suggest notes it once a day; Off does nothing
    if (s.autopilot !== 'suggest' || await kv.get<string>(`${siteId}:pool:spareNoted`) === localDay(new Date(now))) return { spare: true, mode: s.autopilot };
    await kv.set(`${siteId}:pool:spareNoted`, localDay(new Date(now)));
    await logLine(siteId, `Spare solar now (${(live!.exportW / 1000).toFixed(1)} kW to PEC): in Auto the pool would speed up to ${s.boostRpm.toLocaleString()} RPM`, 'spare');
    return { spare: true, mode: s.autopilot, noted: true };
  }
  if (await activeClearUp(siteId, now)) return { skipped: 'clear-up' };
  if (boostOn) return { skipped: 'boost already on' };            // the owner's boost (ours is handled above)
  if (!snap?.pump?.running || !poolProgramNow(snap, s, now)) return { skipped: 'pool program not running' };
  if (st && now - st.lastStart < SPEEDUP_GAP_MS) return { skipped: 'one start an hour' };
  if (!can) return { skipped: 'no controller' };
  await turn(true);
  await kv.set(key(siteId), { since: now, until: now + SPEEDUP_RUN_MIN * 60_000, lastStart: now } satisfies SpeedUp);
  await logLine(siteId, `Spare solar: Pool up to ${s.boostRpm.toLocaleString()} RPM while the Powerwalls are full and ${(live!.exportW / 1000).toFixed(1)} kW goes to PEC. Counts toward today's turnovers.`, 'spare');
  return { started: true, exportW: live!.exportW };
}
