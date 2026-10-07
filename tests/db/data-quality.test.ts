// B2-12 (idea I-10) on PGlite: the nightly counts battery-% jumps that no energy explains (metric soe.jumps) and the solar buckets
// above the inverter limit (energy.inflated, kv <site>:data:inflated). Synthetic data only.
import { describe, it, expect, beforeAll } from 'vitest';
import { q, kv, migrate } from '../../server/src/db.js';
import { runLearn } from '../../server/src/learn/nightly.js';
import { localMidnight, rfc3339 } from '../../server/src/tesla/client.js';

const S = 'dq', D = '2026-03-10', NOW = Date.parse('2026-03-11T12:00:00-05:00'), B = 300_000;
beforeAll(async () => {
  await migrate();
  await q(`INSERT INTO tesla_accounts (id, user_id, access_token, refresh_token, expires_at) VALUES (1, NULL, 'a', 'r', 0)`);
  await q(`INSERT INTO sites (id, user_id, tesla_account_id, name) VALUES ($1, NULL, 1, 'Test')`, [S]);
  const t0 = localMidnight(D).getTime(), rows: Array<{ t: number; solar: number; chg: number }> = [];
  // 288 buckets: solar 500 Wh at noon (6 kW) with one bucket of 900 Wh (10.8 kW, inflated); 1,800 Wh of charge in each bucket 10:00–10:15
  for (let i = 0; i < 288; i++) { const t = t0 + i * B, h = Math.floor(i / 12); rows.push({ t, solar: i === 150 ? 900 : h >= 9 && h < 15 ? 500 : 0, chg: i >= 120 && i < 123 ? 1800 : 0 }); }
  await q(`INSERT INTO energy (site_id, ts, epoch, day, hour, solar_wh, home_wh, charge_wh, discharge_wh) SELECT $1, ts, epoch, $2, hour, s, 300, c, 0
    FROM unnest($3::text[], $4::bigint[], $5::int[], $6::real[], $7::real[]) AS x(ts, epoch, hour, s, c)`,
    [S, D, rows.map(r => rfc3339(new Date(r.t))), rows.map(r => r.t), rows.map(r => +rfc3339(new Date(r.t)).slice(11, 13)), rows.map(r => r.solar), rows.map(r => r.chg)]);
  // battery % every 15 minutes: 50, then +20 points at 10:15 (5.4 kWh went in: explained), then −30 points at 16:00 with nothing out (a glitch)
  const soe = Array.from({ length: 96 }, (_, k) => { const t = t0 + k * 3 * B, h = k / 4; return { t, v: h < 10.25 ? 50 : h < 16 ? 70 : 40 }; });
  await q(`INSERT INTO soe (site_id, ts, epoch, day, hour, soe) SELECT $1, ts, epoch, $2, hour, v FROM unnest($3::text[], $4::bigint[], $5::int[], $6::real[]) AS x(ts, epoch, hour, v)`,
    [S, D, soe.map(r => rfc3339(new Date(r.t))), soe.map(r => r.t), soe.map(r => +rfc3339(new Date(r.t)).slice(11, 13)), soe.map(r => r.v)]);
});

describe('B2-12: data-quality metrics in the nightly', () => {
  it('DQ-1 a jump the energy explains is not counted, one it doesn\'t is; the inflated bucket is counted and kept in kv', async () => {
    const r = await runLearn(S, { now: NOW });
    expect(r.steps.metrics).toEqual({ ms: expect.any(Number) });
    const m = Object.fromEntries((await q<{ metric: string; value: number }>(`SELECT metric, value FROM daily_metrics WHERE site_id = $1 AND day = $2 AND metric IN ('soe.jumps', 'energy.inflated')`, [S, D])).map(x => [x.metric, x.value]));
    expect(m).toEqual({ 'soe.jumps': 1, 'energy.inflated': 1 });
    expect(await kv.get(`${S}:data:inflated`)).toEqual({ at: NOW, total: 1, days: { [D]: 1 } });
    expect(r.waiting).toEqual(expect.arrayContaining([expect.stringMatching(/^data\.pvs_drift: Needs 14 days/), expect.stringMatching(/^data\.meter_drift: Needs 3 parsed bills/)]));
    // the jump fires its (info) anomaly
    expect(r.anomalies.opened).toContain('data.soc_jump');
  });
});
