// Small entry points the existing appliance code calls, kept here so the hooks in pool/autopilot stay one line each.
import { logPrediction } from './store.js';

type PoolPlanLike = { kwhPerDay: number; hours: number; boostHours: number; uvKwh: number; schedules: Array<{ start: number; stop: number; rpm: number }> };
/**
 * The pool cron's prediction for tomorrow: the plan's kWh/day (pump schedule × the pump curve, plus the UV lamp), with the schedule
 * it assumes so the nightly scoring can measure the same hours from pool readings. Off mode plans nothing, so it logs nothing.
 */
export function logPoolPlan(siteId: string, o: { mode: string; date: string; plan: PoolPlanLike; signals: { waterTemp: number; high: number; sunKwhM2: number; rainMm: number };
  settings: { filterRpm: number; boostRpm: number } }) {
  if (o.mode === 'off') return Promise.resolve(0);
  return logPrediction(siteId, { model: 'pool.kwhDay', day: o.date, value: o.plan.kwhPerDay, inputs: {
    mode: o.mode, hours: o.plan.hours, boostHours: o.plan.boostHours, sched: o.plan.schedules.map(s => [s.start, s.stop, s.rpm]), uvKwh: o.plan.uvKwh,
    filterRpm: o.settings.filterRpm, boostRpm: o.settings.boostRpm, waterTemp: o.signals.waterTemp, high: o.signals.high, sunKwhM2: o.signals.sunKwhM2, rainMm: o.signals.rainMm } })
    .catch(e => { console.warn(`[learn] pool prediction not logged: ${e?.message ?? e}`); return 0; });
}
