// Keeps a site's stored data fresh. Serverless-friendly: nothing runs in the background.
// The app calls it when opened (and every few minutes while open); a nightly cron catches up everything else.
import { q, one, kv } from './db.js';
import { config } from './config.js';
import { teslaFor, rfc3339, localDay, addDays, dayWindow, type EnergyBucket } from './tesla/client.js';

const n = (v: unknown) => (typeof v === 'number' ? v : 0);
const hourOf = (ts: string) => +ts.slice(11, 13);

/** Tesla's per-path energy for each bucket, Wh: `energy` column → calendar_history field. This site has no generator, so those paths are left out. */
export const SPLITS = {
  solar_home_wh: 'consumer_energy_imported_from_solar',
  solar_battery_wh: 'battery_energy_imported_from_solar',
  solar_grid_wh: 'grid_energy_exported_from_solar',
  battery_home_wh: 'consumer_energy_imported_from_battery',
  battery_grid_wh: 'grid_energy_exported_from_battery',
  grid_home_wh: 'consumer_energy_imported_from_grid',
  grid_battery_wh: 'battery_energy_imported_from_grid',
} as const;
type SplitCol = keyof typeof SPLITS;
const SPLIT_COLS = Object.keys(SPLITS) as SplitCol[];
const hasSplit = (b: EnergyBucket) => SPLIT_COLS.some(c => typeof b[SPLITS[c]] === 'number');

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
    dis: n(b.battery_energy_exported),
    // A split Tesla didn't send is stored as NULL, not 0, so "unknown" never reads as "none".
    ...Object.fromEntries(SPLIT_COLS.map(c => [c, typeof b[SPLITS[c]] === 'number' ? b[SPLITS[c]] : null])) }));
  await saveEnergyRows(siteId, cols);
}

type EnergyRow = { ts: string; epoch: number; day: string; hour: number; solar: number; home: number; imp: number; exp: number; chg: number; dis: number }
  & Partial<Record<SplitCol, number | null>>;
export async function saveEnergyRows(siteId: string, cols: EnergyRow[]) {
  const col = <K extends keyof EnergyRow>(k: K) => cols.map(c => c[k] ?? null);
  // A row without splits (an old import, or a payload that lacks them) never overwrites splits already stored.
  await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh, ${SPLIT_COLS.join(', ')})
    SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::text[], $5::smallint[], $6::real[], $7::real[], $8::real[], $9::real[], $10::real[], $11::real[],
      ${SPLIT_COLS.map((_, i) => `$${12 + i}::real[]`).join(', ')})
    ON CONFLICT (site_id, ts) DO UPDATE SET solar_wh = excluded.solar_wh, home_wh = excluded.home_wh, import_wh = excluded.import_wh,
      export_wh = excluded.export_wh, charge_wh = excluded.charge_wh, discharge_wh = excluded.discharge_wh,
      ${SPLIT_COLS.map(c => `${c} = COALESCE(excluded.${c}, energy.${c})`).join(', ')}`,
    [siteId, col('ts'), col('epoch'), col('day'), col('hour'), col('solar'), col('home'), col('imp'), col('exp'), col('chg'), col('dis'), ...SPLIT_COLS.map(c => col(c))]);
}

export async function saveSoe(siteId: string, pts: Array<{ timestamp: string; soe: number }>) {
  if (!pts.length) return;
  await q(`INSERT INTO soe (site_id, ts, epoch, day, hour, soe) SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::text[], $5::smallint[], $6::real[])
    ON CONFLICT (site_id, ts) DO UPDATE SET soe = excluded.soe`,
    [siteId, pts.map(p => p.timestamp), pts.map(p => Date.parse(p.timestamp)), pts.map(p => p.timestamp.slice(0, 10)), pts.map(p => hourOf(p.timestamp)), pts.map(p => p.soe)]);
}

/** One local day from Tesla (energy buckets + battery %), asked for with the DST-safe window (23, 24 or 25 hours). */
async function pullDay(siteId: string, accountId: number, day: string) {
  const t = teslaFor(accountId), w = dayWindow(day), start = rfc3339(w.start), end = rfc3339(w.end);
  const [e, s] = await Promise.all([t.energy(siteId, start, end), t.soe(siteId, start, end)]);
  return { energy: e.time_series ?? [], soe: s.time_series ?? [] };
}

async function fetchDay(siteId: string, accountId: number, day: string) {
  const { energy, soe } = await pullDay(siteId, accountId, day);
  await saveEnergy(siteId, energy);
  await saveSoe(siteId, soe);
}

/**
 * Mark a past day synced and record how many energy buckets are stored for it. A day with none stays unmarked, so a later sync
 * fetches it again. Returns the stored count (0 = not marked).
 */
export async function markSynced(siteId: string, day: string) {
  const r = await one<{ buckets: number }>(`INSERT INTO synced_days (site_id, kind, day, buckets)
    SELECT $1::text, 'day', $2::text, COUNT(*)::int FROM energy WHERE site_id = $1 AND day = $2 HAVING COUNT(*) > 0
    ON CONFLICT (site_id, kind, day) DO UPDATE SET buckets = excluded.buckets RETURNING buckets`, [siteId, day]);
  return r?.buckets ?? 0;
}

/**
 * Coverage check: days marked synced that hold fewer 5-minute buckets than the local day has (276 on the DST-start day, 300 on
 * the fall-back day, 288 otherwise), oldest first. Anything under 276 is short on every day.
 * $1 site, $2 time zone, $3 first day not looked at (yesterday, so today and yesterday are skipped), $4 days to leave alone, $5 limit.
 */
export const SHORT_DAYS_SQL = `
  SELECT day, buckets, expected FROM (
    SELECT s.day, COUNT(e.ts)::int AS buckets,
           (EXTRACT(EPOCH FROM ((s.day::date + 1)::timestamp AT TIME ZONE $2) - (s.day::date::timestamp AT TIME ZONE $2)) / 300)::int AS expected
    FROM synced_days s LEFT JOIN energy e ON e.site_id = s.site_id AND e.day = s.day
    WHERE s.site_id = $1 AND s.kind = 'day' AND s.day < $3 AND s.day <> ALL($4::text[])
    GROUP BY s.day) c
  WHERE buckets < expected
  ORDER BY day LIMIT $5`;

const COVERAGE_DAYS = 3, COVERAGE_TRIES = 3;

/**
 * Re-fetch up to 3 short days with the corrected window. A day is replaced only when Tesla now returns more of it than is stored,
 * so a bad answer never makes a day worse. Each day gets at most 3 nightly tries, so a day Tesla can't complete doesn't block the rest.
 */
async function refetchShortDays(siteId: string, accountId: number, stopAt: number, errors: string[]) {
  const key = `${siteId}:coverage`, tries = (await kv.get<Record<string, number>>(key)) ?? {};
  const spent = Object.keys(tries).filter(d => tries[d] >= COVERAGE_TRIES);
  const short = await q<{ day: string; buckets: number; expected: number }>(SHORT_DAYS_SQL, [siteId, config.timeZone, addDays(localDay(), -1), spent, COVERAGE_DAYS]);
  const refetched: string[] = [];
  for (const { day, buckets, expected } of short) {
    if (Date.now() > stopAt) break;
    tries[day] = (tries[day] ?? 0) + 1;
    try {
      const got = await pullDay(siteId, accountId, day);
      let stored = buckets;
      if (got.energy.filter(b => b.timestamp.slice(0, 10) === day).length > buckets) {
        // One statement, so one transaction: the day's energy rows and its synced marker are removed together.
        await q(`WITH e AS (DELETE FROM energy WHERE site_id = $1 AND day = $2), m AS (DELETE FROM synced_days WHERE site_id = $1 AND kind = 'day' AND day = $2)
          SELECT 1`, [siteId, day]);
        await saveEnergy(siteId, got.energy);
        await saveSoe(siteId, got.soe);
        stored = await markSynced(siteId, day);
      }
      if (stored >= expected) delete tries[day];
      refetched.push(`${day} ${buckets}→${stored}/${expected}`);
    } catch (e) { errors.push(`coverage ${day}: ${(e as Error).message}`); break; }
  }
  if (short.length) {
    await kv.set(key, tries);
    console.log(`[sync] coverage check refetched ${refetched.length} short day(s): ${refetched.join(', ') || 'none'}`);
  }
  return refetched;
}

/**
 * Days whose stored buckets carry none of Tesla's per-path split yet (stored before those columns existed), oldest first.
 * $1 site, $2 back-fill cursor (days after it), $3 today (days before it), $4 limit. `remaining` counts every such day, not just the ones returned.
 */
export const SPLIT_TODO_SQL = `
  SELECT day, COUNT(*) OVER ()::int AS remaining FROM (
    SELECT DISTINCT day FROM energy
    WHERE site_id = $1 AND day > $2 AND day < $3
      AND COALESCE(solar_home_wh, solar_battery_wh, solar_grid_wh, battery_home_wh, battery_grid_wh, grid_home_wh, grid_battery_wh) IS NULL) d
  ORDER BY day LIMIT $4`;

const SPLIT_DAYS = 30;

/**
 * Back-fill the per-path split for up to 30 of the oldest days, one energy call per day. A cursor in kv remembers the last day done,
 * so a day Tesla returns without splits is passed rather than retried forever. A Tesla error stops the run; that day is retried next night.
 */
async function backfillSplits(siteId: string, accountId: number, stopAt: number, errors: string[]) {
  const key = `${siteId}:splits`, through = (await kv.get<{ through: string }>(key))?.through ?? '';
  const todo = await q<{ day: string; remaining: number }>(SPLIT_TODO_SQL, [siteId, through, localDay(), SPLIT_DAYS]);
  const t = teslaFor(accountId);
  let last = through, filled = 0, withoutSplits = 0;
  for (const { day } of todo) {
    if (Date.now() > stopAt) break;
    try {
      const w = dayWindow(day), buckets = (await t.energy(siteId, rfc3339(w.start), rfc3339(w.end))).time_series ?? [];
      await saveEnergy(siteId, buckets);
      if (buckets.some(hasSplit)) filled++; else withoutSplits++;
      last = day;
    } catch (e) { errors.push(`splits ${day}: ${(e as Error).message}`); break; }
  }
  const remaining = Math.max(0, (todo[0]?.remaining ?? 0) - filled - withoutSplits);
  if (todo.length) {
    await kv.set(key, { through: last, at: Date.now(), filled, withoutSplits, remaining });
    console.log(`[sync] split back-fill: ${filled} day(s) back-filled${withoutSplits ? `, ${withoutSplits} without split data from Tesla` : ''}, ${remaining} remain`);
  }
  return { filled, withoutSplits, remaining };
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
 * `nightly` (the sync cron only) then runs the coverage check and the split back-fill while the budget lasts.
 */
export async function syncSite(siteId: string, budgetMs = 8_000, opts: { nightly?: boolean } = {}) {
  const t0 = Date.now(), acct = await siteAccount(siteId), a = acct.tesla_account_id, today = localDay();
  const done: string[] = [], errors: string[] = [];
  const due = async (key: string, everyMs: number) => { const last = await kv.get<number>(`${siteId}:${key}`); return !last || Date.now() - last > everyMs; };
  const run = async (key: string, fn: () => Promise<unknown>) => { try { await fn(); await kv.set(`${siteId}:${key}`, Date.now()); done.push(key); } catch (e) { errors.push(`${key}: ${(e as Error).message}`); await kv.set(`${siteId}:error:${key}`, { at: Date.now(), message: (e as Error).message }); } };

  await refreshLive(siteId).catch(e => errors.push(`live: ${e.message}`));
  if (!acct.info_at || Date.now() - Date.parse(acct.info_at) > 6 * 3600e3) await run('siteInfo', () => refreshSiteInfo(siteId, a));
  if (await due('lastHistory', config.historyEveryMs)) await run('lastHistory', () => fetchDay(siteId, a, today));
  if (await due('lastBackups', 3600e3)) await run('lastBackups', () => refreshBackups(siteId, a));

  // Missing past days (energy + battery %), newest first. A day is marked synced only when it stored at least one bucket. A day that
  // comes back empty stays unmarked and rests for 20 h, so the app's "days left" loop can finish; after that a sync tries it again.
  const have = new Set((await q<{ day: string }>(`SELECT day FROM synced_days WHERE site_id = $1 AND kind = 'day'`, [siteId])).map(r => r.day));
  const emptyKey = `${siteId}:emptyDays`, empty = (await kv.get<Record<string, number>>(emptyKey)) ?? {};
  const resting = (d: string) => Date.now() - (empty[d] ?? 0) < 20 * 3600e3;
  const installed = (await one<{ d: string }>(`SELECT substr(info->>'installation_date', 1, 10) d FROM sites WHERE id = $1`, [siteId]))?.d;
  const oldest = [addDays(today, -config.backfillDays), installed ?? ''].sort().at(-1)!;
  let filled = 0, emptyChanged = false;
  for (let d = addDays(today, -1); d >= oldest && Date.now() - t0 < budgetMs - 2500; d = addDays(d, -1)) {
    if (have.has(d) || resting(d)) continue;
    try {
      await fetchDay(siteId, a, d);
      if (await markSynced(siteId, d)) { filled++; if (d in empty) { delete empty[d]; emptyChanged = true; } }
      else { empty[d] = Date.now(); emptyChanged = true; }
    } catch (e) { errors.push(`${d}: ${(e as Error).message}`); break; }
  }
  if (emptyChanged) await kv.set(emptyKey, Object.fromEntries(Object.entries(empty).filter(([d]) => d >= oldest)));
  const restingDays = Object.keys(empty).filter(d => d >= oldest && d < today && !have.has(d) && resting(d)).length;
  const remaining = Math.max(0, Math.round((Date.parse(today) - Date.parse(oldest)) / 864e5) - have.size - filled - restingDays);

  // Nightly repair work, after the normal work. Nothing new starts in the last 10 s of the budget, so the function stays well inside 60 s.
  const nightly: { coverage?: string[]; splits?: Awaited<ReturnType<typeof backfillSplits>> } = {};
  if (opts.nightly) {
    const stopAt = t0 + budgetMs - 10_000;
    nightly.coverage = await refetchShortDays(siteId, a, stopAt, errors).catch(e => { errors.push(`coverage: ${e.message}`); return []; });
    nightly.splits = await backfillSplits(siteId, a, stopAt, errors).catch(e => { errors.push(`splits: ${e.message}`); return undefined; });
  }
  return { done, filled, remaining, errors, ms: Date.now() - t0, ...nightly };
}
