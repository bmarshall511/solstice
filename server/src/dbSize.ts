// The database's size against its host's free-plan limit (docs/plan-db-supabase.md). A free Postgres turns read-only past its
// size limit, and new readings then stop saving, so the nightly run measures the size and pushes one warning a week from 80%.
import { one, kv } from './db.js';
import { notify } from './notify.js';

/** Supabase Free's database size limit, in MB; DB_SIZE_LIMIT_MB overrides it for another plan or host. */
export const DEFAULT_LIMIT_MB = 500;
export const WARN_AT = 0.8;
export const SIZE_KEY = 'db:size';

export const limitMb = () => Number(process.env.DB_SIZE_LIMIT_MB) > 0 ? Number(process.env.DB_SIZE_LIMIT_MB) : DEFAULT_LIMIT_MB;

/** Nightly step: store {mb, limitMb, at} in kv and, at 80% of the limit or more, push one alert a week. */
export async function dbSizeWatch(siteId: string, now = Date.now()) {
  const row = await one<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes');
  const mb = Math.round(Number(row?.bytes ?? 0) / 1048576), limit = limitMb(), pct = Math.round(mb / limit * 100);
  await kv.set(SIZE_KEY, { mb, limitMb: limit, at: now });
  if (mb < limit * WARN_AT) return { mb, limitMb: limit };
  return notify(siteId, 'anomaly', 'The database is filling up',
    `Solstice's database holds ${mb} MB of its ${limit} MB limit (${pct}%). Past the limit the host makes it read-only, and new readings stop saving. Trim old rows or move it to a larger plan before then.`,
    { mb, limitMb: limit }, { key: SIZE_KEY, windowH: 24 * 7, now, url: '/?go=v-set' });
}
