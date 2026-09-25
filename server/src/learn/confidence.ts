// How much to trust each predicted figure (docs/audit-designs/learning-layer.md §2–3):
//   c     = min(1, n / N)                          coverage of scored days
//   a     = clamp(1 − MAPE / ceiling)               accuracy (absolute-unit models: MAE / ceiling)
//   s     = clamp(1 − |bias| / (MAPE + 0.01))       steadiness (abs models: |bias| / (MAE + 0.01))
//   fresh = 1 up to freshDays since the last scored day, then fading to 0 over 27 days
//   confidence = round2(c × (0.75·a + 0.25·s) × fresh)
//   tier: a direct measurement → measured; no scored day within staleDays → unscored; n < N/2 → learning;
//         confidence ≥ 0.70 → learned; else estimated.
// The two AC savings figures are engineering estimates (owner decision, audit question 22): "estimated" until control days
// measure them, then "measured".
import { MODELS, clamp, round, type ModelDef, type ModelId } from './models.js';
import { lq } from './store.js';
import { localDay } from '../tesla/client.js';

export type Tier = 'measured' | 'learned' | 'estimated' | 'learning' | 'unscored';
export type Stats = { n: number; mae: number | null; mape: number | null; bias: number | null; lastDay: string | null };
export const LEARNED_AT = .7;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);

/** The formula, pure. `today` is the Chicago day the tier is for; `measured` marks a figure that is itself a measurement. */
export function confidence(m: ModelDef, s: Stats | null | undefined, today: string, measured = false): { tier: Tier; confidence: number } {
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
  if (tier === 'measured' || tier === 'unscored') return tier;
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
