// The learning layer's routes, mounted under /api after the owner gate and the site check (so both are owner-only):
//   GET  /api/models                 the model report (mockups/r-learning.html): scores, tiers and badges, 8-week sparklines, the
//                                    last 30 days of scored pairs per model, open anomalies, the learning log and the AC trim state
//   POST /api/appliances/ac/untrim   undo today's learned AC trim (the plan runs untrimmed from the next cron tick)
// Four queries for the report. Only numbers that are already visible elsewhere in the app; no rate, no dollar figure.
import express, { type Request, type Response, type NextFunction } from 'express';
import { localDay, addDays } from '../tesla/client.js';
import { MODELS, MODEL_IDS, WINDOWS, mean, median, round, type Window } from './models.js';
import { lq } from './store.js';
import { confidence, badge, type Tier } from './confidence.js';
import { untrim, learnAcKey, controlKey, CONTROL_EVERY, type LearnAc, type ControlState } from './ac.js';
import type { LearnRun, LogEntry } from './nightly.js';

type Score = { mae: number | null; mape: number | null; bias: number | null; n: number; lastDay: string | null };
const T: Record<Tier, string> = { measured: 'm', learned: 'l', estimated: 'e', learning: 'n', unscored: 'u' };
/** The Chicago Monday of a day, for weekly sparkline buckets. */
const monday = (d: string) => addDays(d, -((new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7));

export async function modelsReport(siteId: string, today = localDay()) {
  const from56 = addDays(today, -56), from30 = addDays(today, -30);
  const [scores, metrics, open, kvRows] = await Promise.all([
    lq<{ model: string; window: Window; mae: number | null; mape: number | null; bias: number | null; n: number; last_day: string | null }>(
      `SELECT model, "window", mae, mape, bias, n, last_day FROM model_scores WHERE site_id = $1`, [siteId]),
    lq<{ day: string; metric: string; value: number }>(`SELECT day, metric, value FROM daily_metrics WHERE site_id = $1 AND day >= $2 AND day < $3 AND metric LIKE 'score:%'`, [siteId, from56, today]),
    lq<{ id: number; kind: string; day: string; severity: string; detail: Record<string, any>; opened_at: number }>(
      `SELECT id::int id, kind, day, severity, detail, opened_at::float8 opened_at FROM anomalies WHERE site_id = $1 AND resolved_at IS NULL ORDER BY opened_at DESC`, [siteId]),
    lq<{ key: string; value: any }>(`SELECT key, value FROM kv WHERE key = ANY($1::text[])`, [[`${siteId}:learn:last`, `${siteId}:learn:log`, learnAcKey(siteId), controlKey(siteId)]]),
  ]);
  const kvs = Object.fromEntries(kvRows.map(r => [r.key.slice(siteId.length + 1), r.value]));
  const last = kvs['learn:last'] as LearnRun | undefined, ac = kvs['learn:ac'] as LearnAc | undefined, ctl = kvs['ac:control'] as ControlState | undefined;
  // day → model → part → value
  const byModel = new Map<string, Map<string, Record<string, number>>>();
  for (const r of metrics) {
    const [, model, part] = r.metric.split(':');
    const days = byModel.get(model) ?? byModel.set(model, new Map()).get(model)!;
    (days.get(r.day) ?? days.set(r.day, {}).get(r.day)!)[part] = r.value;
  }
  const improvements: number[] = [];
  const models = MODEL_IDS.map(id => {
    const m = MODELS[id], sc = (w: Window): Score | null => { const r = scores.find(x => x.model === id && x.window === w); return r ? { mae: r.mae, mape: r.mape, bias: r.bias, n: r.n, lastDay: r.last_day } : null; };
    const main = sc(m.window), measuredAc = m.kind === 'estimate' && !!ac?.measured?.measured;
    const { tier, confidence: c } = confidence(m, main, today, measuredAc);
    const days = [...(byModel.get(id) ?? new Map<string, Record<string, number>>())].sort(([a], [b]) => a.localeCompare(b));
    const err = (x: Record<string, number>) => m.abs ? x.abs : x.ape;
    // eight weekly errors (MAPE, or MAE for points), oldest first: the sparkline, lower is better
    const weeks = new Map<string, number[]>();
    for (const [d, x] of days) if (err(x) != null) (weeks.get(monday(d)) ?? weeks.set(monday(d), []).get(monday(d))!).push(err(x));
    const spark = [...weeks].sort(([a], [b]) => a.localeCompare(b)).slice(-8).map(([, v]) => round(mean(v) * (m.abs ? 1 : 100), 1));
    // improvement: the last 28 days against the 28 before, both with 10+ scored days
    const recent = days.filter(([d]) => d >= addDays(today, -28)).map(([, x]) => err(x)).filter(v => v != null);
    const before = days.filter(([d]) => d < addDays(today, -28)).map(([, x]) => err(x)).filter(v => v != null);
    const improvement = recent.length >= 10 && before.length >= 10 && mean(before) > 0 ? round(1 - mean(recent) / mean(before), 2) : null;
    if (improvement != null) improvements.push(improvement);
    const last30 = days.filter(([d]) => d >= from30);
    const bands = id.startsWith('fc48.') ? Object.fromEntries(['h1-6', 'h7-24', 'h25-48'].map(b => { const v = last30.map(([, x]) => x[`abs@${b}`]).filter(v => v != null);
      return [b, v.length ? round(mean(v), 2) : null]; })) : undefined;
    const base = last30.length ? round(mean(last30.map(([, x]) => x.actual)), 2) : null;
    const note = m.kind === 'estimate'
      ? ac?.measured ? `${ac.measured.precoolDays} pre-cool · ${ac.measured.controlDays} control days compared` : 'estimated from the plan until control days measure it'
      : tier === 'unscored' ? (main?.n ? `last scored ${main.lastDay}` : 'no scored days yet') : `${main?.n ?? 0} ${m.window === '365d' ? 'cycles' : 'days'} scored`;
    return { id, label: m.label, unit: m.unit, abs: m.abs, dot: tier, t: T[tier], v: badge(m, tier, main), tier, confidence: c, n: main?.n ?? 0, need: m.need,
      mape: main?.mape != null ? round(main.mape * 100, 1) : null, mae: main?.mae != null ? round(main.mae, 2) : null, mad: m.abs && main?.mae != null ? round(main.mae, 1) : null,
      bias: main?.bias != null ? round(main.bias * (m.abs ? 1 : 100), 1) : null, base, spark, improvement, bands, note,
      help: tier === 'learning' || tier === 'unscored' || (m.kind === 'estimate' && tier !== 'measured') ? m.help : null,
      scores: Object.fromEntries(WINDOWS.map(([w]) => { const s = sc(w); return [w, s && { mae: s.mae, mape: s.mape, bias: s.bias, n: s.n }]; })),
      // the last 30 days of this model's daily metrics: predicted (p) vs measured (a), signed error, relative error, pairs scored
      days: last30.map(([day, x]) => ({ day, p: round(x.pred, 2), a: round(x.actual, 2), err: round(x.err, 3), ape: x.ape != null ? round(x.ape, 3) : null, n: x.n })) };
  });
  const med = improvements.length >= 2 ? median(improvements) : null;
  return {
    summary: { learned: models.filter(x => x.tier === 'learned').length, measured: models.filter(x => x.tier === 'measured').length, total: models.length,
      improvement: med, headline: med == null ? null : `Forecasts are ${Math.abs(Math.round(med * 100))}% ${med >= 0 ? 'more' : 'less'} accurate than 8 weeks ago.` },
    lastRun: last ? { at: last.at, ms: last.ms, queries: last.queries, scored: last.scored.length, predicted: last.predicted, errors: last.errors, waiting: last.waiting } : null,
    models,
    anomalies: open.map(a => ({ id: a.id, kind: a.kind, day: a.day, severity: a.severity, openedAt: a.opened_at, title: a.detail.title, body: a.detail.body, detail: a.detail })),
    log: ((kvs['learn:log'] as LogEntry[] | undefined) ?? []).slice(0, 20),
    ac: { trim: ac?.trim?.day === today ? ac.trim : null, measured: ac?.measured ?? null, warmupFPerH: ac?.warmupFPerH ?? null,
      control: { every: CONTROL_EVERY, eligibleDays: ctl?.count ?? 0, nextIn: CONTROL_EVERY - ((ctl?.count ?? 0) % CONTROL_EVERY), today: ctl?.days?.[today] ?? null } },
  };
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
export const learnRouter = express.Router();
learnRouter.get('/models', wrap(async (req, res) => res.json(await modelsReport(req.siteId!))));
learnRouter.post('/appliances/ac/untrim', wrap(async (req, res) => {
  const t = await untrim(req.siteId!);
  if (!t) return res.status(409).json({ error: 'There is no learned trim on today’s plan' });
  res.json({ ok: true, trim: t });
}));
