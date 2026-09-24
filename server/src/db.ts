import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { config } from './config.ts';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- live_status snapshots (every 30 s)
  CREATE TABLE IF NOT EXISTS readings (
    ts                INTEGER PRIMARY KEY,   -- epoch ms
    solar_w           REAL,
    battery_w         REAL,                  -- + discharging, − charging
    grid_w            REAL,                  -- + importing,   − exporting
    load_w            REAL,
    soc               REAL,                  -- percentage_charged, 0–100
    energy_left_wh    REAL,
    total_pack_wh     REAL,
    grid_status       TEXT,
    island_status     TEXT,
    storm_mode_active INTEGER,
    raw               TEXT
  );

  -- calendar_history kind=energy buckets (Wh per bucket)
  CREATE TABLE IF NOT EXISTS energy (
    ts          TEXT PRIMARY KEY,            -- bucket start, RFC3339 with offset
    epoch       INTEGER NOT NULL,
    solar_wh    REAL,
    home_wh     REAL,
    import_wh   REAL,
    export_wh   REAL,
    charge_wh   REAL,
    discharge_wh REAL,
    raw         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS energy_epoch ON energy(epoch);

  -- calendar_history kind=backup (grid outages)
  CREATE TABLE IF NOT EXISTS backup_events (
    ts         TEXT PRIMARY KEY,
    epoch      INTEGER NOT NULL,
    duration_s INTEGER NOT NULL
  );

  -- calendar_history kind=soe (battery %, 15-min) — undocumented but works
  CREATE TABLE IF NOT EXISTS soe (
    ts    TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL,
    soe   REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS soe_epoch ON soe(epoch);

  -- PEC bills (parsed from PDF or entered by hand)
  CREATE TABLE IF NOT EXISTS bills (
    bill_date   TEXT PRIMARY KEY,
    period_from TEXT NOT NULL,
    period_to   TEXT NOT NULL,
    delivered_kwh REAL NOT NULL,
    received_kwh  REAL NOT NULL,
    total       REAL NOT NULL,
    raw         TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS site_info (
    fetched_at INTEGER PRIMARY KEY,
    raw        TEXT NOT NULL
  );
`);

export const kv = {
  get<T>(key: string): T | undefined {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  },
  set(key: string, value: unknown) {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  },
  delete(key: string) {
    db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  },
};
