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
  `CREATE TABLE IF NOT EXISTS nest_readings (site_id text NOT NULL, ts bigint NOT NULL, day text NOT NULL, hour smallint NOT NULL, indoor_f real, humidity real, mode text, hvac text, cool_f real, heat_f real, eco boolean, PRIMARY KEY (site_id, ts))`,
  `CREATE INDEX IF NOT EXISTS nest_readings_site_day ON nest_readings(site_id, day)`,
  // Single-owner mode: one row per device that opened the owner link (no account, no user row). Deleting a row signs that device out.
  `CREATE TABLE IF NOT EXISTS owner_sessions (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(), label text)`,
];

let migrated: Promise<void> | null = null;
export function migrate() {
  return (migrated ??= (async () => { for (const s of SCHEMA) await q(s); await oneTimeMigrations(); })());
}

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
