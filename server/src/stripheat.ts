// Strip-heat watch (I-15, approved mockup am frames 6 and 7). Pure: no database, no device, no network. Advice only: nothing here
// (or in stripwatch.ts, which feeds it) writes to the thermostat or changes an Autopilot mode.
//
// From Tesla's 5-minute home load (kW = Wh × 12 / 1000) a morning's heating is split into the compressor and the electric strips:
//   excess      = the bucket's kW (capped at the year's p99.5, so one inflated bucket can't make a run) − the night's always-on base
//                 − the pool pump's draw
//   heating     = the learned heating step (ac.ts acStepsFrom, `heatKw`): under 5 kW it is a heat pump's compressor with strips on top;
//                 5 kW or more is a straight AC heating on the strips alone; "learning" until 5 heating steps exist (the owner's choice:
//                 the system type is not known, so it is detected)
//   stage       = the strip stage size: the first peak of the histogram of (excess − compressor) while Nest says HEATING; until a peak
//                 is learned the threshold is a flat 6 kW
//   strip bucket= with Nest: HEATING (each reading held up to 20 min, like breakdown.ts acMask) and excess ≥ compressor + 0.8 × stage
//                 (a straight AC: every heating bucket is strips; ≥ 1.6 × heatKw means stages stacked). Energy only (last winter, or Nest
//                 offline): 04:00–10:00, the hour's outdoor temperature under 50 °F and excess ≥ 6 kW.
//                 A bucket only counts inside a pair: two consecutive buckets both over the line, scored by min(bᵢ, bᵢ₊₁), so a single
//                 spike (an oven door, a kettle on top of the compressor) never makes a run.
//   the day     = strip kWh Σ(excess − compressor)/12 over strip buckets, strip minutes, heat-pump minutes (heating, not strips), the peak
//                 strip kW; the cause of each run: "setback" when the heat setpoint rose 2 °F or more in the hour before it (a recovery),
//                 "cold" when outside was below the balance point with no setpoint change, "both"; energy-only causes are guesses.
//   badge       = measured (Nest HEATING + learned levels + heat_f), estimated (energy only, or levels still the defaults), learning
//                 (fewer than 5 heating steps).
import { rfc3339, localAt, addDays } from './tesla/client.js';

/** Learned heating kW under this is a heat pump's compressor; at or over it, a straight AC heating on the strips (owner, 2026-10-07). */
export const HEAT_PUMP_MAX_KW = 5;
/** Heating steps needed before the type is trusted (ac.ts needs the same 5 for heatKw itself). */
export const MIN_HEAT_SAMPLES = 5;
/** The strip threshold until a stage size is learned, and the energy-only threshold (kW above the base). */
export const DEFAULT_STRIP_KW = 6;
/** A bucket is strips at compressor + this share of one stage. */
export const STAGE_FRAC = .8;
/** A straight AC: this multiple of the first stage means a second stage stacked on. */
export const STACKED_X = 1.6;
/** Each Nest reading holds until the next for at most this long (winter sampling is every 15 minutes). */
export const CARRY_MS = 20 * 60_000;
/** The energy-only rule: the morning window (Chicago hours, [from, to)), the outdoor ceiling (°F). */
export const ENERGY_ONLY = { from: 4, to: 10, maxF: 50 } as const;
/** A setback recovery: the heat setpoint rose this much (°F) in the hour before a run. */
export const SETBACK_F = 2, SETBACK_LOOKBACK_MS = 3600_000;
/**
 * A heavy strip morning (the push, frame 7). These thresholds come from the back-test (backtest() below, run on a synthetic winter in
 * tests/server/stripheat.test.ts, and on last winter's energy-only days once stripwatch.ts has them); they are constants on purpose (no
 * Settings slider, owner's choice) and will be refit from real winter data once this winter's Nest heating samples exist.
 */
export const HEAVY_STRIP_KWH = 12;
/** The balance point (°F) until one is learned: the home model's heating change point (homeModel.ts `th`) when it has a heating term. */
export const DEFAULT_BALANCE_F = 40;
/** Buckets above the year's p99.5 are capped there before anything else. */
export const CAP_QUANTILE = .995;
/** The card's bars: 15-minute bars from 4 AM to noon (Chicago). */
export const CARD_HOURS = { from: 4, to: 12 } as const;
/** The card shows Nov–Mar, or whenever heating was seen in the last 7 days. */
export const WINTER_MONTHS: readonly number[] = [11, 12, 1, 2, 3];
/** The strip alert is evaluated once a day at 10:00 Chicago (minutes of the day, [from, to)): the morning window is over by then. */
export const ALERT_MINUTE = { from: 10 * 60, to: 10 * 60 + 15 } as const;

const B = 300_000;
const r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100;
/** Chicago hour of the day (0–23) of an epoch. */
export const hourOf = (ms: number) => +rfc3339(new Date(ms)).slice(11, 13);
const monthOf = (day: string) => +day.slice(5, 7);
export const winterDay = (day: string) => WINTER_MONTHS.includes(monthOf(day));

/* ---------- the heating type and its levels ---------- */
export type HeatingKind = 'heat-pump' | 'straight' | 'learning';
/** The heating type from the learned heating step (ac.ts learnAcKw: heatKw, heatSamples). */
export function heatingKind(l: { heatKw: number | null | undefined; heatSamples?: number | null }): HeatingKind {
  if (l.heatKw == null || (l.heatSamples ?? 0) < MIN_HEAT_SAMPLES) return 'learning';
  return l.heatKw < HEAT_PUMP_MAX_KW ? 'heat-pump' : 'straight';
}
export type Levels = { kind: HeatingKind; heatKw: number | null; compressorKw: number; stageKw: number; stages: number | null; stageLearned: boolean; capKw: number | null };
/**
 * The strip stage size from the excess while heating: a histogram of (excess − compressor) above 1.5 kW in 0.5 kW bins, smoothed over
 * three bins; a peak is a local maximum holding at least 4 values and a tenth of them. The first peak is one stage; the peaks are the
 * stages (at most 3). Needs 24 values (two hours of strips); null without a peak.
 */
export function stageSize(excess: readonly number[], compressorKw: number): { stageKw: number; stages: number } | null {
  const v = excess.map(x => x - compressorKw).filter(x => x > 1.5 && x < 30);
  if (v.length < 24) return null;
  const W = .5, n = Math.ceil(30 / W), h = Array(n).fill(0);
  for (const x of v) h[Math.min(n - 1, Math.floor(x / W))]++;
  const s = h.map((_, i) => (h[i - 1] ?? 0) + h[i] + (h[i + 1] ?? 0)), min = Math.max(4, v.length * .1), peaks: number[] = [];
  for (let i = 0; i < n; i++) if (s[i] >= min && s[i] > (s[i - 1] ?? 0) && s[i] >= (s[i + 1] ?? 0)) peaks.push(i);
  // merge peaks closer than 1.5 kW (one wide hump), keeping the taller
  const merged: number[] = [];
  for (const p of peaks) { const last = merged.at(-1); if (last != null && (p - last) * W < 1.5) { if (s[p] > s[last]) merged[merged.length - 1] = p; } else merged.push(p); }
  if (!merged.length) return null;
  const centre = (i: number) => { let a = 0, w = 0; for (let k = i - 1; k <= i + 1; k++) if (h[k]) { a += h[k] * (k + .5) * W; w += h[k]; } return w ? a / w : (i + .5) * W; };
  return { stageKw: r2(centre(merged[0])), stages: Math.min(3, merged.length) };
}
/** The levels for a kind: the compressor (0 unless a heat pump), the stage (a straight AC's first stage is its measured step). */
export function levelsFor(l: { heatKw: number | null | undefined; heatSamples?: number | null }, excessHeating: readonly number[] = [], capKw: number | null = null): Levels {
  const kind = heatingKind(l), heatKw = l.heatKw ?? null;
  if (kind === 'heat-pump') { const st = stageSize(excessHeating, heatKw!); return { kind, heatKw, compressorKw: heatKw!, stageKw: st?.stageKw ?? DEFAULT_STRIP_KW, stages: st?.stages ?? null, stageLearned: !!st, capKw }; }
  if (kind === 'straight') { const st = stageSize(excessHeating, 0); return { kind, heatKw, compressorKw: 0, stageKw: heatKw!, stages: st?.stages ?? null, stageLearned: true, capKw }; }
  return { kind, heatKw, compressorKw: 0, stageKw: DEFAULT_STRIP_KW, stages: null, stageLearned: false, capKw };
}
/** With nothing learned, the most strip heat is assumed to draw (kW): electric strips run 5–15 kW. */
export const STRIP_MAX_KW = 15;
/**
 * The most the heating can draw (kW), compressor and every strip stage, for the vacation watch's heating carve-out: the learned levels
 * (two stages at least), else the heating step plus STRIP_MAX_KW, else STRIP_MAX_KW plus a compressor's worth.
 */
export function heatingCeilingKw(lv: Pick<Levels, 'kind' | 'compressorKw' | 'stageKw' | 'stages' | 'stageLearned'> | null | undefined, heatKw: number | null = null) {
  if (lv && lv.kind !== 'learning' && lv.stageLearned) return r1(lv.compressorKw + lv.stageKw * Math.max(2, lv.stages ?? 2) + .5);
  return r1((heatKw != null && heatKw < HEAT_PUMP_MAX_KW ? heatKw : 4) + STRIP_MAX_KW);
}
/** The excess (kW above the base) at which a heating bucket is strips. */
export const stripLine = (lv: Pick<Levels, 'compressorKw' | 'stageKw' | 'stageLearned'>) => lv.stageLearned ? lv.compressorKw + STAGE_FRAC * lv.stageKw : DEFAULT_STRIP_KW;
/** "heat pump + 2 strip stages", "AC with strip heat (2 stages)", "learning (3 of 5 heating runs)". */
export function heatingLabel(lv: Pick<Levels, 'kind' | 'stages'>, heatSamples = 0) {
  if (lv.kind === 'learning') return `learning (${Math.min(heatSamples, MIN_HEAT_SAMPLES)} of ${MIN_HEAT_SAMPLES} heating runs)`;
  const st = lv.stages ? `${lv.stages} strip stage${lv.stages === 1 ? '' : 's'}` : 'strips';
  return lv.kind === 'heat-pump' ? `heat pump + ${st}` : `AC heating on ${st}`;
}

/** The year's p99.5 of the 5-minute home kW (the bucket cap); null with fewer than 288 buckets. */
export function capOf(kw: readonly number[]): number | null {
  if (kw.length < 288) return null;
  const s = [...kw].sort((a, b) => a - b); return r2(s[Math.min(s.length - 1, Math.floor(s.length * CAP_QUANTILE))]);
}

/* ---------- one morning ---------- */
export type Bucket = { epoch: number; kw: number };
export type NestRow = { ts: number; hvac: string; heatF: number | null };
export type Cause = 'setback' | 'cold' | 'both' | null;
export type Conf = 'measured' | 'estimated' | 'learning';
export type Run = { start: number; end: number; kwh: number; cause: Cause; setback: { fromF: number; toF: number; at: number } | null; outdoorF: number | null };
export type Quarter = { at: number; kw: number; cls: '' | 'hp' | 'st' };
export type DayStrip = { day: string; mode: 'nest' | 'energy'; stripKwh: number; stripMin: number; hpMin: number | null; stackedMin: number; peakKw: number | null; hpKw: number | null;
  cause: Cause; conf: Conf; runs: Run[]; setbackF: number | null; balanceF: number; quarters: Quarter[] };
export type DayInput = {
  day: string; buckets: readonly Bucket[]; baseKw: number; levels: Levels; balanceF: number;
  /** Nest readings around the day (from the evening before); null or too few: energy only. */
  nest?: readonly NestRow[] | null;
  /** The pool pump's draw in the bucket starting at `epoch` (kW). */
  poolKw?: (epoch: number) => number;
  /** The outdoor °F of the hour holding `epoch`, or null. */
  outdoorF?: (epoch: number) => number | null;
  /** Only buckets before this epoch (today's card so far, or the 10:00 alert). */
  until?: number;
};
/** Whether Nest said HEATING in the bucket at `start` (each reading held up to 20 minutes, like breakdown.ts acMask). */
export function heatingMask(rows: readonly NestRow[]) {
  const on: Array<[number, number]> = [];
  for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (r.hvac !== 'HEATING') continue; on.push([r.ts, Math.min(r.ts + CARRY_MS, rows[i + 1]?.ts ?? r.ts + CARRY_MS)]); }
  return (start: number) => on.some(([a, b]) => a < start + B && b > start);
}
/** Nest covers the morning when its readings (each held up to 20 min) cover 80% of 00:00 to the end of the card's window or `until`. */
export function nestCovers(rows: readonly NestRow[], from: number, to: number) {
  if (to <= from) return false;
  let ms = 0;
  for (let i = 0; i < rows.length; i++) { const a = Math.max(from, rows[i].ts), b = Math.min(to, rows[i].ts + CARRY_MS, rows[i + 1]?.ts ?? rows[i].ts + CARRY_MS); if (b > a) ms += b - a; }
  return ms >= .8 * (to - from);
}
/** The heat setpoint in force at `t` (the last reading at or before it with one). */
const heatAt = (rows: readonly NestRow[], t: number) => { let v: number | null = null; for (const r of rows) { if (r.ts > t) break; if (r.heatF != null) v = r.heatF; } return v; };
/** A recovery before a run starting at `t`: the setpoint an hour before against the highest one from then to 15 minutes into the run. */
export function setbackBefore(rows: readonly NestRow[], t: number): { fromF: number; toF: number; at: number } | null {
  const fromF = heatAt(rows, t - SETBACK_LOOKBACK_MS) ?? rows.find(r => r.ts > t - SETBACK_LOOKBACK_MS && r.heatF != null)?.heatF ?? null;
  if (fromF == null) return null;
  let toF = fromF, at = 0;
  for (const r of rows) if (r.ts > t - SETBACK_LOOKBACK_MS && r.ts <= t + 15 * 60_000 && r.heatF != null && r.heatF > toF) { toF = r.heatF; at ||= r.heatF - fromF >= SETBACK_F ? r.ts : 0; }
  return toF - fromF >= SETBACK_F ? { fromF: Math.round(fromF), toF: Math.round(toF), at } : null;
}
const combine = (cs: Cause[]): Cause => { const s = cs.some(c => c === 'setback' || c === 'both'), c = cs.some(x => x === 'cold' || x === 'both'); return s && c ? 'both' : s ? 'setback' : c ? 'cold' : null; };

/** One morning (the whole local day; strips outside the morning count too when Nest says HEATING). */
export function classifyDay(o: DayInput): DayStrip {
  const lv = o.levels, line = stripLine(lv), cap = lv.capKw ?? Infinity, pool = o.poolKw ?? (() => 0), out = o.outdoorF ?? (() => null);
  const from = localAt(o.day, 0), dayEnd = localAt(addDays(o.day, 1), 0), until = Math.min(dayEnd, o.until ?? dayEnd);
  const bs = o.buckets.filter(b => b.epoch >= from && b.epoch < until).sort((a, b) => a.epoch - b.epoch);
  const nest = [...(o.nest ?? [])].sort((a, b) => a.ts - b.ts);
  const mode: 'nest' | 'energy' = nest.length >= 2 && nestCovers(nest, from, Math.min(until, localAt(o.day, CARD_HOURS.to))) ? 'nest' : 'energy';
  const heating = heatingMask(nest);
  const ex = bs.map(b => Math.max(0, Math.min(b.kw, cap) - o.baseKw - pool(b.epoch)));
  const eligible = bs.map(b => {
    if (mode === 'nest') return heating(b.epoch);
    const h = hourOf(b.epoch), t = out(b.epoch);
    return h >= ENERGY_ONLY.from && h < ENERGY_ONLY.to && t != null && t < ENERGY_ONLY.maxF;
  });
  const thr = mode === 'nest' ? line : Math.max(DEFAULT_STRIP_KW, lv.kind === 'heat-pump' && lv.stageLearned ? line : 0);
  const pair = (i: number, j: number) => i >= 0 && j < bs.length && bs[j].epoch - bs[i].epoch === B && eligible[i] && eligible[j] && Math.min(ex[i], ex[j]) >= thr;
  const strip = bs.map((_, i) => pair(i - 1, i) || pair(i, i + 1));
  let kwh = 0, stripN = 0, hpN = 0, stackedN = 0, peak: number | null = null, hpSum = 0;
  const runs: Run[] = [];
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (strip[i]) {
      const own = Math.max(0, ex[i] - lv.compressorKw), last = runs.at(-1); kwh += own / 12; stripN++; peak = Math.max(peak ?? 0, own);
      if (lv.kind === 'straight' && lv.heatKw != null && ex[i] >= STACKED_X * lv.heatKw) stackedN++;
      if (last && b.epoch === last.end) { last.end += B; last.kwh += own / 12; }
      else runs.push({ start: b.epoch, end: b.epoch + B, kwh: own / 12, cause: null, setback: null, outdoorF: null });
    } else if (mode === 'nest' && eligible[i]) { hpN++; hpSum += ex[i]; }
  }
  for (const r of runs) {
    const t = out(r.start), cold = t != null && t < o.balanceF;
    if (mode === 'nest') { const sb = setbackBefore(nest, r.start); Object.assign(r, { setback: sb, outdoorF: t == null ? null : Math.round(t), cause: sb && cold ? 'both' : sb ? 'setback' : cold ? 'cold' : null }); }
    else Object.assign(r, { setback: null, outdoorF: t == null ? null : Math.round(t), cause: t == null ? null : cold ? 'cold' : 'setback' });   // a guess: strips on a mild morning are most likely a recovery
    r.kwh = r2(r.kwh);
  }
  const conf: Conf = lv.kind === 'learning' ? 'learning' : mode === 'energy' || !lv.stageLearned || !nest.some(r => r.heatF != null) ? 'estimated' : 'measured';
  const setbackF = runs.reduce<number | null>((a, r) => r.setback ? Math.max(a ?? 0, r.setback.toF - r.setback.fromF) : a, null);
  return { day: o.day, mode, stripKwh: r1(kwh), stripMin: stripN * 5, hpMin: mode === 'nest' ? hpN * 5 : null, stackedMin: stackedN * 5, peakKw: peak == null ? null : r1(peak),
    hpKw: hpN && lv.kind === 'heat-pump' ? r1(Math.min(lv.compressorKw, hpSum / hpN)) : lv.kind === 'heat-pump' ? r1(lv.compressorKw) : null,
    cause: combine(runs.map(r => r.cause)), conf, runs, setbackF, balanceF: Math.round(o.balanceF),
    quarters: quarters(o.day, bs, ex, strip, eligible, mode) };
}
/** The card's 15-minute bars, 4 AM to noon: the mean excess, amber when any bucket was strips, blue when heating (Nest) otherwise. */
function quarters(day: string, bs: readonly Bucket[], ex: number[], strip: boolean[], eligible: boolean[], mode: 'nest' | 'energy'): Quarter[] {
  const out: Quarter[] = [], start = localAt(day, CARD_HOURS.from), n = (CARD_HOURS.to - CARD_HOURS.from) * 4;
  for (let q = 0; q < n; q++) {
    const a = start + q * 900_000, ix = bs.map((b, i) => b.epoch >= a && b.epoch < a + 900_000 ? i : -1).filter(i => i >= 0);
    const kw = ix.length ? ix.reduce((s, i) => s + ex[i], 0) / ix.length : 0;
    out.push({ at: a, kw: r2(kw), cls: ix.some(i => strip[i]) ? 'st' : mode === 'nest' && ix.some(i => eligible[i]) ? 'hp' : '' });
  }
  return out;
}

/* ---------- words for the card and the push ---------- */
const clock = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)).replace(/\s?([AP])M/, (_, x) => x === 'A' ? ' AM' : ' PM');
/** "1 h 35 m", "45 m", "0 m". */
export const dur = (min: number) => min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} m` : `${min} m`;
/** The Why sentence (frame 6), or null with no strip run. */
export function whyText(d: DayStrip, kind: HeatingKind): string | null {
  const r = [...d.runs].sort((a, b) => b.kwh - a.kwh)[0]; if (!r) return null;
  const outside = r.outdoorF != null ? `Outside was ${r.outdoorF}°` : null, bp = `the ~${d.balanceF}° point where the heat pump needs help`;
  const est = d.mode === 'energy' ? ' (estimated from the energy data; no thermostat readings)' : '';
  if (kind === 'straight') return `This system heats on the strips alone, so every heating run is strip heat${r.setback ? `; this one was catching up from the ${r.setback.fromF}° setback (heat to ${r.setback.toF}° at ${clock(r.setback.at || r.start)})` : ''}.${outside ? ` ${outside}.` : ''}${est}`;
  if (r.cause === 'setback' || r.cause === 'both') {
    const sb = r.setback ? `catching up from the ${r.setback.fromF}° night setback (heat to ${r.setback.toF}° at ${clock(r.setback.at || r.start)})` : 'most likely catching up from a setback: it was mild enough for the heat pump alone';
    return `${sb[0].toUpperCase()}${sb.slice(1)}.${outside ? ` ${outside}, ${r.cause === 'both' ? `also below ${bp}` : `above ${bp}`}.` : ''}${est}`;
  }
  if (r.cause === 'cold') return `Genuine cold: ${r.outdoorF != null ? `${r.outdoorF}° outside, ` : ''}below ${bp}, with no setpoint change.${est}`;
  return `No setpoint change and it was above ${bp}; heat pumps also run the strips briefly while defrosting.${est}`;
}
/** The tip well (frame 6). `cmp`: a recent morning with a setback of 2° or less, for the comparison. */
export function tipText(d: DayStrip, kind: HeatingKind, cmp?: { day: string; kwh: number } | null): string | null {
  if (!d.runs.length) return null;
  if (kind === 'straight') return 'Every degree of setback is recovered on the strips, so a steady setpoint (or a 1° setback) uses the least.';
  if (d.cause === 'setback' || d.cause === 'both') {
    const wd = cmp ? new Date(Date.parse(cmp.day + 'T12:00:00Z')).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' }) : '';
    return `Keep overnight setbacks to 2° or less. The heat pump catches up without the strips.${cmp && d.stripKwh - cmp.kwh >= .5 ? ` A 2° setback last ${wd} used ${r1(d.stripKwh - cmp.kwh)} kWh less.` : ''}`;
  }
  if (d.cause === 'cold') return 'On a morning this cold the strips are needed; a steady setpoint keeps them to the minimum.';
  return null;
}
/** The push (frame 7) for a heavy morning; `push` false for a cold-only one (it goes to the feed only). */
export function alertFor(d: DayStrip): { title: string; body: string; push: boolean } | null {
  if (d.stripKwh < HEAVY_STRIP_KWH || !d.runs.length) return null;
  const r = [...d.runs].sort((a, b) => b.kwh - a.kwh)[0], push = d.cause === 'setback' || d.cause === 'both';
  const title = `Strip heat ran ${dur(d.stripMin)} this morning`;
  const body = push ? `About ${Math.round(d.stripKwh)} kWh, mostly catching up from ${r.setback ? `the ${r.setback.fromF}° setback` : 'a setback'}. A shallower setback keeps the strips off.`
    : `About ${Math.round(d.stripKwh)} kWh${r.outdoorF != null ? ` on a ${r.outdoorF}° morning` : ''}, below the ~${d.balanceF}° point where the heat pump needs help. No setback to blame: the cold did it.`;
  return { title, body, push };
}

/* ---------- daily_metrics (numbers only) ---------- */
export const CAUSE_CODE: Record<Exclude<Cause, null> | 'none', number> = { none: 0, cold: 1, setback: 2, both: 3 };
export const CONF_CODE: Record<Conf, number> = { learning: 0, estimated: 1, measured: 2 };
export const causeOf = (v: number | null | undefined): Cause => v === 1 ? 'cold' : v === 2 ? 'setback' : v === 3 ? 'both' : null;
/** The metric rows for a day: strip.kwh, strip.min, hp.min, strip.peak_kw, strip.cause, strip.conf, strip.setback_f. */
export function stripMetrics(d: DayStrip): Array<[string, number]> {
  const rows: Array<[string, number]> = [['strip.kwh', d.stripKwh], ['strip.min', d.stripMin], ['strip.cause', CAUSE_CODE[d.cause ?? 'none']], ['strip.conf', CONF_CODE[d.conf]]];
  if (d.hpMin != null) rows.push(['hp.min', d.hpMin]);
  if (d.peakKw != null) rows.push(['strip.peak_kw', d.peakKw]);
  if (d.setbackF != null) rows.push(['strip.setback_f', d.setbackF]);
  return rows;
}
/** A week's strip mornings from daily_metrics values by day: mornings with strip kWh ≥ 0.5, their kWh, how many after a setback. */
export function weekSummary(days: Record<string, Record<string, number>>) {
  const xs = Object.values(days).filter(m => (m['strip.kwh'] ?? 0) >= .5);
  return { mornings: xs.length, kwh: Math.round(xs.reduce((a, m) => a + m['strip.kwh'], 0)), setbacks: xs.filter(m => m['strip.cause'] === 2 || m['strip.cause'] === 3).length };
}
/** "Strip heat: 3 mornings · 31 kWh (2 after setbacks)." or null with none. */
export function digestLine(w: { mornings: number; kwh: number; setbacks: number } | null | undefined) {
  if (!w?.mornings) return null;
  return `Strip heat: ${w.mornings} morning${w.mornings === 1 ? '' : 's'} · ${w.kwh} kWh${w.setbacks ? ` (${w.setbacks} after setback${w.setbacks === 1 ? '' : 's'})` : ''}.`;
}

/* ---------- the back-test ---------- */
/**
 * The back-test behind HEAVY_STRIP_KWH: the strip mornings of a winter (energy-only last winter, measured once Nest heating exists),
 * their median and 90th percentile kWh, how many would have been "heavy" at the current threshold and how many of those would have
 * pushed (a setback cause). `suggestedKwh` is the 90th percentile of the strip mornings rounded to a whole kWh: the threshold that would
 * make about one strip morning in ten heavy. It is reported, not applied: the constant is refit by hand from real winter data.
 */
export function backtest(days: ReadonlyArray<Pick<DayStrip, 'stripKwh' | 'cause'>>, heavyKwh = HEAVY_STRIP_KWH) {
  const strip = days.filter(d => d.stripKwh >= .5).map(d => d.stripKwh).sort((a, b) => a - b);
  const q = (p: number) => strip.length ? strip[Math.min(strip.length - 1, Math.floor(strip.length * p))] : null;
  const heavy = days.filter(d => d.stripKwh >= heavyKwh);
  return { days: days.length, stripDays: strip.length, p50: q(.5), p90: q(.9), heavyDays: heavy.length, wouldPush: heavy.filter(d => d.cause === 'setback' || d.cause === 'both').length,
    suggestedKwh: strip.length >= 10 ? Math.round(q(.9)!) : null, heavyKwh };
}
