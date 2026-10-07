// B2-2 (audit L-01, Oct-§2.3): the 30-day bias of the 48-hour solar and home forecasts fed back into what the app shows.
// Per horizon band (the bands B2-1 scores daily totals in), bias = Σ err ÷ Σ den over the last 30 days (the same arithmetic as
// model_scores.bias), and the shown forecast is divided by (1 + bias) once the band has 7 or more scored days; the factor is
// clamped to ±25%. The nightly job keeps logging the RAW forecast (learn/nightly.ts calls forecast48 without a correction), so
// the scores measure the model itself and the correction can't feed on its own output.
import { addDays, localDay } from '../tesla/client.js';
import { lq } from './store.js';
import { MODELS, round, versionOf } from './models.js';

export const BIAS_BANDS = ['h1-6', 'h7-24', 'h25-48'] as const;
export const BIAS_MIN_DAYS = 7, BIAS_DAYS = 30, BIAS_CLAMP = .25;
export type BandFactors = Partial<Record<(typeof BIAS_BANDS)[number], number>>;
export type Fc48Correction = { solar: BandFactors; home: BandFactors };
type Row = { day: string; metric: string; value: number };

/**
 * The factors from daily_metrics rows ('score:<model>:err@<band>' / 'den@<band>', and 'v'); a band with fewer than 7 scored days
 * of the model's current version (B2-3) has none.
 */
export function biasFactors(rows: readonly Row[]): Fc48Correction {
  const of = (model: 'fc48.solar' | 'fc48.home'): BandFactors => {
    const out: BandFactors = {}, v = new Map(rows.filter(r => r.metric === `score:${model}:v`).map(r => [r.day, r.value]));
    for (const b of BIAS_BANDS) {
      const days = new Map<string, { err?: number; den?: number }>();
      for (const r of rows) {
        const [, m, part] = r.metric.split(':'); if (m !== model || versionOf(v.get(r.day)) !== MODELS[model].version) continue;
        const x = part === `err@${b}` ? 'err' : part === `den@${b}` ? 'den' : null; if (!x) continue;
        (days.get(r.day) ?? days.set(r.day, {}).get(r.day)!)[x] = r.value;
      }
      const ok = [...days.values()].filter(v => v.err != null && v.den != null && v.den > 0);
      if (ok.length < BIAS_MIN_DAYS) continue;
      const bias = ok.reduce((a, v) => a + v.err!, 0) / ok.reduce((a, v) => a + v.den!, 0);
      out[b] = round(Math.min(1 + BIAS_CLAMP, Math.max(1 - BIAS_CLAMP, 1 / (1 + bias))), 3);
    }
    return out;
  };
  return { solar: of('fc48.solar'), home: of('fc48.home') };
}

/** The site's factors now (one query). */
export async function fc48Correction(siteId: string, today = localDay()): Promise<Fc48Correction> {
  const rows = await lq<Row>(`SELECT day, metric, value FROM daily_metrics WHERE site_id = $1 AND day >= $2 AND day < $3
    AND (metric LIKE 'score:fc48.solar:err@%' OR metric LIKE 'score:fc48.solar:den@%' OR metric LIKE 'score:fc48.home:err@%' OR metric LIKE 'score:fc48.home:den@%'
      OR metric IN ('score:fc48.solar:v', 'score:fc48.home:v'))`,
    [siteId, addDays(today, -BIAS_DAYS), today]);
  return biasFactors(rows);
}
