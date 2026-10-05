// Nightly retention (server/src/retention.ts): each table loses only the rows older than its window. Synthetic rows, PGlite.
import { describe, it, expect, beforeAll } from 'vitest';
import { q, migrate } from '../../server/src/db.js';
import { pruneOld, KEEP_DAYS } from '../../server/src/retention.js';
import { localDay, addDays } from '../../server/src/tesla/client.js';

const NOW = Date.parse('2026-10-05T15:00:00Z'), DAY = 864e5, today = localDay(new Date(NOW));
beforeAll(async () => {
  await migrate();
  for (const [age, tag] of [[KEEP_DAYS.readings + 1, 'old'], [KEEP_DAYS.readings - 1, 'new']] as const) {
    const day = addDays(today, -age), ts = NOW - age * DAY;
    await q(`INSERT INTO nest_readings (site_id, ts, day, hour, hvac) VALUES ('r', $1, $2, 12, $3)`, [ts, day, tag]);
    await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) VALUES ('r', $1, $2, 12, true, 300, 1750)`, [ts, day]);
    await q(`INSERT INTO powerwall_log (site_id, at, command, result, source) VALUES ('r', $1, 'reserve', 'sent', $2)`, [ts, tag]);
    await q(`INSERT INTO owner_sessions (id, created_at, last_seen) VALUES ($1, $2, $2)`, [`s-${tag}`, new Date(ts).toISOString()]);
  }
  for (const [age, tag] of [[KEEP_DAYS.alerts + 1, 'old'], [KEEP_DAYS.alerts - 1, 'new']] as const)
    await q(`INSERT INTO alerts (site_id, kind, title, body, data, created_at) VALUES ('r', 'grid', $1, '', '{}', $2)`, [tag, new Date(NOW - age * DAY).toISOString()]);
});

describe('retention', () => {
  it('RT-1 drops exactly the rows past each window and keeps the rest', async () => {
    expect(await pruneOld(NOW)).toEqual({ nest: 1, pool: 1, powerwallLog: 1, alerts: 1, ownerSessions: 1 });
    expect((await q(`SELECT hvac FROM nest_readings WHERE site_id = 'r'`)).map((r: any) => r.hvac)).toEqual(['new']);
    expect((await q(`SELECT title FROM alerts WHERE site_id = 'r'`)).map((r: any) => r.title)).toEqual(['new']);
    expect((await q(`SELECT id FROM owner_sessions WHERE id LIKE 's-%'`)).map((r: any) => r.id)).toEqual(['s-new']);
    expect(await pruneOld(NOW)).toEqual({ nest: 0, pool: 0, powerwallLog: 0, alerts: 0, ownerSessions: 0 });   // idempotent
  });
});
