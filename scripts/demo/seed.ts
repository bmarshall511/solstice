// Seeds the demo's PGlite database (scripts/demo-server.mjs) with the synthetic house of model.ts: 5-minute energy and battery %,
// synced-day marks, the site and a Tesla account row with dummy tokens, Nest and pool readings, per-panel readings, outages, bills,
// events, pool tests, the deep back-fill's progress and the kv snapshots the app serves instead of reading a device.
// Never run it against anything but a throwaway PGlite: `seedDemo` refuses any other DATABASE_URL.
import { q, kv, migrate } from '../../server/src/db.js';
import { saveEnergyRows, saveSoe } from '../../server/src/sync.js';
import { saveBill, type Bill } from '../../server/src/bills.js';
import { learnLayout } from '../../server/src/panels.js';
import { localDay, addDays, localMidnight, rfc3339 } from '../../server/src/tesla/client.js';
import { config } from '../../server/src/config.js';
import { deepKey } from '../../server/src/deepBackfill.js';
import type { PoolSnapshot } from '../../server/src/appliances/screenlogic.js';
import type { NestState } from '../../server/src/appliances/nest.js';
import {
  DEMO_SITE_ID, DEMO_DEVICE_ID, POOL, BATTERY, houseDay, batteryRun, nestDay, poolDay, pvsAt, dayWx, hvacAt, pumpRpmAt, pumpWatts, tempAt,
  type Bucket, type EnergyRow,
} from './model.js';

export type SeedOptions = {
  /** Days of history inside syncSite's window (default: all of it, 400, so the app never asks Tesla for a missing day). */
  days?: number;
  /** Days of the deep back-fill (before the window) already stored, going back from the window's start (default 90). */
  deepDays?: number;
  /** Days of the deep range in all, from the install day (default 300): 90 of 300 shows the progress row a third done. */
  deepTotal?: number;
  /** Days of Nest and pool readings (default 60) and of per-panel readings (default 5). */
  deviceDays?: number; pvsDays?: number;
  now?: number;
};
export type SeedResult = {
  site: string; days: number; energy: number; soe: number; synced: number; nest: number; pool: number; pvs: number; bills: number; outages: number;
  installed: string; today: string;
  /** Today's buckets after `now`, for the live ticker (main.ts) to store as time passes. */
  pending: EnergyRow[]; todayBuckets: Bucket[];
};

const assertThrowaway = () => {
  const url = process.env.DATABASE_URL ?? '';
  if (!/^pglite:/.test(url)) throw new Error(`the demo seed only writes to a throwaway PGlite (DATABASE_URL=pglite:…), not ${url.slice(0, 10)}…`);
};
/** Multi-row INSERT in chunks (PGlite takes a few thousand parameters per statement). */
async function insertRows(table: string, cols: string[], rows: unknown[][], casts: string[] = [], tail = 'ON CONFLICT DO NOTHING') {
  const per = Math.max(1, Math.floor(4000 / cols.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per), params: unknown[] = [];
    const values = chunk.map(r => `(${r.map((v, j) => { params.push(v); return `$${params.length}${casts[j] ?? ''}`; }).join(', ')})`).join(', ');
    await q(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values} ${tail}`, params);
  }
}

export const DUMMY_TOKEN = 'demo-synthetic-token-not-a-real-credential';
/** The Fleet API site_info shape, made up: two Powerwall 2s, self-powered, a 20% reserve, Storm Watch on. */
export const siteInfo = (installed: string) => ({
  site_name: 'Demo House', installation_date: `${installed}T09:00:00-05:00`, battery_count: 2, nameplate_energy: 27000, nameplate_power: 10000,
  backup_reserve_percent: BATTERY.reservePct, default_real_mode: 'self_consumption', user_settings: { storm_mode_enabled: true, off_grid_vehicle_charging_enabled: false },
  version: '26.0.0 demo', utility: 'Demo Electric Cooperative', energy_site_id: DEMO_SITE_ID, time_zone_offset: -300,
  components: { solar: true, battery: true, grid: true, batteries: [{ part_name: 'Powerwall 2', nameplate_energy: 13500, nameplate_max_discharge_power: 5000 }, { part_name: 'Powerwall 2', nameplate_energy: 13500, nameplate_max_discharge_power: 5000 }] },
});

/** The controller as the app stores it (kv `<site>:pool:last`), at `at`: the programs of model.ts, the pump as it runs then. */
export function poolSnapshot(at: number): PoolSnapshot {
  const rpm = pumpRpmAt(at), w = dayWx(localDay(new Date(at))), h = +rfc3339(new Date(at)).slice(11, 13);
  const circuits = [{ id: 1, name: 'Spa' }, { id: 2, name: 'Blower' }, { id: 3, name: 'Pool Light' }, { id: 4, name: 'Spa Light' }, { id: 5, name: 'Waterfall' }, { id: 6, name: 'Pool' }, { id: 8, name: 'High Speed' }];
  const on = new Set(rpm === POOL.boostRpm ? [6, 8] : rpm ? [6] : []);
  const waterF = 74 + 13 * Math.cos(2 * Math.PI * ((Date.parse(localDay(new Date(at))) - Date.UTC(new Date(at).getUTCFullYear(), 0, 1)) / 864e5 - 215) / 365);
  return {
    at, version: 'POOL: 5.2 Build 000.0 Rel (demo)', airTemp: Math.round(tempAt(w, h)), freezeMode: false,
    bodies: [{ id: 1, temp: Math.round(waterF), setPoint: 0, heatMode: 0, heating: false }, { id: 2, temp: Math.round(waterF) + 1, setPoint: 100, heatMode: 0, heating: false }],
    circuits: circuits.map(c => ({ ...c, on: on.has(c.id), freeze: false, function: c.id === 6 ? 2 : c.id === 1 ? 1 : 0 })),
    pump: { id: 1, name: 'Pump 1', running: rpm > 0, watts: pumpWatts(rpm), rpm, gpm: null, minRpm: 450, maxRpm: 3450, primingRpm: 2500,
      circuits: [{ circuitId: 6, speed: POOL.poolRpm, isRpm: true }, { circuitId: 8, speed: POOL.boostRpm, isRpm: true }, { circuitId: 5, speed: 3000, isRpm: true }, { circuitId: 1, speed: 3190, isRpm: true }] },
    schedules: [
      { id: 1, circuitId: POOL.poolCircuit, start: POOL.poolStart * 60, stop: POOL.poolStop * 60, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 },
      { id: 2, circuitId: POOL.boostCircuit, start: POOL.boostStart * 60, stop: POOL.boostStop * 60, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 },
      { id: 3, circuitId: 3, start: 19 * 60 + 30, stop: 22 * 60, dayMask: 127, flags: 0, heatCmd: 4, heatSetPoint: 70 },
    ],
    runOnce: [],
  };
}
/** The thermostat as the app stores it (kv `nest:last`), at `at`. */
export function nestState(at: number): NestState {
  const day = localDay(new Date(at)), s = hvacAt(at, dayWx(day)), r = nestDay(day, day, at + 1).at(-1);
  return { at, deviceId: DEMO_DEVICE_ID, name: 'Hallway', online: true, indoorF: r?.indoor_f ?? 77.6, humidity: r?.humidity ?? 50, mode: s.mode, hvac: s.hvac,
    coolF: s.coolF, heatF: s.heatF, eco: false, ecoCoolF: 82, ecoHeatF: 55, fanTimer: false, fanUntil: null, availableModes: ['HEAT', 'COOL', 'HEATCOOL', 'OFF'] };
}

/** Write the synthetic history. Returns row counts and today's not-yet-stored buckets. */
export async function seedDemo(o: SeedOptions = {}): Promise<SeedResult> {
  assertThrowaway();
  await migrate();
  const now = o.now ?? Date.now(), today = localDay(new Date(now)), id = DEMO_SITE_ID;
  const days = Math.min(o.days ?? config.backfillDays, config.backfillDays), deepDays = o.deepDays ?? 90, deepTotal = Math.max(o.deepTotal ?? 300, deepDays);
  const deviceDays = o.deviceDays ?? 60, pvsDays = o.pvsDays ?? 5;
  // the deep range ends the day before syncSite's window (deepBackfill.ts deepRange); the install day is deepTotal days before that
  const through = addDays(today, -config.backfillDays - 1), installed = addDays(through, -deepTotal + 1);
  const first = deepDays > 0 && days >= config.backfillDays ? addDays(through, -deepDays + 1) : addDays(today, -days);
  const cleanedOn = addDays(today, -45);

  /* ---------- the site, a Tesla account with dummy tokens (never refreshed: they expire in a year) ---------- */
  const acct = (await q<{ id: number }>(`INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at, scope) VALUES (NULL, $1, $1, $2, $3) RETURNING id`,
    [DUMMY_TOKEN, now + 365 * 864e5, 'openid offline_access energy_device_data']))[0].id;
  await q(`INSERT INTO sites (id, user_id, tesla_account_id, name, info, info_at) VALUES ($1, NULL, $2, $3, $4, now()) ON CONFLICT (id) DO UPDATE SET tesla_account_id = excluded.tesla_account_id, info = excluded.info, info_at = now()`,
    [id, acct, 'Demo House', JSON.stringify(siteInfo(installed))]);

  /* ---------- energy and battery %: one continuous run from the first day to now ---------- */
  let soc = BATTERY.kwh * 1000 * .6, energy = 0, soe = 0, pending: EnergyRow[] = [], todayBuckets: Bucket[] = [];
  let chunk: EnergyRow[] = [];
  const flush = async () => {
    if (!chunk.length) return;
    await saveEnergyRows(id, chunk); energy += chunk.length;
    const pts = chunk.filter(r => +r.ts.slice(14, 16) % 15 === 0).map(r => ({ timestamp: r.ts, soe: r.soc }));
    await saveSoe(id, pts); soe += pts.length; chunk = [];
  };
  for (let d = first; d <= today; d = addDays(d, 1)) {
    const buckets = houseDay(d, { today, cleanedOn }), run = batteryRun(buckets, soc); soc = run.soc;
    if (d === today) {
      todayBuckets = buckets;
      const done = run.rows.filter(r => r.epoch + 300_000 <= now); pending = run.rows.filter(r => r.epoch + 300_000 > now);
      chunk.push(...done);
    } else chunk.push(...run.rows);
    if (chunk.length >= 2016) await flush();
  }
  await flush();
  // past days marked synced with their bucket counts, as markSynced does (one statement for all of them)
  const synced = (await q(`INSERT INTO synced_days (site_id, kind, day, buckets) SELECT $1, 'day', day, COUNT(*)::int FROM energy WHERE site_id = $1 AND day < $2 GROUP BY day
    ON CONFLICT (site_id, kind, day) DO UPDATE SET buckets = excluded.buckets RETURNING day`, [id, today])).length;
  // the deep back-fill (deepBackfill.ts): stored from the window's start back to the cursor; the rest still to come
  if (deepDays > 0 && first <= through) await kv.set(deepKey(id), { from: installed, through, cursor: addDays(first, -1), empty: [], skipped: [], tries: {}, at: now - 3 * 3600e3, filled: deepDays, last: [first, addDays(first, 1), addDays(first, 2)] });

  /* ---------- Nest and pool readings (the last 60 days), per-panel readings (the last 5 days and today) ---------- */
  const nestRows: unknown[][] = [], poolRows: unknown[][] = [];
  for (let d = addDays(today, -deviceDays); d <= today; d = addDays(d, 1)) {
    for (const r of nestDay(d, today, now)) nestRows.push([id, r.ts, r.day, r.hour, r.indoor_f, r.humidity, r.mode, r.hvac, r.cool_f, r.heat_f, r.eco]);
    for (const r of poolDay(d, today, now)) poolRows.push([id, r.ts, r.day, r.hour, r.running, r.watts, r.rpm, r.water_temp, r.air_temp, JSON.stringify(r.circuits)]);
  }
  await insertRows('nest_readings', ['site_id', 'ts', 'day', 'hour', 'indoor_f', 'humidity', 'mode', 'hvac', 'cool_f', 'heat_f', 'eco'], nestRows);
  await insertRows('pool_readings', ['site_id', 'ts', 'day', 'hour', 'running', 'watts', 'rpm', 'water_temp', 'air_temp', 'circuits'], poolRows, ['', '', '', '', '', '', '', '', '', '::jsonb']);
  const pvsRows: unknown[][] = [];
  const lifetime = new Map<string, number>();
  for (let d = addDays(today, -pvsDays); d <= today; d = addDays(d, 1)) {
    const bs = d === today ? todayBuckets.filter(b => b.epoch + 300_000 <= now) : houseDay(d, { today, cleanedOn });
    for (const b of bs) if (b.solarKw > 0) for (const p of pvsAt(b.epoch, b.solarKw, b.outdoorF)) {
      const kwh = (lifetime.get(p.sn) ?? 9000 + (p.sn.charCodeAt(p.sn.length - 1) % 7) * 40) + p.kw / 12; lifetime.set(p.sn, kwh);
      pvsRows.push([new Date(b.epoch + 300_000).toISOString(), p.sn, p.kw, p.v, p.tempC, p.kwDc, Math.round(kwh * 1000) / 1000]);
    }
  }
  await insertRows('pvs_readings', ['ts', 'sn', 'kw', 'v', 'temp_c', 'kw_dc', 'kwh_lifetime'], pvsRows, ['::timestamptz', '', '::numeric', '::numeric', '::numeric', '::numeric', '::numeric']);
  if (pvsRows.length) { await learnLayout([...new Set(pvsRows.map(r => String(r[1])))].sort(), now); await kv.set('pvs:since', addDays(today, -pvsDays)); }

  /* ---------- outages (Tesla's backup history; duration in seconds as stored) ---------- */
  const outages = [{ ago: 230, h: 3.2, s: 47 * 60 }, { ago: 96, h: 16.6, s: 6 * 60 }, { ago: 19, h: 21.4, s: 128 * 60 }].filter(x => x.ago <= days);
  for (const x of outages) { const at = localMidnight(addDays(today, -x.ago)).getTime() + x.h * 3600e3; await q(`INSERT INTO backup_events VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [id, rfc3339(new Date(at)), at, x.s]); }

  /* ---------- bills: three made-up monthly periods ending on the 11th, totals from the seeded energy at published PEC-style rates ---------- */
  let bills = 0;
  const monthAdd = (d: string, n: number) => { const m = +d.slice(0, 4) * 12 + +d.slice(5, 7) - 1 + n; return `${Math.floor(m / 12)}-${String(m % 12 + 1).padStart(2, '0')}${d.slice(7)}`; };
  const lastTo = monthAdd(`${today.slice(0, 8)}11`, +today.slice(8) >= 15 ? 0 : -1);
  for (let k = 0; k < 3; k++) {
    const to = monthAdd(lastTo, -k), from = addDays(monthAdd(to, -1), 1);
    if (from < first) break;
    const r = (await q<{ imp: number; exp: number }>(`SELECT (SUM(import_wh) / 1000.0)::float8 imp, (SUM(export_wh) / 1000.0)::float8 exp FROM energy WHERE site_id = $1 AND day BETWEEN $2 AND $3`, [id, from, to]))[0];
    const del = Math.round((r?.imp ?? 0) * 1.01), rec = Math.round((r?.exp ?? 0) * .99), days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
    const c = (label: string, kwh: number | null, rate: number | null, amount: number) => ({ label, kwh, rate, amount: Math.round(amount * 100) / 100 });
    const charges = [c('Service Availability Charge', null, null, 32.5), c('Energy Charge', del, .072, del * .072), c('Power Cost Recovery Charge', del, .030346, del * .030346),
      c('Distributed Generation Credit', rec, -.071921, -rec * .071921)];
    const pre = charges.filter(x => x.amount > 0).reduce((a, x) => a + x.amount, 0);
    charges.push(c('Franchise Fee', null, null, pre * .0396));
    const total = Math.round(charges.reduce((a, x) => a + x.amount, 0) * 100) / 100, billDate = addDays(to, 4);
    const bill: Bill = { utility: 'PEC', billDate, dueDate: addDays(billDate, 21), period: { from, to, days }, deliveredKwh: del, receivedKwh: rec, total, charges,
      tariff: { importRate: .102346, importRateAllIn: +(.102346 * 1.0396).toFixed(5), exportCredit: .071921, fixedMonthly: 32.5, discounts: 0, franchisePct: .0396 },
      checks: { lineItemsSumToTotal: true, registersConsistent: true } };
    await saveBill(id, bill); bills++;
  }

  /* ---------- the owner's log: a panel cleaning, the pool filter, a note; three water tests ---------- */
  await q(`INSERT INTO events (site_id, type, day, note) VALUES ($1, 'cleaned', $2, 'Hosed the panels (demo)'), ($1, 'filter_cleaned', $3, NULL), ($1, 'note', $4, 'Demo: new fridge')`,
    [id, cleanedOn, addDays(today, -20), addDays(today, -33)]);
  for (const [ago, fc, ph, clarity] of [[12, 3.5, 7.6, 'clear'], [6, 2.0, 7.8, 'hazy'], [2, 4.0, 7.5, 'clear']] as const) {
    const at = localMidnight(addDays(today, -ago)).getTime() + 18 * 3600e3;
    await q(`INSERT INTO pool_tests (site_id, at, day, fc, ph, cc, ta, cya, ch, clarity, added, source, water_f) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, at, addDays(today, -ago), fc, ph, .2, 90, 50, 300, clarity, JSON.stringify(ago === 6 ? ['liquid chlorine'] : []), 'kit', 78]);
  }

  /* ---------- kv: settings, the device snapshots, the sync clocks ---------- */
  await kv.set('settings:owner', { ownerName: 'Demo', calm: false });
  await kv.set('nest:tokens', { access_token: DUMMY_TOKEN, refresh_token: DUMMY_TOKEN, expires_at: now + 365 * 864e5 });
  await refreshSnapshots(now);

  return { site: id, days, energy, soe, synced, nest: nestRows.length, pool: poolRows.length, pvs: pvsRows.length, bills, outages: outages.length, installed, today, pending, todayBuckets };
}

/**
 * Keep the app from asking Tesla or a device: the pool and Nest snapshots dated now (younger than the one-minute read window), the
 * live/history/backups/site-info clocks fresh, and the three cron ledgers recent (Data health). The live ticker calls this every 15 s.
 */
export async function refreshSnapshots(now = Date.now()) {
  const id = DEMO_SITE_ID;
  await kv.set(`${id}:pool:last`, poolSnapshot(now));
  await kv.set('nest:last', nestState(now));
  for (const k of ['lastLive', 'lastHistory', 'lastBackups', 'lastBackupsFull']) await kv.set(`${id}:${k}`, now);
  await q(`UPDATE sites SET info_at = now() WHERE id = $1`, [id]);
  const rec = (ms: number, steps: Record<string, number>) => ({ at: now - 60_000, ms, steps, ok: true, errors: [] });
  await kv.set('cron:nest:last', rec(900, { sampling: 420, 'watch.storm': 60, 'watch.ercot': 40 }));
  if (!(await kv.get('cron:pool:last'))) await kv.set('cron:pool:last', { ...rec(1800, { plan: 1500 }), at: localMidnight(addDays(localDay(new Date(now)), -1)).getTime() + 20.25 * 3600e3 });
}
