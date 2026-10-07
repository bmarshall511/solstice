// The pool water log on PGlite (mockup aj): log a test with the controller's water temperature, read the card, delete, and the
// "time to test" reminder: none before the first test, one when due (4 days warm), not repeated for the same test.
import { describe, it, expect, beforeAll } from 'vitest';
import { q, migrate } from '../../server/src/db.js';
import { addTest, deleteTest, poolWater, poolTestReminder } from '../../server/src/appliances/poolTests.js';

const S = 'pw', D = (day: string, hm = '18:00') => Date.parse(`${day}T${hm}:00-05:00`);
beforeAll(async () => {
  await migrate();
  // the controller's last reading: 84° water, and the pump running 10:00–19:00 every day
  const rows: Array<[number, string, number, boolean, number]> = [];
  for (let i = 0; i < 6; i++) { const day = `2026-09-${String(20 + i).padStart(2, '0')}`; for (let h = 10; h < 19; h++) for (const m of [5, 20, 35, 50]) rows.push([D(day, `${h}:${String(m).padStart(2, '0')}`), day, h, true, 84]); }
  for (const [ts, day, h, run, t] of rows) await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm, water_temp) VALUES ($1, $2, $3, $4, $5, 300, 1500, $6)`, [S, ts, day, h, run, t]);
});

describe('pool water log (PGlite)', () => {
  it('PW-1 no test yet: no reminder; a logged test carries the water temperature; the card shows it in range', async () => {
    expect(await poolTestReminder(S, D('2026-09-25'))).toEqual({ skipped: 'no test yet' });
    const t = await addTest(S, { fc: 3, ph: 7.6, cya: 40, clarity: 'clear', added: ['tablets'], source: 'kit' }, D('2026-09-20', '17:40'));
    expect(t).toMatchObject({ day: '2026-09-20', fc: 3, ph: 7.6, cya: 40, ta: null, waterF: 84, added: ['tablets'], source: 'kit' });
    const w = await poolWater(S, D('2026-09-21'));
    expect([w.last?.id, w.status, w.fcMin, w.dueDays, w.overdue, w.waterF]).toEqual([t.id, { fc: 'ok', ph: 'ok', cc: null, ta: null, cya: 'ok', ch: null }, 3, 4, false, 84]);
    expect(w.pumpHours['2026-09-20']).toBe(9);   // 36 running quarter-hours
  });
  it('PW-2 due after 4 days in 84° water: one push, not again for the same test; a new test clears it', async () => {
    expect(await poolTestReminder(S, D('2026-09-23'))).toMatchObject({ due: expect.any(Number) });
    expect(await poolTestReminder(S, D('2026-09-25'))).toMatchObject({ pushed: 0, skipped: null });   // stored; no phone subscribed in tests
    expect(await poolTestReminder(S, D('2026-09-26'))).toMatchObject({ skipped: 'duplicate' });
    const a = await q<{ kind: string; title: string; body: string }>(`SELECT kind, title, body FROM alerts WHERE site_id = $1`, [S]);
    expect(a).toEqual([{ kind: 'poolTest', title: 'Time to test the pool', body: 'Last test 5 days ago. Water is 84° and the pump ran 9 h a day since.' }]);
    const t2 = await addTest(S, { fc: 2, ph: 7.7, clarity: 'hazy' }, D('2026-09-26', '09:00'));
    expect((await poolWater(S, D('2026-09-26', '10:00'))).overdue).toBe(false);
    await deleteTest(S, t2.id);
    expect((await poolWater(S, D('2026-09-26', '10:00'))).last?.fc).toBe(3);
  });
  it('PW-3 pump hours leave out isRunning reads at 0 RPM / 0 W (the IntelliFlo at night, seen 2026-10-07)', async () => {
    const Z = 'pw0', day = '2026-09-22';
    for (let h = 0; h < 24; h++) for (const m of ['05', 20, 35, 50]) {
      const on = h >= 10 && h < 19;   // 10:00–19:00 at 1500 RPM; every other read says running at 0 RPM / 0 W
      await q(`INSERT INTO pool_readings (site_id, ts, day, hour, running, watts, rpm) VALUES ($1, $2, $3, $4, true, $5, $6)`, [Z, D(day, `${String(h).padStart(2, '0')}:${m}`), day, h, on ? 300 : 0, on ? 1500 : 0]);
    }
    expect((await poolWater(Z, D('2026-09-23'))).pumpHours[day]).toBe(9);   // not 24
  });
});
