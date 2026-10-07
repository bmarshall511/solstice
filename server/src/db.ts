// Postgres access. Production: Neon (serverless HTTP driver). Tests/local fallback: PGlite (Postgres in WASM).
//   DATABASE_URL=postgres://…   → Neon
//   DATABASE_URL=pglite:<dir>   → PGlite (in-process; e.g. pglite:data/pg)
import { neon } from '@neondatabase/serverless';

export type Row = Record<string, any>;
type Query = (text: string, params?: unknown[]) => Promise<Row[]>;

let query: Query | null = null;

async function connect(): Promise<Query> {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite(url.slice(7) || undefined);
    return async (text, params) => (await pg.query<Row>(text, params as any[])).rows;
  }
  const sql = neon(url);
  return (text, params) => sql.query(text, params as any[]) as Promise<Row[]>;
}

export async function q<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  query ??= await connect();
  return (await query(text, params)) as T[];
}
/**
 * One local hour's Wh of a 5-minute energy column for a GROUP BY day, hour: the sum, scaled back to one hour when the hour holds more
 * than 12 buckets. The fall-back day (first Sunday in November) repeats 01:00, so that hour holds 24 buckets, two real hours.
 */
export const hourWh = (col: string) => `(SUM(${col}) * 12.0 / GREATEST(COUNT(*), 12))`;
export const one = async <T extends Row = Row>(text: string, params: unknown[] = []) => (await q<T>(text, params))[0] as T | undefined;

/** Small key/value store (per-site sync timestamps, poll errors, etc.). */
export const kv = {
  async get<T>(key: string): Promise<T | undefined> { return (await one('SELECT value FROM kv WHERE key = $1', [key]))?.value as T | undefined; },
  async set(key: string, value: unknown) { await q('INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]); },
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id serial PRIMARY KEY, email text UNIQUE NOT NULL, name text, password_hash text NOT NULL,
     role text NOT NULL DEFAULT 'member', settings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash text PRIMARY KEY, user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, user_agent text)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (email text NOT NULL, ok boolean NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS login_attempts_email ON login_attempts(email, at)`,
  // A Tesla account connected through Solstice's Fleet API app (one per user today; kept separate for later).
  `CREATE TABLE IF NOT EXISTS tesla_accounts (
     id serial PRIMARY KEY, user_id int REFERENCES users(id) ON DELETE CASCADE,
     access_token text NOT NULL, refresh_token text NOT NULL, expires_at bigint NOT NULL, scope text,
     refreshing_until bigint, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS sites (
     id text PRIMARY KEY, user_id int REFERENCES users(id) ON DELETE CASCADE, tesla_account_id int REFERENCES tesla_accounts(id) ON DELETE SET NULL,
     name text, info jsonb, info_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS readings (
     site_id text NOT NULL, ts bigint NOT NULL, solar_w real, battery_w real, grid_w real, load_w real, soc real,
     grid_status text, island_status text, storm_mode_active boolean, PRIMARY KEY (site_id, ts))`,
  `CREATE TABLE IF NOT EXISTS energy (
     site_id text NOT NULL, ts text NOT NULL, epoch bigint NOT NULL, day text NOT NULL, hour smallint NOT NULL,
     solar_wh real, home_wh real, import_wh real, export_wh real, charge_wh real, discharge_wh real, PRIMARY KEY (site_id, ts))`,
  `CREATE INDEX IF NOT EXISTS energy_site_day ON energy(site_id, day)`,
  // Nearest-bucket lookups by time (AC kW learning). Two cold starts can race to build it; the loser's duplicate error is swallowed so
  // the memoised migrate() never rejects for it.
  `DO $$ BEGIN CREATE INDEX IF NOT EXISTS energy_site_epoch ON energy(site_id, epoch); EXCEPTION WHEN duplicate_table OR unique_violation THEN NULL; END $$`,
  `CREATE TABLE IF NOT EXISTS soe (site_id text NOT NULL, ts text NOT NULL, epoch bigint NOT NULL, day text NOT NULL, hour smallint NOT NULL, soe real NOT NULL, PRIMARY KEY (site_id, ts))`,
  `CREATE INDEX IF NOT EXISTS soe_site_day ON soe(site_id, day)`,
  // capacity's 400-day read and the outage view's newest battery % order by epoch (code review §3b)
  `DO $$ BEGIN CREATE INDEX IF NOT EXISTS soe_site_epoch ON soe(site_id, epoch); EXCEPTION WHEN duplicate_table OR unique_violation THEN NULL; END $$`,
  `CREATE TABLE IF NOT EXISTS backup_events (site_id text NOT NULL, ts text NOT NULL, epoch bigint NOT NULL, duration_s int NOT NULL, PRIMARY KEY (site_id, ts))`,
  `CREATE TABLE IF NOT EXISTS bills (
     site_id text NOT NULL, bill_date text NOT NULL, period_from text NOT NULL, period_to text NOT NULL,
     delivered_kwh real NOT NULL, received_kwh real NOT NULL, total real NOT NULL, raw jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (site_id, bill_date))`,
  // Which days of history are fully stored, per kind ('energy' | 'soe').
  `CREATE TABLE IF NOT EXISTS synced_days (site_id text NOT NULL, kind text NOT NULL, day text NOT NULL, PRIMARY KEY (site_id, kind, day))`,
  // Energy buckets stored for the day when it was marked (NULL on rows marked before this column existed).
  `ALTER TABLE synced_days ADD COLUMN IF NOT EXISTS buckets int`,
  // Tesla's per-path energy for each 5-minute bucket, Wh. NULL on rows stored before these columns existed, until the nightly back-fill reaches them.
  `ALTER TABLE energy ADD COLUMN IF NOT EXISTS solar_home_wh real, ADD COLUMN IF NOT EXISTS solar_battery_wh real, ADD COLUMN IF NOT EXISTS solar_grid_wh real,
     ADD COLUMN IF NOT EXISTS battery_home_wh real, ADD COLUMN IF NOT EXISTS battery_grid_wh real, ADD COLUMN IF NOT EXISTS grid_home_wh real,
     ADD COLUMN IF NOT EXISTS grid_battery_wh real`,
  // User-logged events: panel cleanings, notes. Deletable (undo).
  `CREATE TABLE IF NOT EXISTS events (id serial PRIMARY KEY, site_id text NOT NULL, type text NOT NULL, day text NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb NOT NULL)`,
  // Pool pump samples from ScreenLogic (taken whenever the app asks for pool data): used to learn the pump's real watts per RPM.
  `CREATE TABLE IF NOT EXISTS pool_readings (site_id text NOT NULL, ts bigint NOT NULL, day text NOT NULL, hour smallint NOT NULL, running boolean NOT NULL,
     watts real NOT NULL, rpm real NOT NULL, water_temp real, air_temp real, circuits jsonb NOT NULL DEFAULT '[]', PRIMARY KEY (site_id, ts))`,
  `CREATE INDEX IF NOT EXISTS pool_readings_site_day ON pool_readings(site_id, day)`,
  // The pool water log (mockup aj; appliances/poolTests.ts): the owner's tests, ppm except pH; water_f from the controller at logging time.
  `CREATE TABLE IF NOT EXISTS pool_tests (id serial PRIMARY KEY, site_id text NOT NULL, at bigint NOT NULL, day text NOT NULL, fc real NOT NULL, ph real NOT NULL,
     cc real, ta real, cya real, ch real, clarity text NOT NULL, added jsonb NOT NULL DEFAULT '[]', source text NOT NULL DEFAULT 'kit', water_f real)`,
  `CREATE INDEX IF NOT EXISTS pool_tests_site_day ON pool_tests(site_id, day)`,
  `CREATE TABLE IF NOT EXISTS nest_readings (site_id text NOT NULL, ts bigint NOT NULL, day text NOT NULL, hour smallint NOT NULL, indoor_f real, humidity real, mode text, hvac text, cool_f real, heat_f real, eco boolean, PRIMARY KEY (site_id, ts))`,
  `CREATE INDEX IF NOT EXISTS nest_readings_site_day ON nest_readings(site_id, day)`,
  // Per-inverter readings from the SunPower PVS6, pushed by scripts/pvs-relay.mjs (one row per inverter per 5-minute poll; server/src/pvs.ts). kw is AC power (p3phsumKw).
  `CREATE TABLE IF NOT EXISTS pvs_readings (ts timestamptz, sn text, kw numeric, v numeric, temp_c numeric, PRIMARY KEY (ts, sn))`,
  // DC power (pMppt1Kw) and the inverter's lifetime energy counter (ltea3phsumKwh); NULL on rows stored before these columns existed.
  `ALTER TABLE pvs_readings ADD COLUMN IF NOT EXISTS kw_dc numeric, ADD COLUMN IF NOT EXISTS kwh_lifetime numeric`,
  // Single-owner mode: one row per device that opened the owner link (no account, no user row). Deleting a row signs that device out.
  `CREATE TABLE IF NOT EXISTS owner_sessions (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(), label text)`,
  // Guest share links (share.ts): only the SHA-256 of each token is stored; the token itself is shown to the owner once. The label is
  // the owner's private name for the link and never reaches a guest. expires_at NULL = never. Revoked rows are pruned after 30 days.
  `CREATE TABLE IF NOT EXISTS access_tokens (
     id text PRIMARY KEY, token_hash text UNIQUE NOT NULL, label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz, revoked_at timestamptz, opened_count int NOT NULL DEFAULT 0, last_opened_at timestamptz, last_ua text)`,

  // Learning layer (server/src/learn/). Every prediction the app makes, with the inputs it used (a key whitelist, never a rate or
  // a dollar figure). Immutable: the first row for a key stands. `horizon` is hours (forecast) or days (bill cycle) ahead, 0 otherwise.
  `CREATE TABLE IF NOT EXISTS predictions (id bigserial PRIMARY KEY, site_id text NOT NULL, model text NOT NULL, target_day text NOT NULL,
     target_hour smallint NOT NULL DEFAULT -1, horizon smallint NOT NULL DEFAULT 0, predicted double precision NOT NULL, unit text NOT NULL,
     made_at bigint NOT NULL, inputs jsonb NOT NULL DEFAULT '{}')`,
  `DO $$ BEGIN CREATE UNIQUE INDEX IF NOT EXISTS predictions_key ON predictions(site_id, model, target_day, target_hour, horizon); EXCEPTION WHEN duplicate_table OR unique_violation THEN NULL; END $$`,
  `DO $$ BEGIN CREATE INDEX IF NOT EXISTS predictions_day ON predictions(site_id, target_day); EXCEPTION WHEN duplicate_table OR unique_violation THEN NULL; END $$`,
  // Each day's measured values and prediction scores (metric 'score:<model>:<abs|ape|err|den|pred|actual|n>'), computed nightly.
  `CREATE TABLE IF NOT EXISTS daily_metrics (site_id text NOT NULL, day text NOT NULL, metric text NOT NULL, value double precision, PRIMARY KEY (site_id, day, metric))`,
  // Rolling error per model and window ('7d', '30d', '365d'); last_day is the newest scored day (the confidence formula's freshness).
  `CREATE TABLE IF NOT EXISTS model_scores (site_id text NOT NULL, model text NOT NULL, "window" text NOT NULL, mae double precision, mape double precision,
     bias double precision, n int NOT NULL, last_day text, updated_at bigint NOT NULL, PRIMARY KEY (site_id, model, "window"))`,
  // Anomalies found by the nightly rules: one open row per kind; a firing after resolution opens a new row.
  `CREATE TABLE IF NOT EXISTS anomalies (id bigserial PRIMARY KEY, site_id text NOT NULL, day text NOT NULL, kind text NOT NULL, severity text NOT NULL,
     detail jsonb NOT NULL DEFAULT '{}', opened_at bigint NOT NULL, resolved_at bigint)`,
  `DO $$ BEGIN CREATE UNIQUE INDEX IF NOT EXISTS anomalies_open ON anomalies(site_id, kind) WHERE resolved_at IS NULL; EXCEPTION WHEN duplicate_table OR unique_violation THEN NULL; END $$`,

  // Alerts feed and Web Push (notify.ts). `data.key` dedupes a repeat; `pushed` counts the devices an alert reached (push rate limits).
  `CREATE TABLE IF NOT EXISTS alerts (id bigserial PRIMARY KEY, site_id text NOT NULL, kind text NOT NULL, title text NOT NULL, body text NOT NULL,
     data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz, pushed int NOT NULL DEFAULT 0)`,
  `DO $$ BEGIN CREATE INDEX IF NOT EXISTS alerts_site_at ON alerts(site_id, created_at); EXCEPTION WHEN duplicate_table OR unique_violation THEN NULL; END $$`,
  // One row per browser that turned notifications on: the push endpoint (a bearer capability) and its encryption keys. DB only.
  `CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint text PRIMARY KEY, site_id text NOT NULL, p256dh text NOT NULL, auth text NOT NULL,
     ua text, created_at timestamptz NOT NULL DEFAULT now(), last_ok timestamptz, fails int NOT NULL DEFAULT 0)`,
  // Weekly digests (digest.ts): kWh, counts and confidence tiers only, no rate or dollar figure. One row per ISO week.
  `CREATE TABLE IF NOT EXISTS digests (site_id text NOT NULL, week text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (site_id, week))`,
  // Powerwall commands and rule suggestions (tesla/commands.ts, powerwall.ts): every send, refusal, missing scope and suggestion.
  `CREATE TABLE IF NOT EXISTS powerwall_log (id bigserial PRIMARY KEY, site_id text NOT NULL, at bigint NOT NULL, rule text, command text NOT NULL,
     value jsonb, result text NOT NULL, reason text, source text NOT NULL)`,
  `DO $$ BEGIN CREATE INDEX IF NOT EXISTS powerwall_log_site_at ON powerwall_log(site_id, at); EXCEPTION WHEN duplicate_table OR unique_violation THEN NULL; END $$`,
  // Vacation mode (mockup ak; vacation/trip.ts): one row per trip, planned → active → ended (or cancelled). Times are epoch ms; `data`
  // keeps the trip's log, the departure checklist, what each system remembers for the trip, and the report once it ends.
  `CREATE TABLE IF NOT EXISTS trips (id serial PRIMARY KEY, site_id text NOT NULL, leave_at bigint NOT NULL, back_at bigint, state text NOT NULL,
     started_at bigint, ended_at bigint, ended_by text, detected boolean NOT NULL DEFAULT false, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now())`,
  `DO $$ BEGIN CREATE INDEX IF NOT EXISTS trips_site_state ON trips(site_id, state); EXCEPTION WHEN duplicate_table OR unique_violation THEN NULL; END $$`,
];

/** Run `fn` once and keep its result; a failure is forgotten, so the next call tries again. */
export function onceUntilOk<T>(fn: () => Promise<T>) {
  let p: Promise<T> | null = null;
  return () => (p ??= fn().catch(e => { p = null; throw e; }));
}
// a failed setup is not kept: the next request tries again instead of failing for the rest of the instance's life (October audit)
const migrateOnce = onceUntilOk(async () => { for (const s of SCHEMA) await q(s); await oneTimeMigrations(); });
export function migrate() { return migrateOnce(); }

/** One-time data fixes, each guarded by a kv flag so it runs once per database. Row updates only: no table is dropped,
 *  renamed or rewritten (rule 6). A failure is logged and retried on the next cold start rather than taking the API down. */
export async function oneTimeMigrations() {
  const flag = 'migration:bills-strip-account:v1';
  try {
    if (await kv.get(flag)) return;
    // Bills imported from the old local install carried the PEC account number and the PDF file name inside `raw`.
    // Idempotent: a second run matches no rows. RETURNING only counts the rows for the log line.
    const rows = await q(`UPDATE bills SET raw = raw - 'account' - 'source' WHERE raw ? 'account' OR raw ? 'source' RETURNING bill_date`);
    await kv.set(flag, new Date().toISOString());
    console.log(`[solstice] one-time migration ${flag}: removed account/source from ${rows.length} bill row(s)`);
  } catch (e) { console.error(`[solstice] one-time migration ${flag} failed; it will retry on the next cold start`, e); }
}
