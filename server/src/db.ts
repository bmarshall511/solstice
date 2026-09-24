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
  `CREATE TABLE IF NOT EXISTS soe (site_id text NOT NULL, ts text NOT NULL, epoch bigint NOT NULL, day text NOT NULL, hour smallint NOT NULL, soe real NOT NULL, PRIMARY KEY (site_id, ts))`,
  `CREATE INDEX IF NOT EXISTS soe_site_day ON soe(site_id, day)`,
  `CREATE TABLE IF NOT EXISTS backup_events (site_id text NOT NULL, ts text NOT NULL, epoch bigint NOT NULL, duration_s int NOT NULL, PRIMARY KEY (site_id, ts))`,
  `CREATE TABLE IF NOT EXISTS bills (
     site_id text NOT NULL, bill_date text NOT NULL, period_from text NOT NULL, period_to text NOT NULL,
     delivered_kwh real NOT NULL, received_kwh real NOT NULL, total real NOT NULL, raw jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (site_id, bill_date))`,
  // Which days of history are fully stored, per kind ('energy' | 'soe').
  `CREATE TABLE IF NOT EXISTS synced_days (site_id text NOT NULL, kind text NOT NULL, day text NOT NULL, PRIMARY KEY (site_id, kind, day))`,
  // User-logged events: panel cleanings, notes. Deletable (undo).
  `CREATE TABLE IF NOT EXISTS events (id serial PRIMARY KEY, site_id text NOT NULL, type text NOT NULL, day text NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb NOT NULL)`,
];

let migrated: Promise<void> | null = null;
export function migrate() {
  return (migrated ??= (async () => { for (const s of SCHEMA) await q(s); })());
}
