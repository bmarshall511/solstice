// The offline demo server's body (started by scripts/demo-server.mjs, which sets the env and installs the network guard first).
// The real app (server/src/app.ts) on a throwaway PGlite seeded with the synthetic house, the nightly steps run once against it,
// a 15-second ticker that keeps "now" moving, and the built web app with its browser-side weather calls pointed at local fixtures.
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app } from '../../server/src/app.js';
import { q, kv } from '../../server/src/db.js';
import { localDay, addDays, localMidnight } from '../../server/src/tesla/client.js';
import { saveEnergyRows, saveSoe } from '../../server/src/sync.js';
import { refreshCapacity } from '../../server/src/capacity.js';
import { runLearn } from '../../server/src/learn/nightly.js';
import { refreshRecords } from '../../server/src/records.js';
import { nightlyWatch } from '../../server/src/watch.js';
import { loadsNightly } from '../../server/src/loads.js';
import { soilingNightly } from '../../server/src/soiling.js';
import { refreshLive } from '../../server/src/sync.js';
import { ledger } from '../../server/src/cronLedger.js';
import { ingestPvs } from '../../server/src/pvs.js';
import { seedDemo, refreshSnapshots, type SeedResult } from './seed.js';
import { DEMO_SITE_ID, houseDay, batteryRun, nestDay, poolDay, pvsAt, type EnergyRow, BATTERY } from './model.js';
import { fixtureFor } from './fixtures.js';
import type { GuardStats } from './guard.js';

const log = (s: string) => console.log(`[demo] ${s}`);
const ms = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)} s`;

/** The nightly work, as the sync cron runs it, called directly: capacity, the learning layer (replayed over past mornings so the
 *  models have scores and five weeks of pool kWh exist for "What changed"), records, and the nightly watch steps (loads, soiling,
 *  digest, Powerwall rules, alerts). Each step's failure is logged, never fatal. */
export async function runNightly(siteId = DEMO_SITE_ID, now = Date.now()) {
  const L = ledger('sync', now), today = localDay(new Date(now)), out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => { const t = Date.now(); try { out[name] = await L.step(name, fn); log(`nightly ${name}: ${ms(t)}`); } catch (e) { log(`nightly ${name} failed: ${(e as Error).message}`); } };
  await step('capacity', () => refreshCapacity(siteId, now));
  // past mornings at 05:15, oldest first: 42, 28 and 14 days back (each run writes 14 days of pool kWh), then each of the last 9 days
  const mornings = [42, 28, 14, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(a => localMidnight(addDays(today, -a)).getTime() + 5.25 * 3600e3);
  await step('learn:replay', async () => { for (const t of mornings) { const r = await runLearn(siteId, { now: t }); if (r.errors.length) log(`  learn ${localDay(new Date(t))}: ${r.errors.slice(0, 2).join('; ')}`); } return {}; });
  await step('learn', () => runLearn(siteId, { now }));
  await kv.set('cron:sync:done', Date.now());
  await step('records', () => refreshRecords(siteId, now));
  await step('loads', () => loadsNightly(siteId, now));
  await step('soiling', () => soilingNightly(siteId, now));
  await step('watch', () => nightlyWatch(siteId, now));
  await L.finish();
  return out;
}

/** Keep "now" moving: today's buckets as they complete, a live reading, Nest, pool and per-panel samples, fresh device snapshots. */
export function startTicker(seed: SeedResult, everyMs = 15_000) {
  let pending: EnergyRow[] = seed.pending, day = seed.today, last = Date.now(), soc = seed.pending[0]?.soc ?? 60;
  const tick = async () => {
    const now = Date.now(), today = localDay(new Date(now));
    if (today !== day) {   // past midnight: the new day's house, carrying the battery's charge
      const run = batteryRun(houseDay(today, { today }), (pending.at(-1)?.soc ?? soc) / 100 * BATTERY.kwh * 1000);
      pending = [...pending, ...run.rows]; day = today;
    }
    const done = pending.filter(r => r.epoch + 300_000 <= now); pending = pending.filter(r => r.epoch + 300_000 > now);
    if (done.length) {
      await saveEnergyRows(DEMO_SITE_ID, done);
      await saveSoe(DEMO_SITE_ID, done.filter(r => +r.ts.slice(14, 16) % 15 === 0).map(r => ({ timestamp: r.ts, soe: r.soc })));
      for (const r of done) if (r.solar > 0) await ingestPvs({ ts: new Date(r.epoch + 300_000), inverters: pvsAt(r.epoch, r.solar * 12 / 1000, 75) });
    }
    const cur = pending[0] ?? done.at(-1);
    if (cur) {
      soc = cur.soc; const j = () => 1 + (Math.random() - .5) * .06, W = (wh: number) => Math.round(wh * 12 * j());
      await q(`INSERT INTO readings VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (site_id, ts) DO NOTHING`,
        [DEMO_SITE_ID, now, W(cur.solar), W(cur.dis - cur.chg), W(cur.imp - cur.exp), W(cur.home), cur.soc, 'Active', 'on_grid', false]);
    }
    for (const r of nestDay(today, today, now).filter(r => r.ts > last && r.ts <= now))
      await q(`INSERT INTO nest_readings (site_id, ts, day, hour, indoor_f, humidity, mode, hvac, cool_f, heat_f, eco) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [DEMO_SITE_ID, r.ts, r.day, r.hour, r.indoor_f, r.humidity, r.mode, r.hvac, r.cool_f, r.heat_f, r.eco]);
    for (const r of poolDay(today, today, now).filter(r => r.ts > last && r.ts <= now))
      await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm, water_temp, air_temp, circuits) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING`,
        [DEMO_SITE_ID, r.ts, r.day, r.hour, r.running, r.watts, r.rpm, r.water_temp, r.air_temp, JSON.stringify(r.circuits)]);
    await refreshSnapshots(now);
    last = now;
  };
  let busy = false;
  const timer = setInterval(() => { if (busy) return; busy = true; tick().catch(e => log(`tick failed: ${(e as Error).message}`)).finally(() => { busy = false; }); }, everyMs);
  return { tick, stop: () => clearInterval(timer) };
}

/** The browser half of the guard, injected into the served index.html: the app's direct Open-Meteo and NWS calls go to the demo's own
 *  fixtures; any other cross-origin fetch is refused. The Google Fonts links are dropped (system fonts stand in). */
const BROWSER_GUARD = `<script>(()=>{const f=window.fetch.bind(window),fx=/^(api\\.open-meteo\\.com|archive-api\\.open-meteo\\.com|api\\.weather\\.gov)$/;
window.fetch=(i,o)=>{const u=new URL(typeof i==='string'||i instanceof URL?String(i):i.url,location.href);if(u.origin===location.origin)return f(i,o);
if(fx.test(u.hostname))return f('/__demo/fixture?u='+encodeURIComponent(u.href));console.warn('[demo] blocked',u.hostname);return Promise.reject(new TypeError('offline demo: '+u.hostname+' blocked'));};
console.info('[demo] offline Solstice demo: synthetic data, no network');})();</script>`;

export function serveWeb() {
  const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));   // not .pathname: a folder name with a space would arrive as %20
  if (!existsSync(dist + 'index.html')) throw new Error(`no web build at ${dist}: run npm run build`);
  const page = () => readFileSync(dist + 'index.html', 'utf8')
    .replace(/<link[^>]+fonts\.googleapis\.com[^>]*>\s*/g, '')
    .replace('</head>', `${BROWSER_GUARD}\n</head>`);
  app.get('/__demo/fixture', (req, res) => {
    const body = fixtureFor(String(req.query.u ?? ''));
    if (body == null) return res.status(503).json({ error: 'offline_demo' });
    res.json(body);
  });
  app.use(express.static(dist, { index: false }));
  app.get(/^\/(?!api|auth|__demo).*/, (_req, res) => res.type('html').send(page()));
}

export async function main(o: { port: number; ownerKey: string; stats: GuardStats; seed?: Parameters<typeof seedDemo>[0] }) {
  const t0 = Date.now();
  log(`seeding a throwaway PGlite at ${process.env.DATABASE_URL}`);
  const seed = await seedDemo(o.seed);
  log(`seeded in ${ms(t0)}: ${seed.energy} energy buckets (${seed.synced} days synced, install ${seed.installed}), ${seed.soe} battery points, ${seed.nest} Nest + ${seed.pool} pool readings, ${seed.pvs} panel readings, ${seed.bills} bills, ${seed.outages} outages`);
  const ticker = startTicker(seed); await ticker.tick();
  await refreshLive(DEMO_SITE_ID).catch(() => {});   // younger than 25 s: no Tesla call (a check that the ticker's reading counts as fresh)
  const t1 = Date.now(); await runNightly(DEMO_SITE_ID); log(`nightly steps done in ${ms(t1)}`);
  serveWeb();
  const server = app.listen(o.port, '127.0.0.1');
  await new Promise<void>((ok, fail) => { server.once('listening', () => ok()); server.once('error', e => fail(new Error(`port ${o.port}: ${(e as Error).message} (another server is using it; try PORT=<free port> npm run demo)`))); });
  const base = `http://localhost:${o.port}`, local = `http://127.0.0.1:${o.port}`;   // the server listens on IPv4 loopback only
  // a guest link through the share API, as the owner would make one in Settings
  const unlock = await fetch(`${local}/api/auth/owner`, { method: 'POST', body: JSON.stringify({ key: o.ownerKey }) });
  const cookie = (unlock.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
  const share = await fetch(`${local}/api/share`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ label: 'Demo guest', expiresIn: '7d' }) })
    .then(async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { error: `HTTP ${r.status}: ${t.slice(0, 120)}` }; } }) as { fragment?: string; error?: string };
  console.log(`
Solstice offline demo on ${base}  (synthetic data only; every non-localhost request is blocked)
  Owner:  ${base}/#owner=${o.ownerKey}
  Guest:  ${share.fragment ? `${base}/${share.fragment}` : `(share link failed: ${share.error ?? unlock.status})`}
  Ready in ${ms(t0)}. Fixtures served so far: ${JSON.stringify(o.stats.fixtures)}; blocked: ${JSON.stringify(o.stats.blocked)}
  Ctrl-C stops it; the database is thrown away.
`);
  return { base, seed, ticker };
}
