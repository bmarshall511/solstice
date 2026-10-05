// The nightly Cleaning check (mockup ai, server/src/soiling.ts soilingNightly) on PGlite: Tesla's daily kWh, a logged cleaning, the weather
// in kv (no network), and the `panel` alert: once per dusty spell, none while 5 mm of rain is forecast.
import { describe, it, expect, beforeAll } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { soilingNightly, soilingFor, type SoilWx } from '../../server/src/soiling.js';

const S = 'soil', NOW = Date.parse('2026-08-27T01:00:00-05:00'), TODAY = '2026-08-27';
const days = Array.from({ length: 26 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
// every day clear: 7 kWh/m² over 10 h, 77 °F; the array makes 49 kWh clean and 46 kWh from 8/14 on (−6%)
const kwh = (d: string) => d >= '2026-08-14' ? 46 : 49;
function wx(rainTomorrow: number): SoilWx {
  const time = days.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
  const all = [...days, TODAY, '2026-08-28'];
  return { hourly: { time, global_tilted_irradiance: time.map(t => { const h = +t.slice(11, 13); return h >= 8 && h <= 17 ? 700 : 0; }), cloud_cover: time.map(() => 5) },
    daily: { time: all, precipitation_sum: all.map(d => d === '2026-08-01' ? 20 : d === '2026-08-28' ? rainTomorrow : 0), temperature_2m_max: all.map(() => 77) } };
}
beforeAll(async () => {
  await migrate();
  // 288 five-minute buckets a day, the day's kWh spread evenly
  for (const d of days) await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, solar_wh, home_wh) SELECT $1, $2 || 'T' || lpad((i / 12)::text, 2, '0') || ':' || lpad(((i % 12) * 5)::text, 2, '0') || ':00-05:00',
    0, $2, (i / 12)::int, $3::real / 288 * 1000, 0 FROM generate_series(0, 287) i`, [S, d, kwh(d)]);
});

describe('soiling nightly', () => {
  it('SO-6 dusty with rain forecast: no alert; with none forecast: one alert, not repeated', async () => {
    const s = await soilingFor(S, NOW, wx(0));
    expect(s).toMatchObject({ state: 'dusty', lossPct: 6.1, ref: { from: '2026-08-02', to: '2026-08-04', after: 'rain' } });
    await kv.set('soiling:wx', { day: TODAY, w: wx(8) });
    expect(await soilingNightly(S, NOW)).toEqual({ state: 'dusty', lossPct: 6.1, nextRain: '2026-08-28' });
    await kv.set('soiling:wx', { day: TODAY, w: wx(0) });
    expect(await soilingNightly(S, NOW)).toMatchObject({ state: 'dusty', pushed: 0, skipped: null });   // stored; no phone subscribed in tests
    expect(await soilingNightly(S, NOW + 864e5)).toMatchObject({ skipped: 'duplicate' });
    const a = await q<{ title: string; body: string; kind: string }>(`SELECT kind, title, body FROM alerts WHERE site_id = $1`, [S]);
    expect(a).toEqual([{ kind: 'panel', title: 'Panels look dusty', body: 'About 6.1% below clean (≈ 3.0 kWh a day) after 26 days without 5 mm of rain, and none in the 5-day forecast. A rinse would bring it back.' }]);
  });
  it('SO-7 a logged cleaning resets: measuring again, no alert', async () => {
    await q(`INSERT INTO events (site_id, type, day) VALUES ($1, 'cleaned', '2026-08-25')`, [S]);
    expect(await soilingFor(S, NOW, wx(0))).toMatchObject({ state: 'measuring', resetBy: 'cleaning', resetOn: '2026-08-25', lossPct: null });
  });
});
