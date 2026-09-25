// The learning layer's model table (docs/audit-designs/learning-layer.md §2–3). Every figure the app predicts is one model here:
// what it is, its unit, and the numbers the scoring and the confidence formula need. Pure; exported for tests.

export type ModelId = 'fc48.solar' | 'fc48.home' | 'fc48.soc' | 'pool.kwhDay' | 'ac.shifted' | 'ac.eveningAvoided' | 'bill.cycleImport' | 'home.alwaysOn';
export type Window = '7d' | '30d' | '365d';
export const WINDOWS: ReadonlyArray<[Window, number]> = [['7d', 7], ['30d', 30], ['365d', 365]];

export type ModelDef = {
  id: ModelId; label: string; unit: string;
  /** Absolute-unit model: error is read in units (pts), not percent. */
  abs: boolean;
  /** Denominator floor for the relative error, so a near-zero actual can't blow MAPE up. */
  floor: number;
  /** N: scored days for full coverage (c = min(1, n/N)); under N/2 the tier is "learning". */
  need: number;
  /** MAPE (or MAE for abs models) at which accuracy scores 0. */
  ceiling: number;
  /** The window the confidence formula reads. */
  window: Window;
  /** No scored day for longer than this → unscored. Scores stay fully fresh this many days, then fade to 0 over 27 more. */
  staleDays: number; freshDays: number;
  /** How a day's hourly pairs roll up into the day's predicted/actual: summed (kWh) or averaged (SOC, kW). */
  agg: 'sum' | 'mean';
  /** 'estimate': an engineering estimate, badged "estimated" until control days replace it with a measurement ("measured"). */
  kind: 'scored' | 'estimate';
  /** The only keys a prediction's `inputs` may hold (privacy: never a rate, a dollar figure, a name or the system price). */
  inputs: readonly string[];
  /** What would make it better, for the model report while it is learning or unscored. */
  help: string;
};

const FC48 = ['k', 'yieldK', 'soc0', 'capKwh', 'maxKw', 'reservePct', 'startHour', 'profile', 'gti'] as const;
const AC = ['high', 'sunKwhM2', 'humidity', 'precool', 'control', 'depth', 'mid', 'from', 'to', 'coastFrom', 'coastTo', 'coastF', 'acKw', 'slope', 'kPerDegH', 'trim'] as const;
const base = { abs: false, window: '30d' as Window, staleDays: 14, freshDays: 3, agg: 'mean' as const, kind: 'scored' as const };

export const MODELS: Record<ModelId, ModelDef> = {
  'fc48.solar': { ...base, id: 'fc48.solar', label: 'Next 48 h solar', unit: 'kWh', floor: .3, need: 14, ceiling: .4, agg: 'sum', inputs: FC48,
    help: 'needs a few more days of forecasts scored against what the panels made' },
  'fc48.home': { ...base, id: 'fc48.home', label: 'Next 48 h home use', unit: 'kWh', floor: .3, need: 14, ceiling: .4, agg: 'sum', inputs: FC48,
    help: 'needs a few more days of forecasts scored against what the house used' },
  'fc48.soc': { ...base, id: 'fc48.soc', label: 'Next 48 h battery %', unit: 'pts', abs: true, floor: 0, need: 14, ceiling: 20, inputs: FC48,
    help: 'needs a few more days of forecasts scored against the Powerwall charge' },
  'pool.kwhDay': { ...base, id: 'pool.kwhDay', label: 'Pool kWh/day', unit: 'kWh', floor: .5, need: 14, ceiling: .3,
    inputs: ['mode', 'hours', 'boostHours', 'sched', 'filterRpm', 'boostRpm', 'waterTemp', 'high', 'sunKwhM2', 'rainMm', 'uvKwh'],
    help: 'needs pool readings through at least 80% of the pump’s scheduled hours' },
  'ac.shifted': { ...base, id: 'ac.shifted', label: 'AC kWh shifted onto solar', unit: 'kWh', floor: 1, need: 10, ceiling: .6, kind: 'estimate', inputs: AC,
    help: 'needs control days: 1 in 5 hot, sunny days holds the comfort band so pre-cool days can be compared' },
  'ac.eveningAvoided': { ...base, id: 'ac.eveningAvoided', label: 'AC evening kWh avoided', unit: 'kWh', floor: 1, need: 10, ceiling: .6, kind: 'estimate', inputs: AC,
    help: 'needs control days: 1 in 5 hot, sunny days holds the comfort band so pre-cool days can be compared' },
  'bill.cycleImport': { ...base, id: 'bill.cycleImport', label: 'Billing-cycle kWh bought', unit: 'kWh', floor: 50, need: 3, ceiling: .25,
    window: '365d', staleDays: 45, freshDays: 35, inputs: ['from', 'to', 'elapsedDays', 'importSoFar', 'exportSoFar'],
    help: 'needs a parsed bill and a few finished billing cycles' },
  'home.alwaysOn': { ...base, id: 'home.alwaysOn', label: 'Always-on load (1–5 AM)', unit: 'kW', floor: .2, need: 14, ceiling: .25,
    inputs: ['nights', 'acKw'], help: 'needs two more weeks of nights' },
};
export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

/** Keys that may never appear anywhere in stored inputs or learning summaries (rule 5). */
export const FORBIDDEN_KEY = /usd|cost|price|loan|rate|system|name|address|account|token|serial|zip/i;

export const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const mean = (a: readonly number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
export const median = (a: readonly number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
