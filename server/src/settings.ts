// The owner's settings (kv `settings:owner`), written atomically (B2-10, idea I-06, code review C-14). Every writer used to read the
// whole object, change one part and write the whole object back, so two writers at once (the AC card and the presence mark, the
// pool route and Autopilot's outside-edit check) could silently undo each other, including the owner's Auto choice (rule 4).
// patchSettings changes only its own path, in one SQL statement on the stored jsonb, so concurrent writers never lose a key.
// Every change of pool.autopilot or ac.autopilot is recorded in a 50-entry ring (kv `settings:changes`, newest first).
import { q } from './db.js';

export const SETTINGS_KEY = 'settings:owner', PREV_KEY = 'settings:owner:prev', CHANGES_KEY = 'settings:changes', CHANGES_MAX = 50;
/** The settings whose every change is logged (the two Autopilots the owner set to Auto on 2026-09-25). */
export const WATCHED: ReadonlyArray<readonly string[]> = [['pool', 'autopilot'], ['ac', 'autopilot']];
export type SettingsChange = { at: number; path: string; from: unknown; to: unknown; by: string };
type Obj = Record<string, any>;

const PATH_PART = /^[A-Za-z0-9_-]{1,64}$/;
const pathLit = (p: readonly string[]) => `{${p.join(',')}}`;
const at = (o: unknown, p: readonly string[]) => p.reduce<any>((v, k) => v != null && typeof v === 'object' ? v[k] : undefined, o);

/**
 * Set `value` at `path` inside the owner's settings in one statement, creating missing parent objects; the rest of the object is
 * left exactly as it is in the database at that moment. `merge`: an object value is merged (one level) into what is at the path
 * instead of replacing it; an empty path always merges into the top level (PUT /api/settings). `by` names who changed it for the
 * change log ('you', 'presence', 'autopilot', …). Returns the settings before and after.
 */
export async function patchSettings(path: readonly string[], value: unknown, o: { merge?: boolean; by?: string; now?: number } = {}): Promise<{ before: Obj; after: Obj }> {
  if (path.some(k => !PATH_PART.test(k))) throw new Error(`bad settings path ${path.join('.')}`);
  if ((o.merge || !path.length) && (value == null || typeof value !== 'object' || Array.isArray(value))) throw new Error('a merge needs an object');
  // the expression on the stored value `v`: each missing (or non-object) parent made an empty object first, then the path set (or merged)
  const obj = (x: string) => `(CASE WHEN jsonb_typeof(${x}) = 'object' THEN ${x} ELSE '{}'::jsonb END)`;
  const expr = (v: string) => {
    let e = obj(v);
    if (!path.length) return `${e} || $2::jsonb`;
    for (let i = 1; i < path.length; i++) e = `jsonb_set(${e}, '${pathLit(path.slice(0, i))}', ${obj(`${e} #> '${pathLit(path.slice(0, i))}'`)})`;
    const leaf = o.merge ? `${obj(`${e} #> '${pathLit(path)}'`)} || $2::jsonb` : '$2::jsonb';
    return `jsonb_set(${e}, '${pathLit(path)}', ${leaf})`;
  };
  const r = (await q<{ before: Obj | null; after: Obj }>(`WITH old AS (SELECT value FROM kv WHERE key = $1 FOR UPDATE),
      up AS (INSERT INTO kv (key, value) VALUES ($1, ${expr("NULL::jsonb")}) ON CONFLICT (key) DO UPDATE SET value = ${expr('kv.value')} RETURNING value)
    SELECT (SELECT value FROM old) AS before, (SELECT value FROM up) AS after`, [SETTINGS_KEY, JSON.stringify(value ?? null)]))[0];
  const before = r?.before ?? {}, after = r?.after ?? {};
  await logChanges(before, after, o.by ?? 'unknown', o.now ?? Date.now());
  return { before, after };
}

/** The watched settings that differ between two versions, as change-log entries. */
export function changesBetween(before: Obj, after: Obj, by: string, now: number): SettingsChange[] {
  return WATCHED.filter(p => JSON.stringify(at(before, p) ?? null) !== JSON.stringify(at(after, p) ?? null))
    .map(p => ({ at: now, path: p.join('.'), from: at(before, p) ?? null, to: at(after, p) ?? null, by }));
}
/** Prepend changes to the ring (newest first, at most 50) in one statement, so two writers can't drop each other's entries. */
async function logChanges(before: Obj, after: Obj, by: string, now: number) {
  const add = changesBetween(before, after, by, now); if (!add.length) return;
  await q(`INSERT INTO kv (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = (
      SELECT COALESCE(jsonb_agg(e ORDER BY i), '[]'::jsonb) FROM (SELECT e, i FROM jsonb_array_elements($2::jsonb || (CASE WHEN jsonb_typeof(kv.value) = 'array' THEN kv.value ELSE '[]'::jsonb END))
        WITH ORDINALITY t(e, i) ORDER BY i LIMIT ${CHANGES_MAX}) x)`, [CHANGES_KEY, JSON.stringify(add)]);
}

/** The keys of `next` whose values differ from `cur` (a computed object written back as only what changed). */
export const changedKeys = (cur: Obj, next: Obj): Obj => Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(cur?.[k]) !== JSON.stringify(v)));
