// One-time copy of the local SQLite install (data/solstice.db) into Postgres (DATABASE_URL).
// Copies: Tesla connection (tokens), site + site_info, 5-min energy history, battery %, outages, PEC bills, synced-day markers.
// The owner account is created afterwards through the app's one-time setup link, which claims this data.
// Usage: DATABASE_URL=… node --no-warnings --import tsx scripts/migrate-to-postgres.ts
import { DatabaseSync } from 'node:sqlite';
import { q, migrate } from '../server/src/db.js';
import { saveEnergyRows, saveSoe } from '../server/src/sync.js';

const src = new DatabaseSync(new URL('../data/solstice.db', import.meta.url).pathname, { readOnly: true });
const kv = (k: string) => { const r = src.prepare('SELECT value FROM kv WHERE key = ?').get(k) as { value: string } | undefined; return r ? JSON.parse(r.value) : undefined; };
await migrate();

const tokens = kv('tesla.tokens'), siteId = kv('tesla.siteId'), info = kv('tesla.siteInfo');
if (!tokens || !siteId) throw new Error('No Tesla connection in the local database');
const acct = (await q<{ id: number }>(`INSERT INTO tesla_accounts (user_id, access_token, refresh_token, expires_at, scope) VALUES (NULL, $1, $2, $3, $4) RETURNING id`,
  [tokens.access_token, tokens.refresh_token, tokens.expires_at, tokens.scope ?? null]))[0].id;
await q(`INSERT INTO sites (id, user_id, tesla_account_id, name, info, info_at) VALUES ($1, NULL, $2, $3, $4, now())
  ON CONFLICT (id) DO UPDATE SET tesla_account_id = excluded.tesla_account_id, info = excluded.info, info_at = now()`, [siteId, acct, info?.site_name ?? 'Home', JSON.stringify(info ?? {})]);
console.log(`site ${siteId} + Tesla connection`);

const energy = src.prepare('SELECT ts, epoch, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh FROM energy ORDER BY epoch').all() as any[];
for (let i = 0; i < energy.length; i += 2000) {
  await saveEnergyRows(siteId, energy.slice(i, i + 2000).map(r => ({ ts: r.ts, epoch: r.epoch, day: r.ts.slice(0, 10), hour: +r.ts.slice(11, 13),
    solar: r.solar_wh, home: r.home_wh, imp: r.import_wh, exp: r.export_wh, chg: r.charge_wh, dis: r.discharge_wh })));
  process.stdout.write(`\renergy ${Math.min(i + 2000, energy.length)}/${energy.length}`);
}
const soe = src.prepare('SELECT ts, soe FROM soe ORDER BY epoch').all() as any[];
for (let i = 0; i < soe.length; i += 2000) await saveSoe(siteId, soe.slice(i, i + 2000).map(r => ({ timestamp: r.ts, soe: r.soe })));
console.log(`\nbattery % ${soe.length}`);
for (const e of src.prepare('SELECT ts, epoch, duration_s FROM backup_events').all() as any[])
  await q('INSERT INTO backup_events VALUES ($1,$2,$3,$4) ON CONFLICT (site_id, ts) DO UPDATE SET duration_s = excluded.duration_s', [siteId, e.ts, e.epoch, e.duration_s]);
for (const b of src.prepare('SELECT raw FROM bills').all() as any[]) {
  const bill = JSON.parse(b.raw);
  await q(`INSERT INTO bills (site_id, bill_date, period_from, period_to, delivered_kwh, received_kwh, total, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (site_id, bill_date) DO NOTHING`,
    [siteId, bill.billDate, bill.period.from, bill.period.to, bill.deliveredKwh, bill.receivedKwh, bill.total, JSON.stringify(bill)]);
}
const days = [...new Set(energy.map(r => r.ts.slice(0, 10)))].slice(0, -1); // all but the newest (possibly partial) day
for (let i = 0; i < days.length; i += 500) await q(`INSERT INTO synced_days SELECT $1, 'day', unnest($2::text[]) ON CONFLICT DO NOTHING`, [siteId, days.slice(i, i + 500)]);
console.log(`outages, ${(src.prepare('SELECT COUNT(*) n FROM bills').get() as any).n} bills, ${days.length} synced days — done`);
