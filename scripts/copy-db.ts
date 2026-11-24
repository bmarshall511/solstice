// One-time copy of every table from one Postgres to another: the database move in docs/plan-db-supabase.md, step 3.
//
//   1. Set DB_MAINTENANCE=1 on Vercel and redeploy, so no cron, relay or event writes to either database during the copy.
//   2. SOURCE_URL=… TARGET_URL=… node --no-warnings --import tsx scripts/copy-db.ts --sizes   (measure only; writes nothing)
//   3. SOURCE_URL=… TARGET_URL=… node --no-warnings --import tsx scripts/copy-db.ts            (copy, then compare row counts)
//
// SOURCE_CA / TARGET_CA: the host's CA as a PEM, when it signs with its own (db.ts pgConfig). The source is only read. The target
// gets the app's schema (migrate), then every row; a row already there is kept, except kv, where the source's value wins. Values
// travel as Postgres text, untouched by JavaScript, so dates, jsonb arrays and bigints arrive exactly as they left.
// It stops before writing anything when the source is past MAX_MB, the margin under the target's 500 MB plan limit.
import pg from 'pg';
import { pgConfig } from '../server/src/db.js';

const MAX_MB = 400, sizesOnly = process.argv.includes('--sizes'), force = process.argv.includes('--force');
const { SOURCE_URL, TARGET_URL } = process.env;
if (!SOURCE_URL || (!sizesOnly && !TARGET_URL)) throw new Error('set SOURCE_URL and TARGET_URL');
if (SOURCE_URL === TARGET_URL) throw new Error('SOURCE_URL and TARGET_URL are the same database');

const raw = { getTypeParser: () => (v: string) => v };   // every value stays the text Postgres sent
const client = async (url: string, ca: string | undefined) => {
  const { max: _max, idleTimeoutMillis: _i, allowExitOnIdle: _a, ...cfg } = pgConfig(url, ca);
  const c = new pg.Client({ ...cfg, types: raw as any }); await c.connect(); return c;
};
const src = await client(SOURCE_URL, process.env.SOURCE_CA);
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/* ---------- 1. sizes ---------- */
const sizes = (await src.query(`SELECT relname AS t, pg_total_relation_size(relid) AS b FROM pg_catalog.pg_statio_user_tables
  WHERE schemaname = 'public' ORDER BY 2 DESC`)).rows as { t: string; b: string }[];
const totalMb = Number((await src.query('SELECT pg_database_size(current_database()) AS b')).rows[0].b) / 1048576;
console.log('table                     MB');
for (const r of sizes) console.log(`${r.t.padEnd(24)} ${(Number(r.b) / 1048576).toFixed(1).padStart(6)}`);
console.log(`database total           ${totalMb.toFixed(1).padStart(6)}   (stop above ${MAX_MB} MB)`);
if (sizesOnly) { await src.end(); process.exit(0); }
if (totalMb > MAX_MB && !force) { await src.end(); throw new Error(`the source is ${totalMb.toFixed(0)} MB, over the ${MAX_MB} MB margin: nothing was copied`); }

/* ---------- 2. schema on the target (the app's own CREATE TABLE IF NOT EXISTS) ---------- */
process.env.DATABASE_URL = TARGET_URL;
if (process.env.TARGET_CA) process.env.DATABASE_CA = process.env.TARGET_CA;
const { migrate } = await import('../server/src/db.js');
await migrate();
const dst = await client(TARGET_URL!, process.env.TARGET_CA);

/* ---------- 3. rows, table by table ---------- */
const names = (await src.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map(r => r.t as string);
// a referenced table goes before the tables that reference it (sites → tesla_accounts, sessions → users)
const fks = (await src.query(`SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f'`)).rows as { child: string; parent: string }[];
const tables: string[] = [];
const visit = (t: string, path: string[] = []) => {
  if (tables.includes(t)) return;
  if (path.includes(t)) throw new Error(`foreign keys form a cycle: ${[...path, t].join(' → ')}`);
  for (const f of fks) if (f.child === t && f.parent !== t) visit(f.parent, [...path, t]);
  tables.push(t);
};
names.forEach(t => visit(t));
const report: { t: string; src: number; dst: number }[] = [];
for (const t of tables) {
  const cols = (await src.query(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t])).rows.map(r => r.c as string);
  const list = cols.map(ident).join(', '), per = Math.max(1, Math.floor(30_000 / cols.length));   // stays under Postgres's 65,535 parameters
  const onConflict = t === 'kv' ? 'ON CONFLICT (key) DO UPDATE SET value = excluded.value' : 'ON CONFLICT DO NOTHING';
  await src.query('BEGIN');
  await src.query(`DECLARE rows_c NO SCROLL CURSOR FOR SELECT ${list} FROM ${ident(t)}`);
  let n = 0;
  for (;;) {
    const { rows } = await src.query(`FETCH ${per} FROM rows_c`);
    if (!rows.length) break;
    const params: unknown[] = [], tuples = rows.map(r => `(${cols.map(c => { params.push(r[c]); return `$${params.length}`; }).join(', ')})`);
    await dst.query(`INSERT INTO ${ident(t)} (${list}) VALUES ${tuples.join(', ')} ${onConflict}`, params);
    n += rows.length; process.stdout.write(`\r${t} ${n}`);
  }
  await src.query('CLOSE rows_c'); await src.query('COMMIT');
  // a serial id continues after the copied rows
  for (const c of cols) {
    const seq = (await dst.query('SELECT pg_get_serial_sequence($1, $2) AS s', [t, c])).rows[0].s;
    if (seq) await dst.query(`SELECT setval($1, COALESCE((SELECT MAX(${ident(c)}) FROM ${ident(t)}), 1), (SELECT MAX(${ident(c)}) FROM ${ident(t)}) IS NOT NULL)`, [seq]);
  }
  const count = async (db: pg.Client) => Number((await db.query(`SELECT COUNT(*) AS n FROM ${ident(t)}`)).rows[0].n);
  report.push({ t, src: await count(src), dst: await count(dst) });
  process.stdout.write('\n');
}

/* ---------- 4. compare ---------- */
console.log('\ntable                     source     target');
for (const r of report) console.log(`${r.t.padEnd(24)} ${String(r.src).padStart(8)}   ${String(r.dst).padStart(8)}${r.src === r.dst ? '' : '   <-- differs'}`);
const bad = report.filter(r => r.src !== r.dst);
await src.end(); await dst.end();
if (bad.length) { console.error(`\n${bad.length} table(s) differ: do not switch DATABASE_URL yet`); process.exit(1); }
console.log('\nevery table matches');
process.exit(0);
