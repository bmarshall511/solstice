// Anomaly rules (docs/audit-designs/learning-layer.md §6), pure. Each reads the daily metrics the nightly job keeps and says, per kind,
// whether the anomaly fires, clears (its auto-close condition holds), holds (neither) or waits for data. The engine in nightly.ts
// opens, updates and resolves rows in `anomalies` from these verdicts.
//
// Pump physics, as the design's judge corrected it: an IntelliFlo in speed mode holds its RPM, and a centrifugal pump at a fixed
// speed draws LESS power when flow is restricted (a loaded D.E. filter, a full basket, a partly closed valve) and MORE when flow
// rises (a valve moved to waterfall, spa or cleaner) or the motor drags (bearings). Both are compared with a clean-filter
// baseline that a curve refit can never move, so a slow drift can't hide itself.
import { mean, median, round } from './models.js';
import { SOLAR as SYSTEM } from '../system.js';

export type Severity = 'info' | 'warn' | 'high';
export type AnomalyDetail = { title: string; body: string; expected?: number | null; measured?: number | null; unit?: string; threshold?: string;
  persisted?: string; confound?: string; action?: 'filter_cleaned' | 'open_pool' | 'open_panels' | 'open_ac' | 'snooze'; lastSeen?: string; [k: string]: unknown };
export type Verdict = { kind: string; state: 'fire' | 'clear' | 'hold' | 'wait'; severity: Severity; detail: AnomalyDetail };
export type OpenAnomaly = { id: number; kind: string; day: string; severity: string; detail: AnomalyDetail };
/** day → metric → value (daily_metrics, not scores). */
export type MetricsByDay = Map<string, Record<string, number>>;
export type RuleCtx = { days: string[]; m: MetricsByDay; open: Map<string, OpenAnomaly>; pumpBaseline: Record<string, { watts: number; n: number }>;
  expectedBuckets: (day: string) => number;
  /** B2-12 (d): each parsed bill's meter-vs-Tesla import gap (% of the billed kWh), oldest first; bills Tesla covered ≥ 90% of only. */
  billGaps?: Array<{ to: string; gapPct: number }> };

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

/* ---------- one panel below the median panel (mockup u-panels; metrics from panels.ts panelMetrics) ---------- */
// A producing day: the array made ≥ 15 kWh and the panel reported in ≥ 90% of the day's daylight polls; other days are skipped, not
// counted as good. Fires when the panel is under 85% of the median panel on 5 of its last 7 producing days; clears after 3 producing
// days in a row at ≥ 90%. One kind per position: panel.low@r2c7.
export type PanelDiag = { kind: 'light' | 'inverter' | 'unclear'; lead: string; text: string };
/** The mockup's diagnosis from DC in vs AC out: low DC in = less light reaches the panel; normal DC but AC under 90% of DC = the microinverter. */
export function panelDiagnosis(dcRatio: number | null, conv: number | null): PanelDiag | null {
  if (dcRatio == null || !Number.isFinite(dcRatio)) return null;
  if (dcRatio < .9) return { kind: 'light', lead: 'DC in is low too',
    text: ', and the microinverter converts what it gets as well as its neighbours do, so less light is reaching this panel. Look for a new shadow or a patch of dirt or droppings. A failing microinverter would show normal DC in with low AC out.' };
  if (conv != null && conv < .9) return { kind: 'inverter', lead: 'DC in is normal but AC out is not',
    text: `: the microinverter passes on only ${Math.round(conv * 100)}% of what the panel gives it, so the microinverter is losing it. Shade or dirt would lower DC in as well.` };
  return { kind: 'unclear', lead: 'DC in and conversion both look normal right now',
    text: ', so the loss comes and goes. Watch it through a sunny afternoon: a shadow that moves across it, or a connection that drops out, would do this.' };
}

export const PANEL = { low: .85, ok: .9, window: 7, fireDays: 5, clearDays: 3, arrayKwh: 15, cov: .9 };
const PANEL_ID = /^pvs\.(r[1-3]c(?:10|[1-9]))\.ratio$/;
const dow = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }).slice(0, 2);
export function panelRules(c: RuleCtx): Verdict[] {
  const ids = new Set<string>();
  for (const d of c.days) for (const k of Object.keys(c.m.get(d) ?? {})) { const m = PANEL_ID.exec(k); if (m) ids.add(m[1]); }
  for (const k of c.open.keys()) if (k.startsWith('panel.low@')) ids.add(k.slice('panel.low@'.length));
  if (!ids.size) return [];
  const arrayDays = c.days.filter(d => (val(c.m, d, 'pvs.array_kwh') ?? 0) >= PANEL.arrayKwh);
  const out: Verdict[] = [];
  let most = 0;
  for (const id of [...ids].sort()) {
    const kind = `panel.low@${id}`, open = c.open.get(kind), [, row, col] = /^r(\d)c(\d+)$/.exec(id)!, name = `Row ${row} · ${col}`;
    const prod = arrayDays.filter(d => (val(c.m, d, `pvs.${id}.cov`) ?? 0) >= PANEL.cov && has(val(c.m, d, `pvs.${id}.ratio`)));
    most = Math.max(most, prod.length);
    const last = prod.slice(-PANEL.window), ratios = last.map(d => val(c.m, d, `pvs.${id}.ratio`)!);
    const nLow = ratios.filter(r => r < PANEL.low).length, back = ratios.slice(-PANEL.clearDays);
    const cleared = back.length === PANEL.clearDays && back.every(r => r >= PANEL.ok);
    const fire = nLow >= PANEL.fireDays;
    if (!fire) { out.push({ kind, state: open && cleared ? 'clear' : 'hold', severity: 'warn', detail: open?.detail ?? { title: `${name} is running low`, body: '' } }); continue; }
    const ld = last.at(-1)!, lastPct = Math.round(ratios.at(-1)! * 100);
    const dc = val(c.m, ld, `pvs.${id}.dc`), ac = val(c.m, ld, `pvs.${id}.ac`), mdc = val(c.m, ld, 'pvs.median_dc'), mconv = val(c.m, ld, 'pvs.median_conv');
    const conv = has(dc) && dc > .01 && has(ac) ? ac / dc : null;
    const detail: AnomalyDetail = { title: `${name} is running low`, action: 'open_panels', unit: '% of median', expected: 100, measured: lastPct,
      threshold: `under ${Math.round(PANEL.low * 100)}% of the median panel on ${PANEL.fireDays} of the last ${PANEL.window} producing days`,
      persisted: `${nLow} of the last ${last.length} producing days`, confound: `producing days only: array ≥ ${PANEL.arrayKwh} kWh and the panel reporting ≥ ${PANEL.cov * 100}% of daylight polls`,
      body: `${lastPct}% of the median panel on ${niceDay(ld)}, and under ${Math.round(PANEL.low * 100)}% on ${nLow} of the last ${last.length} producing days. Shade, soiling or a failing microinverter.`,
      row: +row, col: +col, nLow, window: last.length, lastDay: ld,
      days: last.map((d, i) => ({ day: d, pct: Math.round(ratios[i] * 100), label: `${dow(d)} ${+d.slice(8)}` })),
      dcKw: has(dc) ? round(dc, 3) : null, acKw: has(ac) ? round(ac, 3) : null, medianDcKw: has(mdc) ? round(mdc, 3) : null,
      convPct: conv == null ? null : Math.round(conv * 100), medianConvPct: has(mconv) ? Math.round(mconv * 100) : null,
      diag: panelDiagnosis(has(dc) && has(mdc) && mdc > 0 ? dc / mdc : null, conv) };
    out.push({ kind, state: 'fire', severity: 'warn', detail });
  }
  if (most < PANEL.fireDays) out.push({ kind: 'panel.low', state: 'wait', severity: 'warn',
    detail: { title: 'Waiting for producing days', body: `Per-panel checks need ${PANEL.fireDays} producing days (array ≥ ${PANEL.arrayKwh} kWh, panel reporting ≥ 90% of daylight polls); the best panel has ${most}.` } });
  return out;
}

/* ---------- data-quality cross-checks (B2-12, idea I-10) ---------- */
/** A five-minute solar bucket above what the microinverters can deliver (9.45 kW AC × 5 min, +5%) is Tesla's bucket inflation, not output. */
export const INFLATED_WH = SYSTEM.acKw * 1000 * 5 / 60 * 1.05;

/** (a) The panels' own daily kWh (PVS, summed per panel) against Tesla's solar kWh: their ratio drifting from its usual value. */
export const PVS_DRIFT = { tol: .04, recent: 4, fire: 3, clear: 3, ref: 30, minRef: 10, polls: .9, minKwh: 5 };
export function pvsDriftRule(c: RuleCtx): Verdict {
  const kind = 'data.pvs_drift';
  const polls = c.days.map(d => val(c.m, d, 'pvs.polls')).filter(has), usualPolls = polls.length ? median(polls) : 0;
  // full PVS coverage only: the relay reported through ≥ 90% of a usual day's daylight polls (a silent stretch undercounts the panels)
  const pts = c.days.map(d => ({ d, pvs: val(c.m, d, 'pvs.array_kwh'), tesla: val(c.m, d, 'solar.kwh'), polls: val(c.m, d, 'pvs.polls') }))
    .filter(x => has(x.pvs) && has(x.tesla) && x.tesla! >= PVS_DRIFT.minKwh && (x.polls ?? 0) >= PVS_DRIFT.polls * usualPolls)
    .map(x => ({ d: x.d, pvs: x.pvs!, tesla: x.tesla!, r: x.pvs! / x.tesla! }));
  const recent = pts.slice(-PVS_DRIFT.recent), ref = pts.slice(-(PVS_DRIFT.recent + PVS_DRIFT.ref), -PVS_DRIFT.recent);
  if (recent.length < PVS_DRIFT.recent || ref.length < PVS_DRIFT.minRef)
    return { kind, state: 'wait', severity: 'info', detail: { title: 'Waiting for panel-level days', body: `Needs ${PVS_DRIFT.recent + PVS_DRIFT.minRef} days with full per-panel readings and Tesla solar (has ${pts.length}).` } };
  const usual = median(ref.map(x => x.r)), dev = recent.map(x => x.r / usual - 1), nOff = dev.filter(v => Math.abs(v) > PVS_DRIFT.tol).length;
  const last = recent.at(-1)!, apart = (r: number) => Math.round(Math.abs(r - 1) * 1000) / 10;
  const detail: AnomalyDetail = { title: 'Panels and Tesla disagree on solar', unit: '% apart', expected: apart(usual), measured: apart(last.r),
    threshold: `more than ${PVS_DRIFT.tol * 100}% off the usual ratio on ${PVS_DRIFT.fire} of ${PVS_DRIFT.recent} days`, persisted: `${nOff} of the last ${recent.length} covered days`,
    confound: 'full per-panel days only (the relay reporting through 90% of a usual day)',
    body: `Panels (PVS) ${round(last.pvs)} kWh vs Tesla ${round(last.tesla)} kWh on ${niceDay(last.d)}, ${apart(last.r)}% apart (usually ${apart(usual)}%). One of the two meters may be drifting, or a panel isn't reporting.` };
  return { kind, state: nOff >= PVS_DRIFT.fire ? 'fire' : dev.slice(-PVS_DRIFT.clear).every(v => Math.abs(v) <= PVS_DRIFT.tol) ? 'clear' : 'hold', severity: 'info', detail };
}

/** (b) Solar buckets above the inverter limit (metric energy.inflated, counted nightly; peaks leave them out). */
export const INFLATED = { window: 7, fire: 3, clear: 3 };
export function inflatedRule(c: RuleCtx): Verdict {
  const kind = 'data.solar_inflated', days = c.days.filter(d => has(val(c.m, d, 'energy.inflated'))).slice(-INFLATED.window);
  if (days.length < INFLATED.clear) return { kind, state: 'wait', severity: 'info', detail: { title: 'Waiting for solar history', body: 'Needs a few days of 5-minute solar history.' } };
  const n = days.map(d => val(c.m, d, 'energy.inflated')!), hit = n.filter(v => v > 0).length, total = n.reduce((a, v) => a + v, 0);
  return { kind, state: hit >= INFLATED.fire ? 'fire' : n.slice(-INFLATED.clear).every(v => v === 0) ? 'clear' : 'hold', severity: 'info',
    detail: { title: 'Tesla’s 5-minute solar reads above the inverter limit', unit: 'buckets', expected: 0, measured: total,
      threshold: `buckets over ${SYSTEM.acKw} kW (+5%) on ${INFLATED.fire} of ${INFLATED.window} days`, persisted: `${hit} of the last ${days.length} days`,
      body: `${total} five-minute solar bucket${total === 1 ? '' : 's'} on ${hit} of the last ${days.length} days read above the ${SYSTEM.acKw} kW the microinverters can deliver. That is Tesla's bucketing, not real output; peak figures leave those buckets out.` } };
}

/** (c) Battery % jumps of more than 10 points between consecutive readings with almost no energy in or out (metric soe.jumps). */
export const SOC_JUMP = { clear: 3 };
export function socJumpRule(c: RuleCtx): Verdict {
  const kind = 'data.soc_jump', days = c.days.filter(d => has(val(c.m, d, 'soe.jumps'))), last = days.slice(-SOC_JUMP.clear);
  if (!last.length) return { kind, state: 'wait', severity: 'info', detail: { title: 'Waiting for battery history', body: 'Needs a day of Powerwall charge readings.' } };
  const n = last.map(d => val(c.m, d, 'soe.jumps')!), y = days.at(-1)!, ny = val(c.m, y, 'soe.jumps')!;
  return { kind, state: ny > 0 ? 'fire' : n.every(v => v === 0) && last.length === SOC_JUMP.clear ? 'clear' : 'hold', severity: 'info',
    detail: { title: 'Powerwall charge jumped without energy', unit: 'jumps', expected: 0, measured: ny, threshold: 'over 10 points between readings with under 0.3 kWh in or out',
      persisted: `${n.filter(v => v > 0).length} of the last ${last.length} days`,
      body: `The Powerwall charge jumped more than 10 points between two readings ${ny > 0 ? `${ny} time${ny === 1 ? '' : 's'} on ${niceDay(y)}` : 'recently'} while almost no energy went in or out. That is a reporting glitch (often after a firmware update or a recalibration), not real charge; forecasts that start from it may be off for a day.` } };
}

/** (d) The PEC meter and Tesla drifting apart bill after bill: the slope of the import gap over the last 6 bills. */
export const METER_GAP = { bills: 6, min: 3, fire: 1, clear: .5 };
export function meterGapRule(c: RuleCtx): Verdict {
  const kind = 'data.meter_drift', g = (c.billGaps ?? []).slice(-METER_GAP.bills);
  if (g.length < METER_GAP.min) return { kind, state: 'wait', severity: 'warn', detail: { title: 'Waiting for bills', body: `Needs ${METER_GAP.min} parsed bills that Tesla covered (has ${g.length}).` } };
  const xs = g.map((_, i) => i), ys = g.map(x => x.gapPct), mx = mean(xs), my = mean(ys);
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const first = g[0], last = g.at(-1)!, abs = Math.abs(slope);
  return { kind, state: abs > METER_GAP.fire ? 'fire' : abs <= METER_GAP.clear ? 'clear' : 'hold', severity: 'warn',
    detail: { title: 'PEC’s meter and Tesla are drifting apart', unit: '% a bill', expected: 0, measured: round(slope, 2), threshold: `more than ${METER_GAP.fire} point a bill over the last ${METER_GAP.bills} bills`,
      persisted: `${g.length} bills`, confound: 'kWh bought, Tesla over the same dates (bills Tesla covered ≥ 90%)',
      body: `The gap between PEC's meter and Tesla went from ${first.gapPct > 0 ? '+' : ''}${round(first.gapPct)}% to ${last.gapPct > 0 ? '+' : ''}${round(last.gapPct)}% over ${g.length} bills (about ${round(abs, 1)} points a bill). A steady drift points at one of the two meters (or Tesla's grid sensor), not at how much you used.` } };
}

/** Every rule, in one list of verdicts. */
export const evaluateRules = (c: RuleCtx): Verdict[] => [...pumpRules(c), acOverrunRule(c), solarStepRule(c), alwaysOnRule(c), ...dataGapRules(c), ...panelRules(c),
  pvsDriftRule(c), inflatedRule(c), socJumpRule(c), meterGapRule(c)];
