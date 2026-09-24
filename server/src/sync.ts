// Keeps a site's stored data fresh. Serverless-friendly: nothing runs in the background.
// The app calls it when opened (and every few minutes while open); a nightly cron catches up everything else.
import { q, one, kv } from './db.js';
import { config } from './config.js';
import { teslaFor, rfc3339, localMidnight, localDay, addDays, type EnergyBucket } from './tesla/client.js';

const n = (v: unknown) => (typeof v === 'number' ? v : 0);
const hourOf = (ts: string) => +ts.slice(11, 13);

export async function siteAccount(siteId: string) {
  const s = await one<{ tesla_account_id: number; info_at: string | null }>('SELECT tesla_account_id, info_at FROM sites WHERE id = $1', [siteId]);
  if (!s?.tesla_account_id) throw new Error('This site has no connected Tesla account');
  return s;
}

/** Latest live_status, fetched from Tesla only when the stored one is older than ~25 s. */
export async function refreshLive(siteId: string, maxAgeMs = config.liveMaxAgeMs) {
  const last = await one<{ ts: string }>('SELECT ts FROM readings WHERE site_id = $1 ORDER BY ts DESC LIMIT 1', [siteId]);
  if (last && Date.now() - Number(last.ts) < maxAgeMs) return false;
  const s = await teslaFor((await siteAccount(siteId)).tesla_account_id).liveStatus(siteId);
  const ts = Date.parse(s.timestamp) || Date.now();
  await q(`INSERT INTO readings VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (site_id, ts) DO NOTHING`,
    [siteId, ts, n(s.solar_power), n(s.battery_power), n(s.grid_power), n(s.load_power), n(s.percentage_charged), String(s.grid_status ?? ''), String(s.island_status ?? ''), !!s.storm_mode_active]);
  await kv.set(`${siteId}:lastLive`, Date.now());
  return true;
}

export async function saveEnergy(siteId: string, buckets: EnergyBucket[]) {
  if (!buckets.length) return;
  const cols = buckets.map(b => ({
    ts: b.timestamp, epoch: Date.parse(b.timestamp), day: b.timestamp.slice(0, 10), hour: hourOf(b.timestamp), solar: n(b.solar_energy_exported),
    home: n(b.consumer_energy_imported_from_solar) + n(b.consumer_energy_imported_from_battery) + n(b.consumer_energy_imported_from_grid) + n(b.consumer_energy_imported_from_generator),
    imp: n(b.consumer_energy_imported_from_grid) + n(b.battery_energy_imported_from_grid),
    exp: n(b.grid_energy_exported_from_solar) + n(b.grid_energy_exported_from_battery) + n(b.grid_energy_exported_from_generator),
    chg: n(b.battery_energy_imported_from_solar) + n(b.battery_energy_imported_from_grid) + n(b.battery_energy_imported_from_generator),
    dis: n(b.battery_energy_exported) }));
  await saveEnergyRows(siteId, cols);
}

type EnergyRow = { ts: string; epoch: number; day: string; hour: number; solar: number; home: number; imp: number; exp: number; chg: number; dis: number };
export async function saveEnergyRows(siteId: string, cols: EnergyRow[]) {
  const col = <K extends keyof EnergyRow>(k: K) => cols.map(c => c[k]);
  await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh)
    SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::text[], $5::smallint[], $6::real[], $7::real[], $8::real[], $9::real[], $10::real[], $11::real[])
    ON CONFLICT (site_id, ts) DO UPDATE SET solar_wh = excluded.solar_wh, home_wh = excluded.home_wh, import_wh = excluded.import_wh,
      export_wh = excluded.export_wh, charge_wh = excluded.charge_wh, discharge_wh = excluded.discharge_wh`,
    [siteId, col('ts'), col('epoch'), col('day'), col('hour'), col('solar'), col('home'), col('imp'), col('exp'), col('chg'), col('dis')]);
}

export async function saveSoe(siteId: string, pts: Array<{ timestamp: string; soe: number }>) {
  if (!pts.length) return;
  await q(`INSERT INTO soe (site_id, ts, epoch, day, hour, soe) SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::text[], $5::smallint[], $6::real[])
    ON CONFLICT (site_id, ts) DO UPDATE SET soe = excluded.soe`,
    [siteId, pts.map(p => p.timestamp), pts.map(p => Date.parse(p.timestamp)), pts.map(p => p.timestamp.slice(0, 10)), pts.map(p => hourOf(p.timestamp)), pts.map(p => p.soe)]);
}

async function fetchDay(siteId: string, accountId: number, day: string) {
  const t = teslaFor(accountId), start = localMidnight(day), end = new Date(Math.min(Date.now(), start.getTime() + 864e5 - 1000));
  const [e, s] = await Promise.all([t.energy(siteId, rfc3339(start), rfc3339(end)), t.soe(siteId, rfc3339(start), rfc3339(end))]);
  await saveEnergy(siteId, e.time_series ?? []);
  await saveSoe(siteId, s.time_series ?? []);
}

export async function refreshSiteInfo(siteId: string, accountId: number) {
  const info = await teslaFor(accountId).siteInfo(siteId);
  await q('UPDATE sites SET info = $2, info_at = now(), name = COALESCE(name, $3) WHERE id = $1', [siteId, JSON.stringify(info), String(info.site_name ?? '')]);
}

async function refreshBackups(siteId: string, accountId: number) {
  const res = await teslaFor(accountId).backups(siteId, rfc3339(new Date(Date.now() - 5 * 365 * 864e5)), rfc3339(new Date()));
  // `duration` is documented as seconds but real values are milliseconds (307419 ≈ a 5-minute outage)
  for (const e of res.events ?? []) await q('INSERT INTO backup_events VALUES ($1,$2,$3,$4) ON CONFLICT (site_id, ts) DO UPDATE SET duration_s = excluded.duration_s',
    [siteId, e.timestamp, Date.parse(e.timestamp), Math.round(e.duration / 1000)]);
}

/**
 * Bring a site up to date within a time budget: today's history (if stale), site info (6 h), outages (1 h),
 * then fill in missing past days newest-first. Safe to call often and from many places at once.
 */
export async function syncSite(siteId: string, budgetMs = 8_000) {
  const t0 = Date.now(), acct = await siteAccount(siteId), a = acct.tesla_account_id, today = localDay();
  const done: string[] = [], errors: string[] = [];
  const due = async (key: string, everyMs: number) => { const last = await kv.get<number>(`${siteId}:${key}`); return !last || Date.now() - last > everyMs; };
  const run = async (key: string, fn: () => Promise<unknown>) => { try { await fn(); await kv.set(`${siteId}:${key}`, Date.now()); done.push(key); } catch (e) { errors.push(`${key}: ${(e as Error).message}`); await kv.set(`${siteId}:error:${key}`, { at: Date.now(), message: (e as Error).message }); } };

  await refreshLive(siteId).catch(e => errors.push(`live: ${e.message}`));
  if (!acct.info_at || Date.now() - Date.parse(acct.info_at) > 6 * 3600e3) await run('siteInfo', () => refreshSiteInfo(siteId, a));
  if (await due('lastHistory', config.historyEveryMs)) await run('lastHistory', () => fetchDay(siteId, a, today));
  if (await due('lastBackups', 3600e3)) await run('lastBackups', () => refreshBackups(siteId, a));

  // Missing past days (energy + battery %), newest first
  const have = new Set((await q<{ day: string }>(`SELECT day FROM synced_days WHERE site_id = $1 AND kind = 'day'`, [siteId])).map(r => r.day));
  const installed = (await one<{ d: string }>(`SELECT substr(info->>'installation_date', 1, 10) d FROM sites WHERE id = $1`, [siteId]))?.d;
  const oldest = [addDays(today, -config.backfillDays), installed ?? ''].sort().at(-1)!;
  let filled = 0;
  for (let d = addDays(today, -1); d >= oldest && Date.now() - t0 < budgetMs - 2500; d = addDays(d, -1)) {
    if (have.has(d)) continue;
    try { await fetchDay(siteId, a, d); await q(`INSERT INTO synced_days VALUES ($1, 'day', $2) ON CONFLICT DO NOTHING`, [siteId, d]); filled++; }
    catch (e) { errors.push(`${d}: ${(e as Error).message}`); break; }
  }
  const remaining = Math.max(0, Math.round((Date.parse(today) - Date.parse(oldest)) / 864e5) - have.size - filled);
  return { done, filled, remaining, errors, ms: Date.now() - t0 };
}
