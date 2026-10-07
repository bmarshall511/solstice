// How much to trust each predicted figure (docs/audit-designs/learning-layer.md §2–3):
//   c     = min(1, n / N)                          coverage of scored days
//   a     = clamp(1 − MAPE / ceiling)               accuracy (absolute-unit models: MAE / ceiling)
//   s     = clamp(1 − |bias| / (MAPE + 0.01))       steadiness (abs models: |bias| / (MAE + 0.01))
//   fresh = 1 up to freshDays since the last scored day, then fading to 0 over 27 days
//   confidence = round2(c × (0.75·a + 0.25·s) × fresh)
//   tier: a direct measurement → measured; no scored day within staleDays → unscored; n < N/2 → learning;
//         confidence ≥ 0.70 → learned; else estimated.
// The two AC savings figures are engineering estimates (owner decision, audit question 22): "estimated" until control days
// measure them, then "measured". B2-9 (idea I-03): they are "dormant" outside the cooling season (May–October) and when no
// surplus-eligible day (a hot, sunny plan day with measured spare solar) came in the last 14 days: nothing can teach them then.
import { MODELS, clamp, round, type ModelDef, type ModelId } from './models.js';
import { lq } from './store.js';
import { localDay } from '../tesla/client.js';

export type Tier = 'measured' | 'learned' | 'estimated' | 'learning' | 'unscored' | 'dormant';
export type Stats = { n: number; mae: number | null; mape: number | null; bias: number | null; lastDay: string | null };
export const LEARNED_AT = .7;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);

/** The formula, pure. `today` is the Chicago day the tier is for; `measured` marks a figure that is itself a measurement; `dormant` (B2-9, the AC savings models only: acDormancy) wins over both. */
export function confidence(m: ModelDef, s: Stats | null | undefined, today: string, measured = false, dormant = false): { tier: Tier; confidence: number } {
  if (m.kind === 'estimate' && dormant) return { tier: 'dormant', confidence: 0 };
  if (m.kind === 'estimate') return { tier: measured ? 'measured' : 'estimated', confidence: measured ? 1 : 0 };
  if (measured) return { tier: 'measured', confidence: 1 };
  const age = s?.lastDay ? daysBetween(s.lastDay, today) : null;
  if (!s || !s.n || age == null || age > m.staleDays) return { tier: 'unscored', confidence: 0 };
  const err = m.abs ? s.mae : s.mape;
  const c = Math.min(1, s.n / m.need);
  const a = err == null ? 0 : clamp(1 - err / m.ceiling);
  const st = err == null || s.bias == null ? 0 : clamp(1 - Math.abs(s.bias) / (err + .01));
  const fresh = age <= m.freshDays ? 1 : clamp(1 - (age - m.freshDays) / 27);
  const conf = round(c * (.75 * a + .25 * st) * fresh, 2);
  if (s.n < m.need / 2) return { tier: 'learning', confidence: conf };
  return { tier: conf >= LEARNED_AT ? 'learned' : 'estimated', confidence: conf };
}

/** The badge text the model report and the chips show (mockup r-learning: "±4%", "±5 pts", "learning · 3 of 10", …). */
export function badge(m: ModelDef, tier: Tier, s: Stats | null | undefined): string {
  if (tier === 'measured' || tier === 'unscored' || tier === 'dormant') return tier;
  if (tier === 'learning') return `learning · ${s?.n ?? 0} of ${m.need}`;
  if (tier === 'estimated' && m.kind === 'estimate') return 'estimated';
  const err = m.abs ? s?.mae : s?.mape;
  if (err == null) return tier;
  return m.abs ? `±${round(err, err < 1 ? 1 : 0)} ${m.unit}` : `±${Math.round(err * 100)}%`;
}

type ScoreRow = { model: string; window: string; n: number; mae: number | null; mape: number | null; bias: number | null; last_day: string | null };
/** Tiers for several models in one query (model_scores, each model's own window); `measuredAc` from the nightly AC savings. */
export async function confidenceMap<M extends ModelId>(siteId: string, models: readonly M[], o: { today?: string; measuredAc?: boolean } = {}): Promise<Record<M, Tier>> {
  const today = o.today ?? localDay();
  let measuredAc = o.measuredAc;
  const scored = models.filter(m => MODELS[m].kind === 'scored');
  const rows = scored.length ? await lq<ScoreRow>(`SELECT model, "window", n, mae, mape, bias, last_day FROM model_scores WHERE site_id = $1 AND model = ANY($2::text[]) AND "window" = ANY($3::text[])`,
    [siteId, scored, [...new Set(scored.map(m => MODELS[m].window))]]) : [];
  if (measuredAc == null && models.some(m => MODELS[m].kind === 'estimate')) {
    const ac = (await lq<{ value: { measured?: { measured?: boolean } } }>(`SELECT value FROM kv WHERE key = $1`, [`${siteId}:learn:ac`]))[0]?.value;
    measuredAc = !!ac?.measured?.measured;
  }
  return Object.fromEntries(models.map(m => {
    const r = rows.find(x => x.model === m && x.window === MODELS[m].window);
    return [m, confidence(MODELS[m], r && { n: r.n, mae: r.mae, mape: r.mape, bias: r.bias, lastDay: r.last_day }, today, MODELS[m].kind === 'estimate' && !!measuredAc).tier];
  })) as Record<M, Tier>;
}
/** One model's tier (see confidenceMap). */
export const confidenceFor = async (siteId: string, model: ModelId, o: { today?: string } = {}) => (await confidenceMap(siteId, [model], o))[model];

/* ---------- B2-9 (idea I-03): seasonal dormancy of the AC savings models, and a plain sentence for every model ---------- */
export const SEASON_MONTHS = [5, 6, 7, 8, 9, 10], DORMANT_LOOKBACK_DAYS = 14;
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const short = (d: string) => `${MONTH[+d.slice(5, 7) - 1].slice(0, 3)} ${+d.slice(8, 10)}`;
/**
 * Whether the AC savings models are dormant on `today`: outside May–October, or no surplus-eligible day in the 14 days before today.
 * A surplus-eligible day is one the plan found hot and sunny enough to pre-cool (`eligible`: the control-day record's days) that also
 * had measured spare solar (`spare`: the Powerwalls reached 95% and over 2 kWh went to PEC). `why` says so in plain words.
 */
export function acDormancy(today: string, eligible: readonly string[], spare: ReadonlySet<string>): { dormant: boolean; reason: 'season' | 'surplus' | null; last: string | null; why: string | null } {
  const lo = addDaysUtc(today, -DORMANT_LOOKBACK_DAYS), month = +today.slice(5, 7);
  const surplus = eligible.filter(d => spare.has(d) && d < today).sort(), last = surplus.at(-1) ?? null;
  if (!SEASON_MONTHS.includes(month)) return { dormant: true, reason: 'season', last,
    why: `Dormant outside the cooling season (May–October): pre-cool only runs on spare solar on hot days, so there is nothing to measure. Expected back from May.` };
  if (!surplus.some(d => d >= lo)) return { dormant: true, reason: 'surplus', last,
    why: `Dormant: waits for spare-solar days (a hot, sunny day with the Powerwalls full and power going to PEC); none in the last ${DORMANT_LOOKBACK_DAYS} days${last ? `, the last on ${short(last)}` : ''}. Expected on the next one.` };
  return { dormant: false, reason: null, last, why: null };
}
const addDaysUtc = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/**
 * The plain sentence for a model row (B2-9): why it has the tier it has and, while learning, about when that changes.
 * `rate`: scored days per calendar day over the last 14 (the learning ETA = ⌈(need/2 − n) / rate⌉ days).
 */
export function whyText(m: ModelDef, tier: Tier, s: Stats | null | undefined, o: { rate?: number; conf?: number; dormantWhy?: string | null; ac?: { precoolDays: number; controlDays: number } | null } = {}): string {
  const n = s?.n ?? 0, err = m.abs ? s?.mae : s?.mape, pct = (v: number) => `${Math.round(v * 100)}%`;
  const errText = (v: number) => m.abs ? `±${round(v, 1)} ${m.unit}` : `±${pct(v)}`;
  if (tier === 'dormant') return o.dormantWhy ?? 'Dormant for now.';
  if (m.kind === 'estimate') return tier === 'measured' ? `Measured: pre-cool days compared with ${o.ac?.controlDays ?? 0} control days.`
    : `Estimated from the plan until control days measure it: ${o.ac?.precoolDays ?? 0} of 5 pre-cool days compared so far.`;
  if (tier === 'measured') return 'A direct reading: no model to score.';
  if (tier === 'unscored') return n && s?.lastDay ? `No scored day since ${short(s.lastDay)}: it ${m.help}.` : `Nothing scored yet: it ${m.help}.`;
  if (tier === 'learning') {
    const left = Math.ceil(m.need / 2 - n), eta = o.rate && o.rate > 0 ? Math.ceil(left / o.rate) : null;
    return `Learning: ${n} of ${m.need} days scored${eta != null ? `; about ${eta} more day${eta === 1 ? '' : 's'} until it is rated` : ''}.`;
  }
  if (tier === 'learned') return `Learned: ${err != null ? `${errText(err)} ` : ''}over ${n} scored ${m.window === '365d' ? 'cycles' : 'days'}.`;
  // estimated: the smallest of the three factors is what holds it back
  const c = Math.min(1, n / m.need), a = err == null ? 0 : clamp(1 - err / m.ceiling), st = err == null || s?.bias == null ? 0 : clamp(1 - Math.abs(s.bias) / (err + .01));
  const conf = o.conf ?? 0;
  const what = a <= c && a <= st ? `its error ${err != null ? errText(err) : '—'} is large against the ${m.abs ? `${m.ceiling} ${m.unit}` : pct(m.ceiling)} ceiling`
    : c <= st ? `only ${n} of ${m.need} days are scored`
    : `it runs ${(s?.bias ?? 0) > 0 ? 'high' : 'low'} by ${m.abs ? `${round(Math.abs(s?.bias ?? 0), 1)} ${m.unit}` : pct(Math.abs(s?.bias ?? 0))} on average`;
  return `Estimated: ${what} (confidence ${conf.toFixed(2)}, ${LEARNED_AT.toFixed(2)} makes it learned).`;
}
