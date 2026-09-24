import express from 'express';
import { config } from './config.ts';
import { db, kv } from './db.ts';
import { loginUrl, handleCallback, isConnected } from './tesla/auth.ts';
import { ensureSite, startPolling, backfill, pollLive, pollSiteInfo } from './poller.ts';
import { reconcile } from './reconcile.ts';

const app = express();
const page = (body: string) => `<!doctype html><meta charset="utf-8"><title>Solstice server</title>
<style>body{font:15px/1.6 system-ui;background:#05060a;color:#e9edf5;max-width:720px;margin:48px auto;padding:0 20px}a{color:#ffc15e}
code,pre{font:13px ui-monospace,monospace;background:#11141c;padding:2px 6px;border-radius:6px}pre{padding:12px;overflow:auto}.ok{color:#4ef0a6}.bad{color:#ff7a66}</style>${body}`;

app.get('/', (_req, res) => {
  if (!isConnected()) return res.send(page(`<h1>Solstice</h1><p>Not connected to Tesla yet.</p><p><a href="/auth/login">Connect Tesla account →</a></p>`));
  const last = db.prepare('SELECT * FROM readings ORDER BY ts DESC LIMIT 1').get() as Record<string, number> | undefined;
  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM readings) readings, (SELECT COUNT(*) FROM energy) buckets, (SELECT COUNT(DISTINCT substr(ts,1,10)) FROM energy) days, (SELECT COUNT(*) FROM backup_events) outages').get();
  res.send(page(`<h1>Solstice <span class="ok">● connected</span></h1>
    <p>Site <code>${kv.get('tesla.siteId') ?? '…'}</code></p>
    <pre>${JSON.stringify({ latest: last && { at: new Date(last.ts).toLocaleString(), solar_w: last.solar_w, load_w: last.load_w, battery_w: last.battery_w, grid_w: last.grid_w, soc: last.soc, grid_status: last.grid_status }, counts, backfill: kv.get('backfill.target') }, null, 2)}</pre>
    <p><a href="/api/reconcile">Bill reconciliation</a> · <a href="/api/site">Site info</a> · <a href="/api/live">Latest reading</a></p>`));
});

app.get('/auth/login', (_req, res) => res.redirect(loginUrl()));

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  if (error) return res.status(400).send(page(`<h1 class="bad">Tesla sign-in failed</h1><p>${error}: ${error_description ?? ''}</p>`));
  try {
    await handleCallback(code, state);
    const siteId = await ensureSite();
    await pollSiteInfo(siteId);
    await pollLive(siteId);
    startPolling();
    res.redirect('/');
  } catch (e) {
    res.status(500).send(page(`<h1 class="bad">Couldn't finish connecting</h1><pre>${(e as Error).message}</pre><p><a href="/auth/login">Try again</a></p>`));
  }
});

app.get('/api/status', (_req, res) => res.json({
  connected: isConnected(), siteId: kv.get('tesla.siteId') ?? null,
  lastLive: kv.get('poll.lastLive') ?? null, lastHistory: kv.get('poll.lastHistory') ?? null,
  backfill: { target: kv.get('backfill.target') ?? null, daysDone: kv.get<string[]>('backfill.days')?.length ?? 0 },
}));
app.get('/api/live', (_req, res) => res.json(db.prepare('SELECT ts, solar_w, battery_w, grid_w, load_w, soc, energy_left_wh, total_pack_wh, grid_status, island_status, storm_mode_active FROM readings ORDER BY ts DESC LIMIT 1').get() ?? null));
app.get('/api/site', (_req, res) => res.json(kv.get('tesla.siteInfo') ?? null));
app.get('/api/energy', (req, res) => {
  const from = Date.parse(String(req.query.from ?? '')) || Date.now() - 864e5, to = Date.parse(String(req.query.to ?? '')) || Date.now();
  res.json(db.prepare('SELECT ts, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh FROM energy WHERE epoch >= ? AND epoch < ? ORDER BY epoch').all(from, to));
});
app.get('/api/outages', (_req, res) => res.json(db.prepare('SELECT ts, duration_s FROM backup_events ORDER BY epoch DESC').all()));
app.get('/api/reconcile', (_req, res) => res.json(reconcile()));
app.post('/api/backfill', async (req, res) => {
  const from = String(req.query.from ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return res.status(400).json({ error: 'from=YYYY-MM-DD required' });
  backfill(await ensureSite(), from); // runs in the background; progress at /api/status
  res.json({ started: true, from });
});

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Solstice server on http://localhost:${config.port}`);
  startPolling();
});
