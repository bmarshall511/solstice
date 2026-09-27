// The weekly digest (server/src/digest.ts; enhancements D1c, in-app + push only).
//   DIG-1 ISO weeks, including the 53-week year and bad input
//   DIG-2 the arithmetic on seeded PGlite data: totals, sunshine share, last week and the difference, best day, Powerwall days,
//         Autopilot actions from the pool and AC logs, anomalies, confidence tiers; no dollar figure anywhere
//   DIG-3 Monday 07:00 Chicago, once: before, at, again, and after the window; the stored row and the one alert
//   DIG-4 GET /api/digest: stored week, built week, default, bad week; anonymous is refused
// In-process app on 127.0.0.1:0, PGlite in memory, no network. Synthetic values only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

vi.unmock('../../server/src/db.js');
vi.mock('../../server/src/sync.js', async orig => ({
  ...(await orig<typeof import('../../server/src/sync.js')>()),
  syncSite: vi.fn(async () => ({ mocked: true })), refreshSiteInfo: vi.fn(async () => {}), refreshLive: vi.fn(async () => false),
}));

const KEY = 'test-owner-key-synthetic-digest-abcdefghij-kl';   // test-only
let server: Server, base = '', owner = '';
let db: typeof import('../../server/src/db.js');
let D: typeof import('../../server/src/digest.js');

const call = (path: string, cookie = owner) => fetch(base + path, { headers: cookie ? { cookie } : {} });
const pad = (n: number) => String(n).padStart(2, '0');
const row = (day: string, hour: number, wh: { solar: number; home: number; imp: number; exp: number }) => {
  const ts = `${day}T${pad(hour)}:00:00-05:00`;
  return { ts, epoch: Date.parse(ts), day, hour, ...wh, chg: 0, dis: 0 };
};
const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from + 'T12:00:00Z') + i * 864e5).toISOString().slice(0, 10));

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'pglite:memory://';
  if (!process.env.DATABASE_URL.startsWith('pglite:')) throw new Error('digest tests only run against PGlite');
  Object.assign(process.env, { OWNER_KEY: KEY, SESSION_SECRET: 'test-session-secret-synthetic-abcdefghij' });
  delete process.env.MULTI_USER; delete process.env.VERCEL;
  const { app } = await import('../../server/src/app.js');
  db = await import('../../server/src/db.js');
  D = await import('../../server/src/digest.js');
  await db.migrate();
  await db.q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'test-a', 'test-r', 0)`);
  await db.q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ('s', NULL, 1, 'Test home')`);
  await seed();
  server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  (globalThis as any).__testServerPorts.add(port);
  base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + '/api/auth/owner', { method: 'POST', body: JSON.stringify({ key: KEY }), headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.50' } });
  owner = (r.headers.getSetCookie().find(c => c.startsWith('solstice_owner=')) ?? '').split(';')[0];
});
afterAll(async () => { if (server) { server.close(); await once(server, 'close'); } });

/** W39 (Mon 2026-09-21 … Sun 09-27): each day 30 kWh solar at noon (35 on Wed), 20 + 10 kWh used, 5 bought at night, 8 sent.
 *  W38: each day 20 solar, 25 used, 10 bought, 2 sent. A big day on Mon 09-28 must not count. */
async function seed() {
  const { saveEnergyRows, saveSoe } = await import('../../server/src/sync.js');
  await saveEnergyRows('s', [
    ...days('2026-09-21', 7).flatMap(d => [row(d, 12, { solar: d === '2026-09-23' ? 35000 : 30000, home: 20000, imp: 0, exp: 8000 }), row(d, 21, { solar: 0, home: 10000, imp: 5000, exp: 0 })]),
    ...days('2026-09-14', 7).map(d => row(d, 12, { solar: 20000, home: 25000, imp: 10000, exp: 2000 })),
    row('2026-09-28', 12, { solar: 99000, home: 1000, imp: 0, exp: 90000 }),
  ]);
  await saveSoe('s', [['2026-09-21', 10, 100], ['2026-09-21', 23, 30], ['2026-09-22', 10, 80], ['2026-09-22', 23, 22], ['2026-09-20', 23, 5]]
    .map(([d, h, soe]) => ({ timestamp: `${d}T${pad(h as number)}:00:00-05:00`, soe: soe as number })));
  await db.kv.set('s:pool:autolog', [
    { at: 1, day: '2026-09-26', text: 'Suggested for tomorrow: 7 h. rain likely', delta: 'waiting for you' },
    { at: 1, day: '2026-09-24', text: 'Tomorrow: 6 h at 1,500 RPM. season plan, about $0.40/day', delta: '2.3 kWh' },
    { at: 1, day: '2026-09-23', text: 'Refused tomorrow\'s plan: circuit 9 is not managed', delta: 'refused' },
    { at: 1, day: '2026-09-19', text: 'Tomorrow: 8 h (last week)', delta: '3.1 kWh' }]);
  await db.kv.set('s:ac:log', [
    { at: 1, day: '2026-09-25', text: 'Set 76° (morning, comfort band)' }, { at: 1, day: '2026-09-25', text: 'Did not set 72° (pre-cool): one change per 30 min', delta: 'refused' },
    { at: 1, day: '2026-09-22', text: 'Set 78° (coast on the Powerwalls)', delta: 'stepping' }, { at: 1, day: '2026-09-28', text: 'Set 75° (next week)' }]);
  const anomaly = (day: string, kind: string, title: string, resolved: number | null) =>
    db.q(`INSERT INTO anomalies (site_id, day, kind, severity, detail, opened_at, resolved_at) VALUES ('s', $1, $2, 'warn', $3, $4, $5)`, [day, kind, JSON.stringify({ title, body: 'b' }), Date.parse(day), resolved]);
  await anomaly('2026-09-24', 'pump.below_baseline@1500', 'Pump drawing less', null);
  await anomaly('2026-09-22', 'data.gap.energy', 'Energy history has a gap', Date.parse('2026-09-23'));
  await anomaly('2026-09-01', 'home.always_on_step', 'Always-on load up', null);
}

describe('ISO weeks', () => {
  it('DIG-1 labels, Mondays and the week query', () => {
    expect(D.isoWeek('2026-09-21')).toBe('2026-W39');
    expect(D.isoWeek('2026-09-27')).toBe('2026-W39');
    expect(D.isoWeek('2025-12-29')).toBe('2026-W01');
    expect(D.isoWeek('2027-01-01')).toBe('2026-W53');   // 2026 starts on a Thursday: 53 weeks
    expect(D.weekMonday('2026-W39')).toBe('2026-09-21');
    expect(D.weekMonday('2026-W53')).toBe('2026-12-28');
    expect(D.weekMonday('2025-W53')).toBeNull();
    expect(D.weekMonday('2026-W00')).toBeNull();
    expect(D.parseWeek('2026-09-24')).toBe('2026-09-21');
    expect(D.parseWeek(undefined, '2026-09-27')).toBe('2026-09-14');
    expect(D.parseWeek(undefined, '2026-09-28')).toBe('2026-09-21');
    expect(D.parseWeek('last week')).toBeNull();
    expect(D.sunshare(0, 0)).toBeNull();
    expect(D.sunshare(10, 12)).toBe(0);
  });
});

describe('the digest', () => {
  it('DIG-2 adds up last week exactly, compares it with the week before, and carries no dollar figure', async () => {
    const d = await D.buildDigest('s', '2026-09-21', Date.parse('2026-09-28T12:00:00Z'));
    expect(d).toMatchObject({ week: '2026-W39', from: '2026-09-21', to: '2026-09-27', partial: false });
    expect(d.totals).toEqual({ days: 7, solarKwh: 215, homeKwh: 210, importKwh: 35, exportKwh: 56, sunsharePct: 83 });
    expect(d.lastWeek).toEqual({ days: 7, solarKwh: 140, homeKwh: 175, importKwh: 70, exportKwh: 14, sunsharePct: 60 });
    expect(d.vsLastWeek).toEqual({ solarKwh: 75, homeKwh: 35, importKwh: -35, exportKwh: 42, sunsharePts: 23 });
    expect(d.bestSolarDay).toEqual({ date: '2026-09-23', kwh: 35 });
    expect(d.powerwall).toEqual({ fullDays: 1, daysWithData: 2, lowestPct: 22 });
    expect(d.autopilot.pool).toEqual({ applied: 1, suggested: 1, refused: 1, lines: ['Suggested for tomorrow: 7 h. rain likely', 'Tomorrow: 6 h at 1,500 RPM. season plan, about', 'Refused tomorrow\'s plan: circuit 9 is not managed'] });
    expect(d.autopilot.ac).toMatchObject({ set: 2, refused: 1 });
    expect(d.anomalies).toEqual({ open: 2, openedThisWeek: 2, items: [
      { kind: 'pump.below_baseline@1500', title: 'Pump drawing less', severity: 'warn', day: '2026-09-24' }, { kind: 'home.always_on_step', title: 'Always-on load up', severity: 'warn', day: '2026-09-01' }] });
    const { MODEL_IDS } = await import('../../server/src/learn/models.js');
    expect(Object.keys(d.confidence).sort()).toEqual([...MODEL_IDS].sort());
    expect(Object.values(d.confidence).every(t => ['measured', 'learned', 'estimated', 'learning', 'unscored'].includes(t))).toBe(true);
    // no money: no dollar sign in any value, no money-shaped key
    const json = JSON.stringify(d), keys: string[] = [];
    JSON.parse(json, (k, v) => { keys.push(k); return v; });
    expect(json).not.toMatch(/\$/);
    expect(keys.filter(k => !(MODEL_IDS as readonly string[]).includes(k) && /usd|cost|dollar|price|rate|credit|bill/i.test(k))).toEqual([]);   // model ids are names, not money
    expect(D.digestAlert(d)).toEqual({ title: 'Your week: 83% from sunshine',
      body: '215 kWh of solar, 210 kWh used, 35 kWh bought, 56 kWh sent. 2 open anomalies · 1 pool plan suggested.' });
    // a week with no history: zeros and no comparison
    expect((await D.buildDigest('s', '2026-08-03')).totals).toEqual({ days: 0, solarKwh: 0, homeKwh: 0, importKwh: 0, exportKwh: 0, sunsharePct: null });
  });

  it('DIG-3 Monday 07:00 Chicago builds, stores and announces last week once', async () => {
    const mon = (utc: string) => Date.parse(`2026-09-28T${utc}Z`);   // Chicago is UTC−5 in September: 07:00 CDT = 12:00 UTC
    expect(await D.maybeWeeklyDigest('s', Date.parse('2026-09-27T20:00:00Z'))).toEqual({ skipped: 'outside the Monday–Tuesday window' });
    expect(await D.maybeWeeklyDigest('s', mon('11:59:00'))).toEqual({ skipped: 'before Monday 07:00' });
    expect(await D.maybeWeeklyDigest('s', mon('12:00:00'))).toEqual({ week: '2026-W39', stored: true, notified: true, pushed: 0 });
    expect(await D.maybeWeeklyDigest('s', mon('12:05:00'))).toEqual({ skipped: 'already sent', week: '2026-W39' });
    expect(await D.maybeWeeklyDigest('s', Date.parse('2026-09-30T12:00:00Z'))).toEqual({ skipped: 'outside the Monday–Tuesday window' });
    const stored = await db.q<{ week: string; data: any }>(`SELECT week, data FROM digests WHERE site_id = 's'`);
    expect(stored.map(r => r.week)).toEqual(['2026-W39']);
    expect(stored[0].data.totals.solarKwh).toBe(215);
    const alerts = await db.q(`SELECT kind, title, data FROM alerts WHERE kind = 'digest'`);
    expect(alerts).toEqual([{ kind: 'digest', title: 'Your week: 83% from sunshine', data: { week: '2026-W39', key: 'digest:2026-W39' } }]);
    // the owner switched the digest off: the next week is still stored (for the card) but no alert is sent
    await db.kv.set('settings:owner', { alerts: { digest: false } });
    expect(await D.maybeWeeklyDigest('s', Date.parse('2026-10-05T13:00:00Z'))).toMatchObject({ week: '2026-W40', stored: true, notified: false });
    await db.kv.set('settings:owner', {});
  });

  it('DIG-4 GET /api/digest: a stored week, a built one, the default, a bad week; owner only', async () => {
    const w39 = await (await call('/api/digest?week=2026-W39')).json();
    expect(w39).toMatchObject({ week: '2026-W39', stored: true, totals: { solarKwh: 215 } });
    const w38 = await (await call('/api/digest?week=2026-09-15')).json();
    expect(w38).toMatchObject({ week: '2026-W38', stored: false, totals: { solarKwh: 140, sunsharePct: 60 } });
    expect((await call('/api/digest')).status).toBe(200);
    const bad = await call('/api/digest?week=2026-W99');
    expect(bad.status).toBe(400);
    expect((await call('/api/digest?week=2026-W39', '')).status).toBe(401);
  });
});
