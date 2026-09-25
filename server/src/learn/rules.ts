// Anomaly rules (docs/audit-designs/learning-layer.md §6), pure. Each reads the daily metrics the nightly job keeps and says, per kind,
// whether the anomaly fires, clears (its auto-close condition holds), holds (neither) or waits for data. The engine in nightly.ts
// opens, updates and resolves rows in `anomalies` from these verdicts.
//
// Pump physics, as the design's judge corrected it: an IntelliFlo in speed mode holds its RPM, and a centrifugal pump at a fixed
// speed draws LESS power when flow is restricted (a loaded D.E. filter, a full basket, a partly closed valve) and MORE when flow
// rises (a valve moved to waterfall, spa or cleaner) or the motor drags (bearings). Both are compared with a clean-filter
// baseline that a curve refit can never move, so a slow drift can't hide itself.
import { mean, median, round } from './models.js';

export type Severity = 'info' | 'warn' | 'high';
export type AnomalyDetail = { title: string; body: string; expected?: number | null; measured?: number | null; unit?: string; threshold?: string;
  persisted?: string; confound?: string; action?: 'filter_cleaned' | 'open_pool' | 'open_panels' | 'open_ac' | 'snooze'; lastSeen?: string; [k: string]: unknown };
export type Verdict = { kind: string; state: 'fire' | 'clear' | 'hold' | 'wait'; severity: Severity; detail: AnomalyDetail };
export type OpenAnomaly = { id: number; kind: string; day: string; severity: string; detail: AnomalyDetail };
/** day → metric → value (daily_metrics, not scores). */
export type MetricsByDay = Map<string, Record<string, number>>;
export type RuleCtx = { days: string[]; m: MetricsByDay; open: Map<string, OpenAnomaly>; pumpBaseline: Record<string, { watts: number; n: number }>;
  expectedBuckets: (day: string) => number };

const val = (m: MetricsByDay, d: string, k: string) => m.get(d)?.[k];
const has = (v: number | undefined): v is number => v != null && Number.isFinite(v);
const niceDay = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const pct = (r: number) => Math.round(Math.abs(r - 1) * 100);
const hm = (min: number) => `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} m`;

/* ---------- pump watts vs the clean-filter baseline ---------- */
export const PUMP = { below: .88, above: 1.12, within: .05, window: 5, fireDays: 3, minReadings: 3 };
export function pumpRules(c: RuleCtx): Verdict[] {
  return Object.entries(c.pumpBaseline).flatMap(([rpm, b]): Verdict[] => {
    const covered = c.days.filter(d => (val(c.m, d, `pool.w@${rpm}.n`) ?? 0) >= PUMP.minReadings && has(val(c.m, d, `pool.w@${rpm}`))).slice(-PUMP.window);
    const watts = covered.map(d => val(c.m, d, `pool.w@${rpm}`)!), ratio = watts.map(w => w / b.watts);
    const r = Number(rpm).toLocaleString('en-US'), measured = watts.length ? Math.round(median(watts)) : null, med = measured != null ? measured / b.watts : 1;
    const common = { expected: Math.round(b.watts), measured, unit: 'W', persisted: '', rpm: Number(rpm) };
    if (covered.length < PUMP.fireDays) return (['below', 'above'] as const).map((k): Verdict => ({ kind: `pump.${k}_baseline@${rpm}`, state: 'wait', severity: 'warn',
      detail: { title: 'Waiting for pump readings', body: `Needs ${PUMP.fireDays} days with ${PUMP.minReadings}+ readings at ${r} RPM.`, ...common } }));
    const settled = ratio.slice(-3).every(x => Math.abs(x - 1) <= PUMP.within);
    const nBelow = ratio.filter(x => x <= PUMP.below).length, nAbove = ratio.filter(x => x >= PUMP.above).length;
    return [
      { kind: `pump.below_baseline@${rpm}`, state: nBelow >= PUMP.fireDays ? 'fire' : settled ? 'clear' : 'hold', severity: 'warn',
        detail: { ...common, title: 'Pump running softer than its clean baseline', action: 'filter_cleaned', threshold: `≤ ${Math.round(b.watts * PUMP.below)} W · 88% of baseline`,
          persisted: `${nBelow} of the last ${covered.length} covered days`, confound: 'speed held by the controller; compared at the same RPM',
          body: `Pump drawing ${pct(med)}% less than its clean-filter baseline at ${r} RPM: it is moving less water. A loaded D.E. filter, a full basket or a partly closed valve does this.` } },
      { kind: `pump.above_baseline@${rpm}`, state: nAbove >= PUMP.fireDays ? 'fire' : settled ? 'clear' : 'hold', severity: 'info',
        detail: { ...common, title: 'Pump working harder than its clean baseline', action: 'snooze', threshold: `≥ ${Math.round(b.watts * PUMP.above)} W · 112% of baseline`,
          persisted: `${nAbove} of the last ${covered.length} covered days`, confound: 'speed held by the controller; compared at the same RPM',
          body: `Pump drawing ${pct(med)}% more at ${r} RPM: it is moving more water than usual (a valve moved to waterfall, spa or cleaner) or the motor is dragging.` } },
    ];
  });
}

/* ---------- AC runtime vs outdoor degree-hours ---------- */
export const OVERRUN = { fitDays: 30, minFit: 21, ratio: 1.3, minOverMin: 60, madK: 1.5, within: .15, setpointDropF: 2 };
/** OLS runtime = a + b · degreeHours, with the median absolute deviation of the residuals. */
export function fitRuntime(pts: Array<{ dh: number; rt: number }>) {
  const mx = mean(pts.map(p => p.dh)), my = mean(pts.map(p => p.rt)), sxx = pts.reduce((a, p) => a + (p.dh - mx) ** 2, 0);
  const b = sxx ? pts.reduce((a, p) => a + (p.dh - mx) * (p.rt - my), 0) / sxx : 0, a = my - b * mx;
  const res = pts.map(p => p.rt - (a + b * p.dh)), mr = median(res);
  return { a, b, mad: median(res.map(r => Math.abs(r - mr))), n: pts.length };
}
export function acOverrunRule(c: RuleCtx): Verdict {
  const kind = 'ac.overrun', last3 = c.days.slice(-3), fitTo = c.days.at(-4) ?? '';
  const pt = (d: string) => ({ d, rt: val(c.m, d, 'ac.runtime_min'), dh: val(c.m, d, 'ac.degree_hours'), sp: val(c.m, d, 'ac.cool_f'), high: val(c.m, d, 'wx.high_f') });
  const fitPts = c.days.filter(d => d <= fitTo).map(pt).filter(p => has(p.rt) && has(p.dh)).slice(-OVERRUN.fitDays) as Array<{ d: string; rt: number; dh: number }>;
  const recent = last3.map(pt).filter(p => has(p.rt) && has(p.dh)) as Array<{ d: string; rt: number; dh: number; high?: number }>;
  if (fitPts.length < OVERRUN.minFit || recent.length < 3)
    return { kind, state: 'wait', severity: 'warn', detail: { title: 'Waiting for AC run-time history', body: `The run-time model needs ${OVERRUN.minFit} days with Nest readings and outdoor temperatures (has ${fitPts.length}).` } };
  const f = fitRuntime(fitPts), exp = recent.map(p => Math.max(0, f.a + f.b * p.dh));
  const over = recent.map((p, i) => p.rt > OVERRUN.ratio * exp[i] && p.rt - exp[i] > Math.max(OVERRUN.minOverMin, OVERRUN.madK * f.mad));
  const sp = (ds: string[]) => ds.map(d => val(c.m, d, 'ac.cool_f')).filter(has);
  const i = c.days.length, spNow = sp(c.days.slice(i - 7)), spBefore = sp(c.days.slice(i - 14, i - 7));
  const dropped = spNow.length >= 3 && spBefore.length >= 3 && median(spNow) <= median(spBefore) - OVERRUN.setpointDropF;
  const n = over.filter(Boolean).length, worst = recent.reduce((w, p, k) => p.rt - exp[k] > w.gap ? { gap: p.rt - exp[k], k } : w, { gap: -Infinity, k: 0 });
  const p = recent[worst.k], high = val(c.m, p.d, 'wx.high_f');
  const detail: AnomalyDetail = { title: 'AC ran longer than expected', action: 'snooze', unit: 'min', expected: Math.round(exp[worst.k]), measured: Math.round(p.rt),
    threshold: `> ${Math.max(OVERRUN.minOverMin, Math.round(OVERRUN.madK * f.mad))} min over and ${OVERRUN.ratio}× expected`, persisted: `${n} of the last 3 days`,
    confound: dropped ? `setpoint lowered ${round(median(spBefore) - median(spNow))}° this week, so the extra run time is expected` : 'setpoint steady this week',
    body: `AC ran ${hm(Math.max(0, p.rt - exp[worst.k]))} longer than your model expects${has(high) ? ` for a ${Math.round(high)}° day` : ''}. Filter, refrigerant charge or a door left open.`,
    fit: { a: round(f.a), b: round(f.b, 3), mad: round(f.mad), n: f.n } };
  if (n >= 2 && !dropped) return { kind, state: 'fire', severity: 'warn', detail };
  return { kind, state: recent.every((q, k) => Math.abs(q.rt - exp[k]) <= OVERRUN.within * Math.max(exp[k], 1)) ? 'clear' : 'hold', severity: 'warn', detail };
}

/* ---------- solar output vs the sun (clear-day yield) ---------- */
export const SOLAR = { clearGti: 4.5, dryMm: 1, recent: 3, prior: 14, drop: .85, back: .95, backDays: 2 };
export function solarStepRule(c: RuleCtx): Verdict {
  const kind = 'solar.step_down', open = c.open.get(kind);
  const clear = c.days.map(d => ({ d, s: val(c.m, d, 'solar.kwh'), g: val(c.m, d, 'wx.gti'), rain: val(c.m, d, 'wx.rain_mm') ?? 0 }))
    .filter(x => has(x.s) && has(x.g) && x.g! >= SOLAR.clearGti && x.rain < SOLAR.dryMm && x.s! > 0).map(x => ({ d: x.d, r: x.s! / x.g! }));
  if (open) { // close against the reference taken when it opened, not a window that now includes the low days
    const ref = Number(open.detail.expected), back = clear.slice(-SOLAR.backDays);
    return { kind, state: back.length === SOLAR.backDays && back.every(x => x.r >= SOLAR.back * ref) ? 'clear' : 'hold', severity: 'high', detail: open.detail };
  }
  if (clear.length < SOLAR.recent + SOLAR.prior)
    return { kind, state: 'wait', severity: 'high', detail: { title: 'Waiting for clear days', body: `Needs ${SOLAR.recent + SOLAR.prior} clear, dry days (has ${clear.length}).` } };
  const last = clear.slice(-SOLAR.recent), prior = clear.slice(-(SOLAR.recent + SOLAR.prior), -SOLAR.recent);
  const now = median(last.map(x => x.r)), ref = median(prior.map(x => x.r));
  return { kind, state: now <= SOLAR.drop * ref ? 'fire' : 'hold', severity: 'high', detail: { title: 'Solar output dropped in a step', action: 'open_panels', unit: 'kWh per kWh/m²',
    expected: round(ref, 2), measured: round(now, 2), threshold: '≤ 85% of the prior 14 clear days', persisted: `${SOLAR.recent} clear days`, confound: 'clear, dry days only (no rain, no clouds)',
    body: `Output dropped ${pct(now / ref)}% in a step since ${niceDay(last[0].d)}: a section of the array may be out (a microinverter or a breaker).` } };
}

/* ---------- always-on load (1–5 AM, AC taken out) ---------- */
export const ALWAYS_ON = { recent: 7, ref: 30, minRef: 14, ratio: 1.15, minKw: .15, persist: 3, within: .08 };
export function alwaysOnRule(c: RuleCtx): Verdict {
  const kind = 'home.always_on_step', open = c.open.get(kind);
  const nights = c.days.map(d => ({ d, v: val(c.m, d, 'home.alwaysOn_kw') })).filter(x => has(x.v)) as Array<{ d: string; v: number }>;
  const at = (end: number) => { // the 7-night mean ending at nights[end] against the median of up to 30 nights before them
    const rec = nights.slice(Math.max(0, end - ALWAYS_ON.recent + 1), end + 1), ref = nights.slice(Math.max(0, end - ALWAYS_ON.recent - ALWAYS_ON.ref + 1), end - ALWAYS_ON.recent + 1);
    return rec.length === ALWAYS_ON.recent && ref.length >= ALWAYS_ON.minRef ? { now: mean(rec.map(x => x.v)), ref: median(ref.map(x => x.v)) } : null;
  };
  const last = nights.length - 1, cur = at(last);
  if (open) { const ref = Number(open.detail.expected) / 1000, now = cur?.now ?? null;
    return { kind, state: now != null && Math.abs(now - ref) <= ALWAYS_ON.within * ref ? 'clear' : 'hold', severity: 'warn', detail: open.detail }; }
  if (!cur) return { kind, state: 'wait', severity: 'warn', detail: { title: 'Waiting for nights', body: `Needs ${ALWAYS_ON.recent + ALWAYS_ON.minRef} nights of 1–5 AM readings (has ${nights.length}).` } };
  const up = (x: { now: number; ref: number } | null) => !!x && x.now >= ALWAYS_ON.ratio * x.ref && x.now - x.ref >= ALWAYS_ON.minKw;
  const n = [0, 1, 2].filter(k => up(at(last - k))).length;
  return { kind, state: n === ALWAYS_ON.persist ? 'fire' : 'hold', severity: 'warn', detail: { title: 'Always-on load stepped up', action: 'snooze', unit: 'W',
    expected: Math.round(cur.ref * 1000), measured: Math.round(cur.now * 1000), threshold: '≥ 115% and +150 W over the 30-night median', persisted: `${n} of the last 3 nights`,
    confound: 'AC run time taken out of the 1–5 AM load',
    body: `Your 1–5 AM baseline went from ${Math.round(cur.ref * 1000)} W to ${Math.round(cur.now * 1000)} W over the last week and stayed there: something new is running around the clock.` } };
}

/* ---------- data gaps ---------- */
export const GAPS = { energyShort: 12, energyOk: 2, low: .5, ok: .8 };
export function dataGapRules(c: RuleCtx): Verdict[] {
  const y = c.days.at(-1)!, prior = c.days.slice(-8, -1);
  const out: Verdict[] = [];
  const exp = c.expectedBuckets(y), got = val(c.m, y, 'energy.buckets') ?? 0, active = prior.some(d => (val(c.m, d, 'energy.buckets') ?? 0) > 0);
  out.push(!active ? { kind: 'data.gap.energy', state: 'wait', severity: 'warn', detail: { title: 'No energy history yet', body: 'Waiting for Tesla history.' } }
    : { kind: 'data.gap.energy', state: got < exp - GAPS.energyShort ? 'fire' : got >= exp - GAPS.energyOk ? 'clear' : 'hold', severity: 'warn',
      detail: { title: 'Energy history has a gap', expected: exp, measured: got, unit: 'buckets', threshold: `fewer than ${exp - GAPS.energyShort} of ${exp} five-minute buckets`,
        body: `Tesla's 5-minute history for ${niceDay(y)} has ${got} of ${exp} buckets: about ${round((exp - got) / 12)} h missing. The nightly sync re-fetches short days.` } });
  for (const [src, label] of [['soe', 'Powerwall charge readings'], ['nest', 'Nest readings'], ['pool', 'Pool readings']] as const) {
    const base = prior.map(d => val(c.m, d, `${src}.n`) ?? 0).filter(v => v > 0), n = val(c.m, y, `${src}.n`) ?? 0;
    const kind = `data.gap.${src}`;
    if (base.length < 3) { out.push({ kind, state: 'wait', severity: 'info', detail: { title: `No ${label.toLowerCase()} yet`, body: 'Nothing to compare with.' } }); continue; }
    const typical = median(base);
    out.push({ kind, state: n < GAPS.low * typical ? 'fire' : n >= GAPS.ok * typical ? 'clear' : 'hold', severity: 'info',
      detail: { title: `${label} dropped off`, expected: Math.round(typical), measured: n, unit: 'readings', threshold: 'under half the usual daily count',
        body: `${label} for ${niceDay(y)}: ${n}, against ${Math.round(typical)} on a usual day. Check the link in Settings.` } });
  }
  return out;
}

/** Every rule, in one list of verdicts. */
export const evaluateRules = (c: RuleCtx): Verdict[] => [...pumpRules(c), acOverrunRule(c), solarStepRule(c), alwaysOnRule(c), ...dataGapRules(c)];
