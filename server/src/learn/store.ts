// Prediction logging: the one helper every predicting path uses (docs/audit-designs/learning-layer.md §4).
// A prediction is immutable: the first row for (site, model, day, hour, horizon) stands and a rerun inserts nothing.
import { q } from '../db.js';
import { MODELS, FORBIDDEN_KEY, type ModelId } from './models.js';

/** Database round trips made by the learning layer since the last reset (the nightly job reports it). */
export const learnStats = { queries: 0 };
/** q() with the learning layer's round-trip counter. */
export const lq: typeof q = (text, params) => { learnStats.queries++; return q(text, params); };

export type Prediction = {
  model: ModelId; day: string;
  /** Local hour 0–23 for hourly models; omitted (-1) for a whole day. */
  hour?: number;
  /** Hours (forecast) or days (bill cycle) ahead of the prediction; 0 when there is only one per target. */
  horizon?: number;
  value: number;
  inputs?: Record<string, unknown>;
  madeAt?: number;
};

const clean = (v: unknown, depth = 0): unknown => {
  if (v == null || typeof v === 'boolean') return v ?? null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null;
  if (typeof v === 'string') return v.slice(0, 60);
  if (Array.isArray(v)) return depth > 2 ? null : v.slice(0, 48).map(x => clean(x, depth + 1));
  if (typeof v === 'object' && depth < 2)
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !FORBIDDEN_KEY.test(k)).map(([k, x]) => [k, clean(x, depth + 1)]));
  return null;
};
/**
 * The inputs a prediction may keep: the model's key whitelist only (models.ts), numbers rounded, strings cut to 60 characters,
 * and no key anywhere that looks like money, a rate, the system or a name (FORBIDDEN_KEY). Never throws.
 */
export function pickInputs(model: ModelId, obj: Record<string, unknown> = {}): Record<string, unknown> {
  const allow = new Set(MODELS[model].inputs);
  return Object.fromEntries(Object.entries(obj).filter(([k, v]) => allow.has(k) && !FORBIDDEN_KEY.test(k) && v !== undefined).map(([k, v]) => [k, clean(v)]));
}

/** Keys already written by this instance (request paths log at most once per key per instance). */
const written = new Set<string>();
const keyOf = (siteId: string, p: Prediction) => `${siteId}|${p.model}|${p.day}|${p.hour ?? -1}|${p.horizon ?? 0}`;

/**
 * Log one or more predictions in a single INSERT … ON CONFLICT DO NOTHING. Non-finite values are skipped.
 * `once`: skip keys this instance already wrote (for request paths such as the AC plan, which is recomputed on every read).
 * Returns the number of rows inserted.
 */
export async function logPrediction(siteId: string, preds: Prediction | Prediction[], o: { once?: boolean; now?: number } = {}): Promise<number> {
  const list = (Array.isArray(preds) ? preds : [preds]).filter(p => MODELS[p.model] && Number.isFinite(p.value) && !(o.once && written.has(keyOf(siteId, p))));
  if (!list.length) return 0;
  const now = o.now ?? Date.now();
  const rows = await lq(`INSERT INTO predictions (site_id, model, target_day, target_hour, horizon, predicted, unit, made_at, inputs)
    SELECT $1, * FROM unnest($2::text[], $3::text[], $4::smallint[], $5::smallint[], $6::float8[], $7::text[], $8::bigint[], $9::jsonb[])
    ON CONFLICT (site_id, model, target_day, target_hour, horizon) DO NOTHING RETURNING id`,
    [siteId, list.map(p => p.model), list.map(p => p.day), list.map(p => p.hour ?? -1), list.map(p => p.horizon ?? 0), list.map(p => p.value),
      list.map(p => MODELS[p.model].unit), list.map(p => p.madeAt ?? now), list.map(p => JSON.stringify(pickInputs(p.model, p.inputs)))]);
  if (o.once) for (const p of list) written.add(keyOf(siteId, p));
  return rows.length;
}
/** Tests only: forget which keys this instance wrote. */
export const forgetWritten = () => written.clear();
