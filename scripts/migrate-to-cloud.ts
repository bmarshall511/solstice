// One-time upload of the local install (data/solstice.db) into the deployed app's database, via /api/admin/import.
// Usage: node --env-file=.env --no-warnings --import tsx scripts/migrate-to-cloud.ts
import { DatabaseSync } from 'node:sqlite';
const BASE = process.env.CLOUD_URL ?? 'https://solstice-energy-seven.vercel.app', TOKEN = process.env.VERCEL_SETUP_TOKEN;
if (!TOKEN) throw new Error('VERCEL_SETUP_TOKEN missing from .env');
const src = new DatabaseSync(new URL('../data/solstice.db', import.meta.url).pathname, { readOnly: true });
const kv = (k: string) => { const r = src.prepare('SELECT value FROM kv WHERE key = ?').get(k) as { value: string } | undefined; return r ? JSON.parse(r.value) : undefined; };
const siteId = kv('tesla.siteId');
async function send(kind: string, rows?: unknown[], site?: unknown) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${BASE}/api/admin/import`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ kind, siteId, rows, site }) });
    if (r.ok) return r.json();
    if (attempt >= 3) throw new Error(`${kind}: HTTP ${r.status} ${await r.text()}`);
    await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
  }
}
await send('site', undefined, { tokens: kv('tesla.tokens'), info: kv('tesla.siteInfo') });
console.log(`site ${siteId} + Tesla connection`);
const energy = (src.prepare('SELECT ts, epoch, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh FROM energy ORDER BY epoch').all() as any[])
  .map(r => ({ ts: r.ts, epoch: r.epoch, day: r.ts.slice(0, 10), hour: +r.ts.slice(11, 13), solar: r.solar_wh, home: r.home_wh, imp: r.import_wh, exp: r.export_wh, chg: r.charge_wh, dis: r.discharge_wh }));
for (let i = 0; i < energy.length; i += 5000) { await send('energy', energy.slice(i, i + 5000)); process.stdout.write(`\renergy ${Math.min(i + 5000, energy.length)}/${energy.length}`); }
const soe = (src.prepare('SELECT ts, soe FROM soe ORDER BY epoch').all() as any[]).map(r => ({ timestamp: r.ts, soe: r.soe }));
for (let i = 0; i < soe.length; i += 8000) await send('soe', soe.slice(i, i + 8000));
console.log(`\nbattery % ${soe.length}`);
await send('outages', src.prepare('SELECT ts, epoch, duration_s FROM backup_events').all() as any[]);
await send('bills', (src.prepare('SELECT raw FROM bills').all() as any[]).map(b => JSON.parse(b.raw)));
await send('days', [...new Set(energy.map(r => r.day))].slice(0, -1));
console.log('outages, bills, synced days — done');
