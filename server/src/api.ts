import express, { Router } from 'express';
import { db, kv } from './db.ts';
import { events } from './poller.ts';
import { reconcile } from './reconcile.ts';
import { listBills, parsePecPdf, saveBill, type Bill } from './bills.ts';
import { rfc3339 } from './tesla/client.ts';

export const api = Router();
const today = () => rfc3339(new Date()).slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const r1 = (v: number | null | undefined, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const kwhCols = `ROUND(SUM(solar_wh)/1000.0,2) solar, ROUND(SUM(home_wh)/1000.0,2) home, ROUND(SUM(import_wh)/1000.0,2) import,
  ROUND(SUM(export_wh)/1000.0,2) export, ROUND(SUM(charge_wh)/1000.0,2) charge, ROUND(SUM(discharge_wh)/1000.0,2) discharge`;

type Reading = { ts: number; solar_w: number; battery_w: number; grid_w: number; load_w: number; soc: number; grid_status: string; island_status: string; storm_mode_active: number };

function siteSummary() {
  const s = kv.get<Record<string, any>>('tesla.siteInfo') ?? {};
  return {
    name: s.site_name, installed: s.installation_date, utility: s.utility, firmware: s.version,
    batteryCount: s.battery_count, batteries: (s.components?.batteries ?? []).map((b: any) => ({ name: b.part_name, kwh: b.nameplate_energy / 1000, kw: b.nameplate_max_discharge_power / 1000 })),
    capacityKwh: (s.nameplate_energy ?? 0) / 1000, maxPowerKw: (s.nameplate_power ?? 0) / 1000,
    reservePct: s.backup_reserve_percent, mode: s.default_real_mode, stormWatch: s.user_settings?.storm_mode_enabled ?? null,
  };
}

/** Grid is down when Tesla reports the gateway islanded or grid not active. Walk back to find when it started. */
function outageState(latest?: Reading) {
  const down = (r?: Reading) => !!r && (r.grid_status !== 'Active' || /off_grid/.test(r.island_status));
  if (!down(latest)) return { active: false };
  const lastUp = db.prepare(`SELECT ts FROM readings WHERE grid_status = 'Active' AND island_status NOT LIKE '%off_grid%' ORDER BY ts DESC LIMIT 1`).get() as { ts: number } | undefined;
  const start = db.prepare('SELECT MIN(ts) ts FROM readings WHERE ts > ?').get(lastUp?.ts ?? 0) as { ts: number };
  return { active: true, since: start.ts };
}

api.get('/now', (_req, res) => {
  const latest = db.prepare('SELECT * FROM readings ORDER BY ts DESC LIMIT 1').get() as Reading | undefined;
  const d = today();
  const totals = db.prepare(`SELECT ${kwhCols} FROM energy WHERE substr(ts,1,10) = ?`).get(d);
  const lastLive = kv.get<number>('poll.lastLive') ?? null;
  res.json({
    reading: latest && { ts: latest.ts, solarKw: latest.solar_w / 1000, homeKw: latest.load_w / 1000, batteryKw: latest.battery_w / 1000, gridKw: latest.grid_w / 1000,
      soc: latest.soc, gridStatus: latest.grid_status, islandStatus: latest.island_status, stormActive: !!latest.storm_mode_active },
    today: totals, site: siteSummary(), outage: outageState(latest),
    health: { lastLive, lastHistory: kv.get<number>('poll.lastHistory') ?? null, stale: !lastLive || Date.now() - lastLive > 3 * 60_000,
      errors: Object.fromEntries(['live', 'history', 'siteInfo', 'backups'].map(k => [k, kv.get(`poll.error.${k}`) ?? null])) },
  });
});

/** One local day: 5-min energy buckets (as average kW) + battery % + live readings. */
api.get('/day', (req, res) => {
  const date = String(req.query.date ?? today());
  const buckets = (db.prepare(`SELECT ts, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh FROM energy WHERE substr(ts,1,10) = ? ORDER BY epoch`).all(date) as Array<Record<string, any>>)
    .map(b => ({ t: +b.ts.slice(11, 13) + +b.ts.slice(14, 16) / 60, solar: r1(b.solar_wh * 12 / 1000, 2), home: r1(b.home_wh * 12 / 1000, 2),
      grid: r1((b.import_wh - b.export_wh) * 12 / 1000, 2), battery: r1((b.discharge_wh - b.charge_wh) * 12 / 1000, 2) }));
  const soe = (db.prepare('SELECT ts, soe FROM soe WHERE substr(ts,1,10) = ? ORDER BY epoch').all(date) as Array<{ ts: string; soe: number }>)
    .map(p => ({ t: +p.ts.slice(11, 13) + +p.ts.slice(14, 16) / 60, soc: p.soe }));
  res.json({ date, buckets, soe, totals: db.prepare(`SELECT ${kwhCols} FROM energy WHERE substr(ts,1,10) = ?`).get(date) });
});

api.get('/daily', (req, res) => {
  const days = Math.min(800, Number(req.query.days ?? 30)), from = addDays(today(), -days + 1);
  res.json(db.prepare(`SELECT substr(ts,1,10) date, ${kwhCols},
      (SELECT MIN(soe) FROM soe s WHERE substr(s.ts,1,10) = substr(e.ts,1,10)) socMin, (SELECT MAX(soe) FROM soe s WHERE substr(s.ts,1,10) = substr(e.ts,1,10)) socMax
    FROM energy e WHERE substr(ts,1,10) >= ? GROUP BY date ORDER BY date`).all(from));
});

api.get('/monthly', (req, res) => {
  const months = Math.min(60, Number(req.query.months ?? 13));
  res.json((db.prepare(`SELECT substr(ts,1,7) month, COUNT(DISTINCT substr(ts,1,10)) days, ${kwhCols} FROM energy GROUP BY month ORDER BY month DESC LIMIT ?`).all(months) as unknown[]).reverse());
});

/** Average kW by hour of day over the last N days (for forecasting and "typical day" views). */
api.get('/profile', (req, res) => {
  const days = Number(req.query.days ?? 14), from = addDays(today(), -days), to = today();
  const rows = db.prepare(`SELECT CAST(substr(ts,12,2) AS INTEGER) hour, SUM(home_wh)/1000.0/? home, SUM(solar_wh)/1000.0/? solar
    FROM energy WHERE substr(ts,1,10) >= ? AND substr(ts,1,10) < ? GROUP BY hour ORDER BY hour`).all(days, days, from, to);
  res.json({ days, hours: rows });
});

/** days × 24 grid of hourly solar kWh (3D landscape) and average battery % (heatmap). */
api.get('/grid-days', (req, res) => {
  const days = Math.min(90, Number(req.query.days ?? 30)), from = addDays(today(), -days + 1);
  const solar = db.prepare(`SELECT substr(ts,1,10) date, CAST(substr(ts,12,2) AS INTEGER) hour, SUM(solar_wh)/1000.0 kwh FROM energy WHERE substr(ts,1,10) >= ? GROUP BY date, hour`).all(from) as Array<{ date: string; hour: number; kwh: number }>;
  const soc = db.prepare(`SELECT substr(ts,1,10) date, CAST(substr(ts,12,2) AS INTEGER) hour, AVG(soe) soc FROM soe WHERE substr(ts,1,10) >= ? GROUP BY date, hour`).all(from) as Array<{ date: string; hour: number; soc: number }>;
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const grid = (rows: Array<{ date: string; hour: number }>, key: string) => dates.map(d => Array.from({ length: 24 }, (_, h) => {
    const r = rows.find(x => x.date === d && x.hour === h) as Record<string, number> | undefined; return r ? r1(r[key], 2) : null; }));
  res.json({ dates, solar: grid(solar, 'kwh'), soc: grid(soc, 'soc') });
});

/** Overnight baseline: average home kW between 1 and 5 AM, per night. */
api.get('/overnight', (req, res) => {
  const from = addDays(today(), -Number(req.query.days ?? 60));
  res.json(db.prepare(`SELECT substr(ts,1,10) date, ROUND(SUM(home_wh)/1000.0/4, 3) kw FROM energy
    WHERE substr(ts,1,10) >= ? AND CAST(substr(ts,12,2) AS INTEGER) BETWEEN 1 AND 4 GROUP BY date ORDER BY date`).all(from));
});

api.get('/records', (_req, res) => {
  const day = (order: string, col: string) => db.prepare(`SELECT substr(ts,1,10) date, ROUND(SUM(${col})/1000.0,1) kwh FROM energy GROUP BY date ORDER BY kwh ${order} LIMIT 1`).get();
  const all = db.prepare(`SELECT MIN(substr(ts,1,10)) since, ${kwhCols} FROM energy`).get();
  const fullDays = db.prepare(`SELECT COUNT(*) n FROM (SELECT substr(ts,1,10) d, MAX(soe) m FROM soe GROUP BY d HAVING m >= 99)`).get() as { n: number };
  const soeDays = db.prepare(`SELECT COUNT(DISTINCT substr(ts,1,10)) n FROM soe`).get() as { n: number };
  const longest = db.prepare('SELECT ts, duration_s FROM backup_events ORDER BY duration_s DESC LIMIT 1').get();
  res.json({ bestSolarDay: day('DESC', 'solar_wh'), biggestUsageDay: day('DESC', 'home_wh'), lowestImportDay: day('ASC', 'import_wh'),
    totals: all, batteryFullDays: { days: fullDays.n, of: soeDays.n }, longestOutage: longest ?? null,
    outages: (db.prepare('SELECT COUNT(*) n FROM backup_events').get() as { n: number }).n });
});

api.get('/outages', (_req, res) => res.json(db.prepare('SELECT ts, duration_s FROM backup_events ORDER BY epoch DESC').all()));
api.get('/site', (_req, res) => res.json({ summary: siteSummary(), raw: kv.get('tesla.siteInfo') ?? null }));

// ---------- bills ----------
api.get('/bills', (_req, res) => res.json(listBills()));
api.get('/reconcile', (_req, res) => res.json(reconcile()));
api.post('/bills/parse', express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '15mb' }), (req, res) => {
  try { res.json(parsePecPdf(req.body as Buffer)); } catch (e) { res.status(422).json({ error: (e as Error).message }); }
});
api.post('/bills', express.json({ limit: '1mb' }), (req, res) => {
  const b = req.body as Partial<Bill>;
  if (!b.billDate || !b.period?.from || !b.period?.to || b.deliveredKwh == null || b.total == null) return res.status(400).json({ error: 'billDate, period, deliveredKwh and total are required' });
  const fallback = listBills().at(-1)?.tariff; // hand-entered bills inherit the last known tariff
  saveBill({ utility: 'PEC', dueDate: null, receivedKwh: 0, charges: [], ...b, tariff: b.tariff ?? fallback ?? { importRate: 0.102446, importRateAllIn: 0.1064, exportCredit: 0.071921, fixedMonthly: 32.5, discounts: -2.5, franchisePct: 0.0396 } } as Bill);
  res.json({ saved: b.billDate });
});
api.delete('/bills/:date', (req, res) => { db.prepare('DELETE FROM bills WHERE bill_date = ?').run(req.params.date); res.json({ deleted: req.params.date }); });

// ---------- ERCOT grid conditions (server-side: their CORS blocks browsers) ----------
let ercot: { at: number; data: unknown } | null = null;
api.get('/ercot', async (_req, res) => {
  if (ercot && Date.now() - ercot.at < 5 * 60_000) return res.json(ercot.data);
  try {
    const [prc, sd] = await Promise.all(['daily-prc', 'supply-demand'].map(n => fetch(`https://www.ercot.com/api/1/services/read/dashboards/${n}.json`).then(r => r.json()))) as [any, any];
    const latest = (sd.data as Array<any>).filter(x => x.demand > 0).at(-1);
    const data = { condition: prc.current_condition?.state ?? null, title: prc.current_condition?.title ?? null, note: prc.current_condition?.condition_note ?? null,
      eea: prc.current_condition?.eea_level ?? 0, demandMw: latest?.demand ?? null, capacityMw: latest?.capacity ?? null, at: sd.lastUpdated };
    ercot = { at: Date.now(), data };
    res.json(data);
  } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});

// ---------- live stream (Server-Sent Events) ----------
api.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (row: unknown) => res.write(`data: ${JSON.stringify(row)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  events.on('live', send);
  req.on('close', () => { clearInterval(ping); events.off('live', send); });
});

// ---------- what-if: replay the last 12 months of real 5-minute data with a different system ----------
api.get('/whatif', (req, res) => {
  const addPanels = Number(req.query.panels ?? 0), addPw = Number(req.query.powerwalls ?? 0), extraKwhDay = Number(req.query.extra ?? 0);
  const panelW = Number(req.query.panelW ?? 400), from = addDays(today(), -365);
  const rows = db.prepare('SELECT ts, solar_wh, home_wh FROM energy WHERE substr(ts,1,10) >= ? AND substr(ts,1,10) < ? ORDER BY epoch').all(from, today()) as Array<{ ts: string; solar_wh: number; home_wh: number }>;
  const bill = listBills().at(-1)?.tariff ?? { importRateAllIn: 0.1064, exportCredit: 0.0719 };
  // existing array size from its best 5-minute output (AC peak ≈ 85% of DC nameplate)
  const peakKw = Math.max(...rows.map(r => r.solar_wh * 12 / 1000));
  const kwpNow = Math.round(peakKw / 0.85 * 10) / 10, panels = 30;
  const scale = 1 + addPanels * panelW / 1000 / kwpNow;
  const site = siteSummary(), cap0 = site.capacityKwh || 27, pw0 = site.batteryCount || 2;
  function replay(solarScale: number, capKwh: number, maxKw: number, extra: number) {
    let soc = 0.5, imp = 0, exp = 0, solar = 0, home = 0, fullDays = new Set<string>();
    const reserve = (site.reservePct ?? 20) / 100, step = maxKw / 12; // kWh per 5 min
    for (const r of rows) {
      const hour = +r.ts.slice(11, 13);
      const s = r.solar_wh / 1000 * solarScale, h = r.home_wh / 1000 + (hour >= 17 && hour < 23 ? extra / 72 : 0); // extra load spread 5–11 PM
      let net = s - h;
      if (net > 0) { const c = Math.min(net, step, (1 - soc) * capKwh / 0.95); soc += c * 0.95 / capKwh; net -= c; if (soc > 0.995) fullDays.add(r.ts.slice(0, 10)); exp += net; }
      else { const d = Math.min(-net, step, Math.max(0, soc - reserve) * capKwh * 0.95); soc -= d / 0.95 / capKwh; imp += -net - d; }
      solar += s; home += h;
    }
    return { importKwh: Math.round(imp), exportKwh: Math.round(exp), solarKwh: Math.round(solar), homeKwh: Math.round(home), selfPowered: Math.round((1 - imp / home) * 100), batteryFullDays: fullDays.size,
      netCost: Math.round(imp * bill.importRateAllIn - exp * (bill.exportCredit ?? 0)) };
  }
  const baseline = replay(1, cap0, pw0 * 5, extraKwhDay), upgraded = replay(scale, cap0 + addPw * 13.5, pw0 * 5 + addPw * 11.5, extraKwhDay);
  const actual = db.prepare('SELECT ROUND(SUM(import_wh)/1000.0) importKwh, ROUND(SUM(export_wh)/1000.0) exportKwh FROM energy WHERE substr(ts,1,10) >= ? AND substr(ts,1,10) < ?').get(from, today());
  const cost = addPanels * panelW * 2.75 + addPw * 11500, saves = baseline.netCost - upgraded.netCost;
  res.json({ days: new Set(rows.map(r => r.ts.slice(0, 10))).size, kwpNow, panels, assumptions: { panelW, dollarsPerW: 2.75, powerwallCost: 11500, tariff: bill },
    actual, baseline, upgraded, cost, savesPerYear: saves, paybackYears: saves > 0 && cost ? Math.round(cost / saves * 10) / 10 : null,
    backupHoursEvening: { now: Math.round(cap0 * 0.8 / 4.5), upgraded: Math.round((cap0 + addPw * 13.5) * 0.8 / 4.5) } });
});

// ---------- CSV export of every 5-minute bucket ----------
api.get('/export.csv', (_req, res) => {
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="solstice-${today()}.csv"` });
  res.write('timestamp,solar_wh,home_wh,import_wh,export_wh,battery_charge_wh,battery_discharge_wh\n');
  for (const r of db.prepare('SELECT ts, solar_wh, home_wh, import_wh, export_wh, charge_wh, discharge_wh FROM energy ORDER BY epoch').iterate() as Iterable<Record<string, unknown>>)
    res.write(`${r.ts},${r.solar_wh},${r.home_wh},${r.import_wh},${r.export_wh},${r.charge_wh},${r.discharge_wh}\n`);
  res.end();
});
