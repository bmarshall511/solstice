// Per-panel health (server/src/panels.ts, approved mockup u-panels): the serial → roof position map, GET /api/pvs/panels, the
// panel.low anomaly rule and its nightly metrics, the `panel` pushes (a panel that stays low, a panel that stops reporting, a silent
// relay), the learning card's action and the digest's "Worth a look".
//   PNL-1 the layout: learned on first sight in the PVS's order, moved by position, never shows a serial
//   PNL-2 the roll-up on seeded readings: now and today vs the median panel, share, lowest three, not reporting, sparklines, totals
//   PNL-3 a silent relay is the relay, not 29 panels; silence counts only while the sun is high enough to produce, and the relay's
//         heartbeat says whether to blame the Mac (offline) or the PVS
//   PNL-4 panelRules on synthetic metrics: producing days, 5 of 7, the clear, the wait, the DC/AC diagnosis
//   PNL-5 the nightly job on PGlite opens panel.low@r2c7 and panel.low@r3c1, the `panel` push, the digest, then clears one
//   PNL-6 the 5-minute watch: a panel silent through an hour of daylight polls, then the relay
// In-process app on 127.0.0.1:0, PGlite in memory, no network. Serials are synthetic (TEST-PNL-nn).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

vi.unmock('../../server/src/db.js');
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => false),
}));

const KEY = 'test-owner-key-synthetic-panels-abcdefghij-kl';   // test-only
const S = 's';
let server: Server, base = '', owner = '';
let db: typeof import('../../server/src/db.js');
let P: typeof import('../../server/src/panels.js');
let R: typeof import('../../server/src/learn/rules.js');

const SN = (i: number) => `TEST-PNL-${String(i + 1).padStart(2, '0')}`;   // PVS order i → Row ⌊i/10⌋+1 · (i mod 10)+1
const IDX = (row: number, col: number) => (row - 1) * 10 + col - 1;
const ctime = (day: string, h: number, m = 0) => Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`);   // CDT
const call = (path: string, init: RequestInit = {}, cookie = owner) => fetch(base + path, { ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) } });

/* ---------- synthetic readings: 5-minute polls 07:00 → 19:00 CDT, a sine day, 250 W peak for the median panel ---------- */
const life = Array.from({ length: 30 }, (_, i) => 1000 + i * 10);
const fac = (i: number) => 1 + ((i * 37) % 7 - 3) * .01;   // .97 … 1.03, deterministic
type Shape = (i: number) => { ac: number; dc: number };
const normal: Shape = i => ({ ac: fac(i), dc: fac(i) });
async function seedDay(day: string, shape: Shape, o: { to?: [number, number]; from?: [number, number]; skip?: (i: number, ms: number) => boolean } = {}) {
  const t0 = ctime(day, ...(o.from ?? [7, 0])), t1 = ctime(day, ...(o.to ?? [19, 0]));
  const ts: string[] = [], sn: string[] = [], kw: number[] = [], dc: number[] = [], tc: number[] = [], lf: number[] = [];
  for (let t = t0; t <= t1; t += 300_000) {
    const h = (t - ctime(day, 0)) / 36e5, sun = Math.max(0, Math.sin(Math.PI * (h - 7) / 12));
    for (let i = 0; i < 30; i++) {
      if (o.skip?.(i, t)) continue;
      const f = shape(i), a = .25 * sun * f.ac, d = .25 * sun * f.dc / .96;
      life[i] += a * 5 / 60;
      ts.push(new Date(t).toISOString()); sn.push(SN(i)); kw.push(+a.toFixed(5)); dc.push(+d.toFixed(5)); tc.push(+(35 + a * 60 + i * .1).toFixed(2)); lf.push(+life[i].toFixed(6));
    }
  }
  await db.q(`INSERT INTO pvs_readings (ts, sn, kw, kw_dc, temp_c, kwh_lifetime) SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[])`,
    [ts, sn, kw, dc, tc, lf]);
}
const LOW = IDX(2, 7), INV = IDX(3, 1), SILENT = IDX(1, 3);
const lowDay: Shape = i => i === LOW ? { ac: .6, dc: .6 } : i === INV ? { ac: .6, dc: 1 } : normal(i);   // r2c7 shaded; r3c1's microinverter loses it

beforeAll(async () => {
  Object.assign(process.env, { OWNER_KEY: KEY, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  P = await import('../../server/src/panels.js');
  R = await import('../../server/src/learn/rules.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ($1, NULL, 1, 'Test home')`, [S]);
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  server.keepAliveTimeout = 60_000;   // a direct panelsDay() test can outlast the 5 s default under a loaded full run; then the next fetch reused a closing socket (ECONNRESET)
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + '/api/auth/owner', { method: 'POST', body: JSON.stringify({ key: KEY }), headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.61' } });
  owner = (r.headers.getSetCookie().find(c => c.startsWith('solstice_owner=')) ?? '').split(';')[0];
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });

/* ======================================================================= PNL-1 */
describe('PNL-1 the roof position map', () => {
  it('learns serials in the order the PVS lists them (Row 1 · 1 … Row 3 · 10) and leaves a 31st unplaced', () => {
    const r = P.learnSlots(null, Array.from({ length: 31 }, (_, i) => SN(i)), 1);
    expect(r.added).toBe(30);
    expect(r.layout.slots[SN(0)]).toEqual({ row: 1, col: 1 });
    expect(r.layout.slots[SN(9)]).toEqual({ row: 1, col: 10 });
    expect(r.layout.slots[SN(16)]).toEqual({ row: 2, col: 7 });
    expect(r.layout.slots[SN(29)]).toEqual({ row: 3, col: 10 });
    expect(r.layout.slots[SN(30)]).toBeUndefined();
    expect(P.learnSlots(r.layout, [SN(3), SN(0)], 2).added).toBe(0);   // stable: seen serials keep their place
  });
  it('moves by position only; a half swap that would stack two panels is refused', () => {
    const l = P.learnSlots(null, Array.from({ length: 30 }, (_, i) => SN(i)), 1).layout;
    const ok = P.applyMoves(l, { r1c1: 'r1c2', r1c2: 'r1c1' }, 5);
    expect(ok.ok && ok.layout.slots[SN(0)]).toEqual({ row: 1, col: 2 });
    expect(P.applyMoves(l, { r1c1: 'r1c2' })).toEqual({ ok: false, error: 'two panels would sit on r1c2; move both sides of a swap' });
    expect(P.applyMoves(l, { r4c1: 'r1c1' }).ok).toBe(false);
    expect(P.applyMoves(l, [] as unknown).ok).toBe(false);
    expect(JSON.stringify(P.layoutView(l))).not.toContain('TEST-PNL');
  });
  it('ingest learns it into kv pvs:layout; GET /api/pvs/layout shows positions; POST swaps; bad input 400; anonymous 401', async () => {
    const { ingestPvs } = await import('../../server/src/pvs.js');
    await ingestPvs({ ts: new Date(ctime('2026-09-30', 12)), inverters: Array.from({ length: 30 }, (_, i) => ({ sn: SN(i), kw: .2, kwDc: .21, v: 240, tempC: 40, kwhLifetime: life[i] })) });
    const g = await (await call('/api/pvs/layout')).json();
    expect(g).toMatchObject({ learned: true, mapped: 30, expected: 30 });
    expect(g.positions[0]).toEqual({ id: 'r1c1', row: 1, col: 1, name: 'Row 1 · 1' });
    expect(JSON.stringify(g)).not.toContain('TEST-PNL');
    const swap = await call('/api/pvs/layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ moves: { r1c1: 'r1c2', r1c2: 'r1c1' } }) });
    expect(swap.status).toBe(200);
    expect((await db.kv.get<any>('pvs:layout')).slots[SN(0)]).toEqual({ row: 1, col: 2 });
    await call('/api/pvs/layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ moves: { r1c1: 'r1c2', r1c2: 'r1c1' } }) });
    expect((await db.kv.get<any>('pvs:layout')).slots[SN(0)]).toEqual({ row: 1, col: 1 });
    expect((await call('/api/pvs/layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ moves: { r1c1: 'r9c9' } }) })).status).toBe(400);
    expect((await call('/api/pvs/layout', {}, '')).status).toBe(401);
    expect((await call('/api/pvs/panels', {}, '')).status).toBe(401);
    await db.q(`DELETE FROM pvs_readings`);
  });
});

/* ======================================================================= PNL-4 (pure) */
describe('PNL-4 panelRules', () => {
  const days = Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  const ctx = (ratios: Array<number | null>, o: { array?: number[]; cov?: number[]; open?: boolean; dc?: number; ac?: number } = {}): import('../../server/src/learn/rules.js').RuleCtx => {
    const m = new Map<string, Record<string, number>>();
    ratios.forEach((r, i) => { if (r == null) return;
      m.set(days[i], { 'pvs.array_kwh': o.array?.[i] ?? 45, 'pvs.r2c7.ratio': r, 'pvs.r2c7.cov': o.cov?.[i] ?? 1, 'pvs.r2c7.dc': o.dc ?? .1, 'pvs.r2c7.ac': o.ac ?? .096,
        'pvs.median_dc': .16, 'pvs.median_conv': .96 }); });
    const open = new Map(o.open ? [['panel.low@r2c7', { id: 1, kind: 'panel.low@r2c7', day: days[0], severity: 'warn', detail: { title: 'Row 2 · 7 is running low', body: 'x' } }]] : []);
    return { days: days.slice(0, ratios.length), m, open, pumpBaseline: {}, expectedBuckets: () => 288 };
  };
  const v = (c: ReturnType<typeof ctx>) => R.panelRules(c).find(x => x.kind === 'panel.low@r2c7')!;

  it('fires at 5 of the last 7 producing days under 85%, with the mockup’s texts and the 7-day percentages', () => {
    const f = v(ctx([.9, .7, .6, .62, .66, .63, .61, .62]));
    expect(f.state).toBe('fire');
    expect(f.severity).toBe('warn');
    expect(f.detail).toMatchObject({ title: 'Row 2 · 7 is running low', action: 'open_panels', nLow: 7, window: 7, measured: 62, row: 2, col: 7,
      body: '62% of the median panel on Oct 8, and under 85% on 7 of the last 7 producing days. Shade, soiling or a failing microinverter.' });
    expect((f.detail.days as any[]).map(d => d.pct)).toEqual([70, 60, 62, 66, 63, 61, 62]);
    expect((f.detail.days as any[])[0].label).toBe('Fr 2');
    expect((f.detail.diag as any).kind).toBe('light');
    expect((f.detail.diag as any).lead).toBe('DC in is low too');
  });
  it('4 of 7 holds; non-producing days (array < 15 kWh, or the panel under 90% of polls) are skipped, not counted as good', () => {
    expect(v(ctx([.9, .9, .9, .7, .7, .7, .7])).state).toBe('hold');
    // the 4 low days plus a 5th low day whose good neighbours are not producing days
    const c = ctx([.7, .95, .7, .95, .7, .7, .7], { array: [45, 10, 45, 45, 45, 45, 45], cov: [1, 1, 1, .5, 1, 1, 1] });
    expect(v(c).state).toBe('fire');
    expect(v(c).detail.window).toBe(5);
  });
  it('an open one clears after 3 producing days in a row at ≥ 90%, and holds otherwise', () => {
    expect(v(ctx([.6, .6, .6, .6, .6, .95, .92, .91], { open: true })).state).toBe('clear');
    expect(v(ctx([.6, .6, .6, .6, .6, .95, .89, .91], { open: true })).state).toBe('hold');
  });
  it('fewer than 5 producing days anywhere: one wait verdict, not 30', () => {
    const out = R.panelRules(ctx([.6, .6, .6]));
    expect(out.filter(x => x.state === 'wait').map(x => x.kind)).toEqual(['panel.low']);
    expect(R.panelRules({ ...ctx([]), m: new Map() })).toEqual([]);
  });
  it('diagnosis: low DC = light; normal DC with AC under 90% of it = the microinverter', () => {
    expect(R.panelDiagnosis(.62, .96)?.kind).toBe('light');
    expect(R.panelDiagnosis(1, .6)?.kind).toBe('inverter');
    expect(R.panelDiagnosis(1, .6)?.text).toContain('passes on only 60%');
    expect(R.panelDiagnosis(1, .96)?.kind).toBe('unclear');
    expect(R.panelDiagnosis(null, .9)).toBeNull();
    expect((v(ctx([.6, .6, .6, .6, .6, .6, .6], { dc: .16, ac: .09 })).detail.diag as any).kind).toBe('inverter');
  });
});

/* ======================================================================= PNL-5 nightly (seeds Oct 1–7) */
describe('PNL-5 the nightly job opens, pushes and clears panel.low', () => {
  it('seven producing days with Row 2 · 7 and Row 3 · 1 at 60% open both, with the right diagnosis', async () => {
    for (let d = 1; d <= 7; d++) await seedDay(`2026-10-0${d}`, lowDay);
    const { runLearn } = await import('../../server/src/learn/nightly.js');
    const r = await runLearn(S, { now: ctime('2026-10-08', 5, 20) });
    expect(r.errors).toEqual([]);
    expect(r.anomalies.opened.sort()).toEqual(['panel.low@r2c7', 'panel.low@r3c1']);
    const rows = await db.q<{ kind: string; day: string; detail: any }>(`SELECT kind, day, detail FROM anomalies WHERE site_id = $1 AND kind LIKE 'panel.low@%' ORDER BY kind`, [S]);
    expect(rows.map(x => [x.kind, x.day])).toEqual([['panel.low@r2c7', '2026-10-07'], ['panel.low@r3c1', '2026-10-07']]);
    expect(rows[0].detail).toMatchObject({ title: 'Row 2 · 7 is running low', action: 'open_panels', nLow: 7, window: 7, row: 2, col: 7 });
    expect(rows[0].detail.measured).toBeGreaterThanOrEqual(58); expect(rows[0].detail.measured).toBeLessThanOrEqual(62);
    expect(rows[0].detail.diag.kind).toBe('light');
    expect(rows[1].detail.diag.kind).toBe('inverter');
    expect(await db.one(`SELECT value FROM daily_metrics WHERE site_id = $1 AND day = '2026-10-03' AND metric = 'pvs.polls'`, [S])).toEqual({ value: 137 });   // daylight polls: median panel ≥ 20 W, 07:20–18:40
    expect(JSON.stringify(rows)).not.toContain('TEST-PNL');
  });

  it('the nightly alert is one `panel` push per panel (not `anomaly`), and the digest lists it under Worth a look', async () => {
    const { notifyAnomalies } = await import('../../server/src/notify.js');
    const now = ctime('2026-10-08', 5, 25);
    await db.q(`UPDATE anomalies SET opened_at = $1 WHERE kind LIKE 'panel.low@%'`, [now - 60_000]);
    const r = await notifyAnomalies(S, now);
    expect(r.notified).toBe(2);
    const alerts = await db.q<{ kind: string; title: string; body: string; data: any }>(`SELECT kind, title, body, data FROM alerts WHERE site_id = $1 ORDER BY title`, [S]);
    expect(alerts.map(a => [a.kind, a.title])).toEqual([['panel', 'Panel Row 2 · 7 is running low'], ['panel', 'Panel Row 3 · 1 is running low']]);
    expect(alerts[0].body).toBe('Under 85% of the median panel on 7 of the last 7 days. Tap to see it on the roof.');
    expect(alerts[0].data).toMatchObject({ anomaly: 'panel.low@r2c7', action: 'open_panels' });
    expect((await notifyAnomalies(S, now + 60_000)).notified).toBe(0);   // a rerun repeats nothing
    const { buildDigest } = await import('../../server/src/digest.js');
    const d = await buildDigest(S, '2026-10-05', now);
    expect(d.anomalies.items.map(x => [x.kind, x.title])).toEqual(expect.arrayContaining([['panel.low@r2c7', 'Row 2 · 7 is running low']]));
    // the learning card reads GET /api/models: the anomaly line carries action open_panels
    const m = await (await call('/api/models')).json();
    expect(m.anomalies.find((a: any) => a.kind === 'panel.low@r2c7')).toMatchObject({ title: 'Row 2 · 7 is running low', detail: { action: 'open_panels' } });
  });
});

/* ======================================================================= PNL-2 / PNL-3 roll-up (Oct 8, 07:00 → 14:35) */
describe('PNL-2 GET /api/pvs/panels', () => {
  const NOW = ctime('2026-10-08', 14, 35);
  it('now and today against the median panel, shares, lowest three, not reporting, sparklines, totals, the open anomaly', async () => {
    await seedDay('2026-10-08', lowDay, { to: [14, 35], skip: (i, t) => i === SILENT && t > ctime('2026-10-08', 13, 55) });
    const b = await P.panelsDay('2026-10-08', NOW);
    expect(b).toMatchObject({ date: '2026-10-08', today: true, sunDown: false, reporting: 29, layout: { learned: true, mapped: 30, unmapped: 0 },
      relay: { lastPoll: new Date(NOW).toISOString(), ageS: 0, silent: false, daylight: true }, since: '2026-10-01', days: 8 });
    expect(b.panels.map(p => p.id).slice(0, 3)).toEqual(['r1c1', 'r1c2', 'r1c3']);
    const by = (id: string) => b.panels.find(p => p.id === id)!;
    expect(by('r1c3')).toMatchObject({ reporting: false, pctNow: null, pctToday: null });
    expect(b.notReporting).toEqual([expect.objectContaining({ id: 'r1c3', name: 'Row 1 · 3', silentMin: 40, pushAt: new Date(ctime('2026-10-08', 14, 55)).toISOString() })]);
    expect(by('r2c7').pctNow!).toBeGreaterThan(58); expect(by('r2c7').pctNow!).toBeLessThan(62);
    expect(by('r2c7').pctToday!).toBeGreaterThan(58); expect(by('r2c7').pctToday!).toBeLessThan(62);
    expect(by('r2c7')).toMatchObject({ flagged: true, name: 'Row 2 · 7', row: 2, col: 7, kwhSource: 'lifetime' });
    expect(b.lowest.map(x => x.id).slice(0, 2).sort()).toEqual(['r2c7', 'r3c1']);
    expect(b.lowest).toHaveLength(3);
    expect(b.now.weakest!.id).toMatch(/^r(2c7|3c1)$/);
    expect(b.panels.reduce((a, p) => a + (p.sharePct ?? 0), 0)).toBeCloseTo(100, 0);
    expect(b.totals.kwh).toBeCloseTo(b.panels.reduce((a, p) => a + (p.kwh ?? 0), 0), 2);
    expect(b.totals.spread!.hiPct).toBeGreaterThan(100);
    expect(b.totals.hottest).toMatchObject({ id: expect.stringMatching(/^r\dc\d+$/) });
    for (const p of b.panels) expect(p.spark).toHaveLength(b.times.length);
    expect(b.medianSeries).toHaveLength(b.times.length);
    expect(b.anomalies.map(a => a.id)).toEqual(['r2c7', 'r3c1']);
    expect(b.anomalies[0].days).toHaveLength(7);
    expect(b.anomalies[0].diag!.kind).toBe('light');       // live: DC in is low too
    expect(b.anomalies[1].diag!.kind).toBe('inverter');    // live: normal DC, AC 60% of it
    expect(b.now.medianConvPct).toBeCloseTo(96, 0);
    expect(JSON.stringify(b)).not.toContain('TEST-PNL');
  });
  it('the route: 400 on a bad date; the owner gets the alert state; a past day has no "now" values', async () => {
    // the route reads the clock: pin it to the fixture's day (on the real 2026-10-07 this "past day" was today)
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    try {
    expect((await call('/api/pvs/panels?date=2026-13-01')).status).toBe(400);
    const b = await (await call('/api/pvs/panels?date=2026-10-07')).json();
    expect(b).toMatchObject({ date: '2026-10-07', today: false, sunDown: true });
    expect(b.panels.every((p: any) => p.kw === null && p.pctNow === null && p.pctToday != null)).toBe(true);
    expect(b.alerts['panel.low@r2c7']).toMatchObject({ pushed: false });
    expect(JSON.stringify(b)).not.toContain('TEST-PNL');
    } finally { vi.useRealTimers(); }
  });
  it('PNL-3 a relay that went quiet is reported as the relay: no panel is listed as not reporting', async () => {
    const b = await P.panelsDay('2026-10-08', NOW + 40 * 60_000);
    expect(b.relay).toMatchObject({ silent: true, ageS: 2400, silentMin: 40, cause: 'offline',
      note: 'The Mac running the PVS relay may be asleep or off the network' });
    expect(b.notReporting).toEqual([]);
  });
  it('PNL-3b the relay is running but the PVS refused: the heartbeat moves the blame from the Mac to the PVS; the guest never sees the raw error', async () => {
    const at = NOW + 38 * 60_000;
    await db.kv.set('pvs:heartbeat', { at, pvs: 'no-inverters', http: 400, error: 'PVS answered HTTP 400 at 192.0.2.45', uptimeS: 4 * 3600 });
    try {
      const b = await P.panelsDay('2026-10-08', NOW + 40 * 60_000);
      expect(b.relay).toMatchObject({ silent: true, silentMin: 40, cause: 'pvs', heardAt: new Date(at).toISOString(),
        note: 'The relay is running, but the PVS answers without any inverters since it restarted at 11:13 AM',
        pvs: { status: 'no-inverters', http: 400, uptimeS: 14400, error: 'PVS answered HTTP 400 at 192.0.2.45' } });
      const { GUEST_GET } = await import('../../server/src/redact.js');
      const guest = GUEST_GET.get('/api/pvs/panels')!(JSON.parse(JSON.stringify(b))) as any;
      expect(guest.relay).toEqual({ lastPoll: b.relay.lastPoll, ageS: 2400, silent: true, daylight: b.relay.daylight, silentMin: 40,
        heardAt: b.relay.heardAt, cause: 'pvs', note: b.relay.note });   // no relay.pvs
      expect(JSON.stringify(guest)).not.toContain('192.0.2.45');
      // the relay runs and the PVS answers, but with an old measurement
      await db.kv.set('pvs:heartbeat', { at, pvs: 'ok', http: 200, error: null, uptimeS: null });
      expect((await P.panelsDay('2026-10-08', NOW + 40 * 60_000)).relay).toMatchObject({ cause: 'stale',
        note: 'The relay is running, but the PVS keeps sending its measurement from 2:35 PM' });
      // a heartbeat older than 15 minutes is the Mac again
      expect((await P.panelsDay('2026-10-08', at + 16 * 60_000)).relay).toMatchObject({ cause: 'offline' });
    } finally { await db.q(`DELETE FROM kv WHERE key = 'pvs:heartbeat'`); }
  });
  it('PNL-3c the same night-time measurement repeated until morning is not silence; the first minutes of producing sun are', async () => {
    // SITE_LAT/LON are unset in tests, so "producing" falls back to 08:00–18:00 Chicago. The last reading at 14:35: an afternoon
    // outage counts until 18:00 only, not the 9 h 15 min since
    expect((await P.panelsDay('2026-10-08', ctime('2026-10-08', 23, 50))).relay).toMatchObject({ silent: true, silentMin: 205 });
    // 2026-09-28: the PVS re-served its 18:45 measurement all night; at 06:38 that is not silence, at 08:20 it is 20 minutes
    const dusk = new Date(ctime('2026-10-20', 18, 45)).toISOString();
    await db.q(`INSERT INTO pvs_readings (ts, sn, kw) SELECT $1::timestamptz, sn, 0.0013 FROM unnest($2::text[]) sn`, [dusk, Array.from({ length: 30 }, (_, i) => SN(i))]);
    try {
      expect((await P.panelsDay('2026-10-21', ctime('2026-10-21', 6, 38))).relay).toMatchObject({ silent: false, silentMin: 0, cause: null, note: null });
      expect((await P.panelsDay('2026-10-21', ctime('2026-10-21', 8, 20))).relay).toMatchObject({ silent: true, silentMin: 20, cause: 'offline' });
      expect(await P.panelWatch(S, ctime('2026-10-21', 6, 38))).toMatchObject({ relay: 'silent', pushed: false, why: 'not daylight' });
      expect(await P.panelWatch(S, ctime('2026-10-21', 8, 30))).toMatchObject({ relay: 'late' });   // 30 min of sun: no push yet
    } finally { await db.q(`DELETE FROM pvs_readings WHERE ts = $1::timestamptz`, [dusk]); }
    expect(P.producingMs(ctime('2026-10-08', 18, 45), ctime('2026-10-09', 6, 38))).toBe(0);
    expect(P.producingMs(ctime('2026-10-08', 18, 45), ctime('2026-10-09', 8, 20))).toBe(20 * 60_000);
    // with a location: only the sun above 15° counts (a generic mid-latitude site, late September, CDT)
    const loc = { lat: 35, lon: -90, zip: '00000' };
    const ms = (h: number, m = 0, d = '2026-09-28') => ctime(d, h, m);
    expect(P.producingMs(ms(18, 45, '2026-09-27'), ms(6, 38), loc)).toBe(0);
    const morning = P.producingMs(ms(6, 0), ms(9, 0), loc) / 60_000;
    expect(morning).toBeGreaterThan(30); expect(morning).toBeLessThan(120);   // the sun passes 15° a while after sunrise
    expect(P.producingMs(ms(12, 0), ms(13, 0), loc)).toBe(3600_000);
  });
});

/* ======================================================================= PNL-6 the 5-minute watch */
describe('PNL-6 panelWatch', () => {
  const titles = async () => (await db.q<{ title: string }>(`SELECT title FROM alerts WHERE site_id = $1 AND kind = 'panel' AND data->>'anomaly' IS NULL ORDER BY id`, [S])).map(r => r.title);
  it('40 minutes of silence is only the card line; after 12 daylight polls a `panel` push, once', async () => {
    expect(await P.panelWatch(S, ctime('2026-10-08', 14, 36))).toMatchObject({ silent: 0 });
    await seedDay('2026-10-08', lowDay, { from: [14, 40], to: [15, 0], skip: i => i === SILENT });
    const r = await P.panelWatch(S, ctime('2026-10-08', 15, 1));
    expect(r).toMatchObject({ silent: 1, notified: ['r1c3'] });
    expect(await titles()).toEqual(['Panel Row 1 · 3 has stopped reporting']);
    expect(await P.panelWatch(S, ctime('2026-10-08', 15, 2))).toMatchObject({ notified: [] });
  });
  it('an hour without any poll in daylight: one push about the relay, none about panels', async () => {
    const r = await P.panelWatch(S, ctime('2026-10-08', 16, 10));
    expect(r).toMatchObject({ relay: 'silent', pushed: true });
    expect(await P.panelWatch(S, ctime('2026-10-08', 16, 15))).toMatchObject({ relay: 'silent', pushed: false });
    expect(await P.panelWatch(S, ctime('2026-10-08', 22, 0))).toMatchObject({ relay: 'silent', why: 'not daylight' });
    expect(await titles()).toEqual(['Panel Row 1 · 3 has stopped reporting', 'The PVS relay has gone quiet']);
  });
});

/* ======================================================================= PNL-5b the clear (runs last: seeds Oct 9–11) */
describe('PNL-5b three good producing days clear it', () => {
  it('Row 2 · 7 back at the median for Oct 9–11 resolves panel.low@r2c7; Row 3 · 1 stays open', async () => {
    const back: Shape = i => i === INV ? { ac: .6, dc: 1 } : normal(i);
    for (const d of ['2026-10-09', '2026-10-10', '2026-10-11']) await seedDay(d, back);
    const { runLearn } = await import('../../server/src/learn/nightly.js');
    const r = await runLearn(S, { now: ctime('2026-10-12', 5, 20) });
    expect(r.anomalies.resolved).toEqual(['panel.low@r2c7']);
    expect(await db.q(`SELECT kind FROM anomalies WHERE site_id = $1 AND kind LIKE 'panel.low@%' AND resolved_at IS NULL`, [S])).toEqual([{ kind: 'panel.low@r3c1' }]);
  });
});
