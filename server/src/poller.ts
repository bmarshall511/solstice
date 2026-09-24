import { db, kv } from './db.ts';
import { config } from './config.ts';
import { isConnected } from './tesla/auth.ts';
import { tesla, rfc3339, localMidnight, type EnergyBucket } from './tesla/client.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const n = (v: unknown) => (typeof v === 'number' ? v : 0);
const orNull = (v: unknown) => (typeof v === 'number' ? v : null); // fields some sites never report
const localDay = (d: Date) => rfc3339(d).slice(0, 10);

export async function ensureSite(): Promise<string> {
  const known = kv.get<string>('tesla.siteId');
  if (known) return known;
  const products = await tesla.products();
  const site = products.find(p => p.energy_site_id);
  if (!site) throw new Error('No energy site found on this Tesla account.');
  const siteId = String(site.energy_site_id);
  kv.set('tesla.siteId', siteId);
  kv.set('tesla.product', site);
  return siteId;
}

export async function pollLive(siteId: string) {
  const s = await tesla.liveStatus(siteId);
  const ts = Date.parse(s.timestamp) || Date.now();
  db.prepare(`INSERT OR REPLACE INTO readings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ts, n(s.solar_power), n(s.battery_power), n(s.grid_power), n(s.load_power), n(s.percentage_charged),
    orNull(s.energy_left), orNull(s.total_pack_energy), String(s.grid_status ?? ''), String(s.island_status ?? ''), s.storm_mode_active ? 1 : 0, JSON.stringify(s));
  kv.set('poll.lastLive', Date.now());
  return s;
}

function saveEnergy(buckets: EnergyBucket[]) {
  const stmt = db.prepare(`INSERT OR REPLACE INTO energy VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const b of buckets) {
    const home = n(b.consumer_energy_imported_from_solar) + n(b.consumer_energy_imported_from_battery) + n(b.consumer_energy_imported_from_grid) + n(b.consumer_energy_imported_from_generator);
    const imp = n(b.consumer_energy_imported_from_grid) + n(b.battery_energy_imported_from_grid);
    const exp = n(b.grid_energy_exported_from_solar) + n(b.grid_energy_exported_from_battery) + n(b.grid_energy_exported_from_generator);
    const charge = n(b.battery_energy_imported_from_solar) + n(b.battery_energy_imported_from_grid) + n(b.battery_energy_imported_from_generator);
    stmt.run(b.timestamp, Date.parse(b.timestamp), n(b.solar_energy_exported), home, imp, exp, charge, n(b.battery_energy_exported), JSON.stringify(b));
  }
}

/** Fetch one local calendar day of energy history. */
export async function fetchDay(siteId: string, day: string) {
  const start = localMidnight(day), end = new Date(Math.min(Date.now(), start.getTime() + 864e5 - 1000));
  const res = await tesla.energyHistory(siteId, rfc3339(start), rfc3339(end), 'day');
  saveEnergy(res.time_series ?? []);
  return res.time_series?.length ?? 0;
}

export async function pollToday(siteId: string) {
  const count = await fetchDay(siteId, localDay(new Date()));
  kv.set('poll.lastHistory', Date.now());
  return count;
}

export async function pollBackups(siteId: string) {
  const res = await tesla.backupHistory(siteId, rfc3339(new Date(Date.now() - 5 * 365 * 864e5)), rfc3339(new Date()));
  const stmt = db.prepare('INSERT OR REPLACE INTO backup_events VALUES (?,?,?)');
  // `duration` is documented as seconds, but real values are milliseconds (e.g. 307419 ≈ a 5-minute outage)
  for (const e of res.events ?? []) stmt.run(e.timestamp, Date.parse(e.timestamp), Math.round(e.duration / 1000));
  return res.events?.length ?? 0;
}

export async function pollSiteInfo(siteId: string) {
  const info = await tesla.siteInfo(siteId);
  db.prepare('INSERT INTO site_info VALUES (?, ?)').run(Date.now(), JSON.stringify(info));
  kv.set('tesla.siteInfo', info);
  return info;
}

// Days whose history is fully stored (shared by the background backfill and targeted range loads).
let doneDays: Set<string> | null = null;
const done = () => (doneDays ??= new Set(kv.get<string[]>('backfill.days') ?? []));
const markDone = (day: string) => { done().add(day); kv.set('backfill.days', [...done()]); };

/** Load specific past days first (e.g. a bill period), oldest to newest. */
export async function fetchRange(siteId: string, from: string, to: string) {
  const days: string[] = [];
  for (let d = localMidnight(from); localDay(d) <= to && d.getTime() < Date.now() - 864e5; d = new Date(d.getTime() + 864e5 + 3600e3)) {
    const day = localDay(d); if (days.at(-1) !== day) days.push(day);
  }
  for (const day of days) {
    if (done().has(day)) continue;
    try { await fetchDay(siteId, day); markDone(day); } catch (e) { log(`range ${day} failed:`, (e as Error).message); }
    await sleep(1200);
  }
  log(`range ${from}→${to} loaded (${days.length} days)`);
}

/** Walk backwards one day at a time until `from`, skipping days already stored. Rate-limited and resumable. */
let backfilling = false;
export async function backfill(siteId: string, from: string) {
  if (backfilling) return;
  backfilling = true;
  try {
    const days: string[] = [];
    for (let d = new Date(Date.now() - 864e5); localDay(d) >= from; d = new Date(d.getTime() - 864e5)) days.push(localDay(d));
    kv.set('backfill.target', { from, total: days.length });
    for (const day of days) {
      if (done().has(day)) continue;
      try {
        const count = await fetchDay(siteId, day);
        markDone(day);
        if (done().size % 25 === 0) log(`backfill: ${done().size}/${days.length} days (latest ${day}, ${count} buckets)`);
      } catch (e) {
        log(`backfill ${day} failed:`, (e as Error).message);
        await sleep(10_000);
      }
      await sleep(1200); // stay well under the 60 req/min data limit
    }
    log(`backfill complete: ${done().size} days`);
    kv.set('backfill.completedAt', Date.now());
  } finally {
    backfilling = false;
  }
}

let timers: NodeJS.Timeout[] = [];
export function startPolling() {
  if (!isConnected() || timers.length) return;
  const run = (label: string, fn: (siteId: string) => Promise<unknown>) => async () => {
    try { await fn(await ensureSite()); } catch (e) { log(`${label} failed:`, (e as Error).message); kv.set(`poll.error.${label}`, { at: Date.now(), message: (e as Error).message }); }
  };
  const live = run('live', pollLive), today = run('history', pollToday), info = run('siteInfo', pollSiteInfo), backups = run('backups', pollBackups);
  live(); today(); info(); backups();
  timers = [
    setInterval(live, config.livePollMs),
    setInterval(today, config.historyPollMs),
    setInterval(info, 60 * 60_000),
    setInterval(backups, 60 * 60_000),
  ];
  log('polling started');
}
