// The offline demo server (scripts/demo-server.mjs): its network guard lets only localhost through and answers the public weather
// and grid feeds from synthetic fixtures; its seed writes the expected rows to a throwaway PGlite. Synthetic data only.
import { describe, it, expect, vi } from 'vitest';
import net from 'node:net';
import { makeFetchGuard, guardSockets, isLocalHost } from '../../scripts/demo/guard.js';
import { seedDemo } from '../../scripts/demo/seed.js';
import { houseDay, nestDay, poolDay, DEMO_SITE_ID } from '../../scripts/demo/model.js';
import { q, kv } from '../../server/src/db.js';
import { addDays } from '../../server/src/tesla/client.js';

vi.unmock('../../server/src/db.js');   // the seed test needs the real database module on in-memory PGlite

describe('demo fetch guard', () => {
  const setup = () => {
    const real = vi.fn(async () => new Response('local', { status: 200 })), lines: string[] = [];
    return { real, lines, g: makeFetchGuard(real as unknown as typeof fetch, { log: l => lines.push(l) }) };
  };
  it('passes loopback URLs to the real fetch', async () => {
    const { real, g } = setup();
    for (const u of ['http://localhost:8790/api/now', 'http://127.0.0.1:8790/x', 'http://[::1]:8790/y']) expect(await (await g.fetch(u)).text()).toBe('local');
    expect(real).toHaveBeenCalledTimes(3);
    expect(isLocalHost('app.localhost')).toBe(true);
    expect(isLocalHost('example.com')).toBe(false);
  });
  it('blocks Tesla, Google, Neon and anything else with a 503 and a stderr line, never calling the real fetch', async () => {
    const { real, lines, g } = setup();
    const hosts = ['https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/products', 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
      'https://oauth2.googleapis.com/token', 'https://smartdevicemanagement.googleapis.com/v1/enterprises/x/devices', 'https://ep-demo.us-east-1.aws.neon.tech/sql', 'https://example.com/'];
    for (const u of hosts) {
      const r = await g.fetch(u, { method: 'POST' });
      expect(r.status).toBe(503);
      expect((await r.json()).error).toBe('offline_demo');
    }
    expect(real).not.toHaveBeenCalled();
    expect(lines).toHaveLength(hosts.length);
    expect(lines[0]).toMatch(/blocked fleet-api\.prd\.na\.vn\.cloud\.tesla\.com/);
    expect(Object.keys(g.stats.blocked)).toContain('oauth2.googleapis.com');
  });
  it('answers Open-Meteo, NWS and ERCOT from fixtures shaped like the real feeds', async () => {
    const { real, lines, g } = setup();
    const fc = await (await g.fetch('https://api.open-meteo.com/v1/forecast?latitude=30.27&longitude=-97.74&past_days=2&forecast_days=3&hourly=temperature_2m,global_tilted_irradiance&daily=temperature_2m_max,precipitation_sum&timezone=America%2FChicago')).json();
    expect(fc.daily.time).toHaveLength(5);
    expect(fc.hourly.time.length).toBeGreaterThanOrEqual(5 * 24 - 1);
    expect(fc.hourly.temperature_2m).toHaveLength(fc.hourly.time.length);
    expect(Math.max(...fc.hourly.global_tilted_irradiance)).toBeGreaterThan(100);
    const ar = await (await g.fetch('https://archive-api.open-meteo.com/v1/archive?latitude=30.27&longitude=-97.74&start_date=2026-01-01&end_date=2026-01-31&daily=temperature_2m_max,temperature_2m_min')).json();
    expect(ar.daily.time).toHaveLength(31);
    expect(ar.daily.temperature_2m_max.every((v: number, i: number) => v > ar.daily.temperature_2m_min[i])).toBe(true);
    expect((await (await g.fetch('https://api.weather.gov/alerts/active?point=30.27,-97.74')).json()).features).toEqual([]);
    expect((await (await g.fetch('https://www.ercot.com/api/1/services/read/dashboards/daily-prc.json')).json()).current_condition.state).toBe('normal');
    expect((await (await g.fetch('https://www.ercot.com/api/1/services/read/dashboards/supply-demand.json')).json()).data[0].demand).toBeGreaterThan(0);
    expect(real).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
  it('refuses sockets to non-loopback hosts', async () => {
    guardSockets(() => {});
    const err = await new Promise<Error>(resolve => { const s = net.connect({ host: 'example.com', port: 443 }); s.on('error', resolve); });
    expect(err.message).toMatch(/blocked/);
  });
});

describe('demo seed', () => {
  it('writes the synthetic history to the throwaway PGlite with the expected row counts', async () => {
    const now = Date.parse('2026-10-07T17:00:00Z'), today = '2026-10-07';   // noon in Chicago
    const r = await seedDemo({ now, days: 3, deepDays: 0, deviceDays: 2, pvsDays: 1 });
    const n = async (sql: string, p: unknown[] = []) => Number((await q<{ n: string }>(sql, p))[0].n);
    // three whole days and today until noon (12 hours of 5-minute buckets), the rest of today held back for the ticker
    expect(r.energy).toBe(3 * 288 + 144);
    expect(await n('SELECT COUNT(*) n FROM energy WHERE site_id = $1', [DEMO_SITE_ID])).toBe(r.energy);
    expect(r.pending).toHaveLength(144);
    expect(await n('SELECT COUNT(*) n FROM soe')).toBe(r.energy / 3);
    expect(await n(`SELECT COUNT(*) n FROM synced_days WHERE kind = 'day' AND buckets = 288`)).toBe(3);
    expect(r.synced).toBe(3);
    const devDays = [addDays(today, -2), addDays(today, -1), today];
    const nest = devDays.reduce((a, d) => a + nestDay(d, today, now).length, 0), pool = devDays.reduce((a, d) => a + poolDay(d, today, now).length, 0);
    expect(await n('SELECT COUNT(*) n FROM nest_readings')).toBe(nest);
    expect(await n('SELECT COUNT(*) n FROM pool_readings')).toBe(pool);
    expect(await n(`SELECT COUNT(*) n FROM nest_readings WHERE hvac = 'HEATING'`)).toBeGreaterThan(0);   // today is a cold morning: the strip card shows
    const sunny = houseDay(addDays(today, -1), { today }).filter(b => b.solarKw > 0).length + houseDay(today, { today }).filter(b => b.solarKw > 0 && b.epoch + 300_000 <= now).length;
    expect(await n('SELECT COUNT(*) n FROM pvs_readings')).toBe(sunny * 30);
    expect(await n('SELECT COUNT(*) n FROM sites WHERE tesla_account_id IS NOT NULL')).toBe(1);
    expect(await n('SELECT COUNT(*) n FROM pool_tests')).toBe(3);
    expect(await n('SELECT COUNT(*) n FROM events')).toBe(3);
    expect(r.bills).toBe(0);   // no bill period fits inside three days
    expect((await kv.get<{ at: number }>(`${DEMO_SITE_ID}:pool:last`))?.at).toBe(now);
    expect((await kv.get<{ at: number; deviceId: string }>('nest:last'))?.at).toBe(now);
    // the solar bell and the evening load are where they should be
    const y = houseDay(addDays(today, -1), { today }), noon = y.filter(b => b.hour >= 12 && b.hour < 15), night = y.filter(b => b.hour >= 1 && b.hour < 4);
    expect(Math.max(...noon.map(b => b.solarKw))).toBeGreaterThan(3);
    expect(Math.max(...night.map(b => b.solarKw))).toBe(0);
    expect(y.some(b => b.waterHeaterKw > 4)).toBe(true);
  });
});
