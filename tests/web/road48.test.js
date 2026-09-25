// Next 48 hours road data (web/src/lib/road48data.js): the lanes come from forecast48's points, the windows from the pool and
// AC plans the app already loads, and the flags use the sentence's own formatter. Synthetic data; runs in Chicago time.
import { describe, it, expect } from 'vitest';
import { roadModel, span } from '../../web/src/lib/road48data.js';

const START = '2026-09-22T10:00';   // a Tuesday, 10 AM
const hourT = k => { const d = new Date(Date.parse(START + ':00Z') + k * 3600e3).toISOString(); return d.slice(0, 13) + ':00'; };
const T = Array.from({ length: 48 }, (_, k) => hourT(k));
// solar by hour of day, a flat 2 kW home, a charge that fills at k = 3 and bottoms out at k = 20 (Wed 6 AM)
const SUN = h => Math.max(0, 6.5 - Math.abs(h - 13) * 1.1);
const SOC = [.7, .84, .94, 1, 1, 1, 1, 1, .98, .9, .83, .76, .69, .62, .56, .5, .44, .37, .31, .25, .22, .25, .29, .35,
  ...Array.from({ length: 24 }, (_, i) => .4 + i * .01)];
const points = T.map((t, k) => { const s = SUN(+t.slice(11, 13)); return { k, t, s, h: 2, soc: SOC[k], g: k === 30 ? 1.24 : k === 4 ? -.91 : 0 }; });
const fc = { points, full: T[3], low: { soc: .22, t: T[20] }, importKwh: 1.24 };
const w = { hourly: { time: T, cloud_cover: T.map((_, k) => k === 22 ? 80 : 8), precipitation_probability: T.map((_, k) => k === 30 ? 44 : k === 32 ? 62 : 4) } };
const when = t => `W(${t})`;
const base = { fc, w, when, soc0: .573, capKwh: 27, maxKw: 10, reservePct: 20 };

const POOL = {
  linked: true, settings: { boostCircuit: 8 },
  current: { schedules: [{ circuitId: 6, start: 600, stop: 1140, rpm: 1500 }, { circuitId: 8, start: 840, stop: 900, rpm: 2400 }] },
  autopilot: { mode: 'auto', tomorrow: { date: '2026-09-23', plan: { schedules: [{ circuitId: 6, start: 540, stop: 1080, rpm: 1500 }, { circuitId: 8, start: 780, stop: 840, rpm: 2400 }] } } },
};
const AC = {
  linked: true, settings: { autopilot: 'auto' }, applied: null,
  plan: { date: '2026-09-22', precool: true, precoolFrom: 12, precoolTo: 17, coastFrom: 17, coastTo: 21 },
  week: [{ date: '2026-09-22' }, { date: '2026-09-23', precool: true, precoolFrom: 12, precoolTo: 16, coastFrom: 16, coastTo: 20 }],
};
const win = m => m.windows.map(x => [x.kind, x.day, x.a, x.b, x.plan, x.label]);

describe('span', () => {
  it('drops the first AM/PM when both ends share it', () => {
    expect([span(600, 1140), span(720, 1020), span(1080, 1260), span(0, 300), span(1320, 1440), span(570, 615)])
      .toEqual(['10 AM–7 PM', '12–5 PM', '6–9 PM', '12–5 AM', '10 PM–12 AM', '9:30–10:15 AM']);
  });
});

describe('roadModel', () => {
  it('places today’s applied pool and AC windows solid and tomorrow’s plans outlined, in hours from now', () => {
    const m = roadModel({ ...base, pool: POOL, ac: AC });
    expect(m.n).toBe(48);
    expect(win(m)).toEqual([
      ['pool', 0, 0, 9, false, 'pool · 10 AM–7 PM'], ['boost', 0, 4, 5, false, null],
      ['pool', 1, 23, 32, true, 'pool plan · 9 AM–6 PM'], ['boost', 1, 27, 28, true, null],
      ['pre', 0, 2, 7, false, 'pre-cool · 12–5 PM'], ['coast', 0, 7, 11, false, 'coast · 5–9 PM'],
      ['pre', 1, 26, 30, true, 'pre-cool plan · 12–4 PM'], ['coast', 1, 30, 34, true, 'coast plan · 4–8 PM'],
    ]);
    expect(m.day2At).toBe(14);
  });

  it('clips windows that started before now and drops ones already over', () => {
    const pool = { ...POOL, current: { schedules: [{ circuitId: 6, start: 480, stop: 720, rpm: 1500 }, { circuitId: 5, start: 0, stop: 300, rpm: 3400 }] } };
    expect(win(roadModel({ ...base, pool, ac: null })).slice(0, 1)).toEqual([['pool', 0, 0, 2, false, 'pool · 8 AM–12 PM']]);
  });

  it('Pool Autopilot off: tomorrow repeats the controller’s schedules, solid; AC in Suggest without approval: today is a plan', () => {
    const m = roadModel({ ...base, pool: { ...POOL, autopilot: { ...POOL.autopilot, mode: 'off' } }, ac: { ...AC, settings: { autopilot: 'suggest' } } });
    expect(win(m).filter(x => x[1] === 1 && x[0] === 'pool')).toEqual([['pool', 1, 24, 33, false, 'pool · 10 AM–7 PM']]);
    expect(win(m).filter(x => x[1] === 0 && x[0] === 'pre')).toEqual([['pre', 0, 2, 7, true, 'pre-cool plan · 12–5 PM']]);
  });

  it('nothing from an unlinked pool or AC, and no pre-cool on a day without one', () => {
    const m = roadModel({ ...base, pool: { ...POOL, linked: false }, ac: { ...AC, plan: { ...AC.plan, precool: false } } });
    expect(win(m)).toEqual([['pre', 1, 26, 30, true, 'pre-cool plan · 12–4 PM'], ['coast', 1, 30, 34, true, 'coast plan · 4–8 PM']]);
    expect(m.hours[0].readout).not.toContain('pool');
  });

  it('flags use the sentence’s formatter; full sits where the charge reaches 100%, lowest at the end of its hour', () => {
    const m = roadModel({ ...base, pool: POOL, ac: AC });
    expect(m.full.txt).toBe(`full by W(${T[3]})`);
    expect(m.full.x).toBeCloseTo(3 + .06 * 27 / .95 / (SUN(13) - 2), 6);
    expect(m.low).toEqual({ x: 21, soc: .22, txt: `lowest 22% · W(${T[20]})` });
    expect(m.rain).toEqual({ k: 32, txt: '☂ rain 62%' });
    expect([m.soc0, m.reserve]).toEqual([.573, .2]);
    expect(roadModel({ ...base, fc: { ...fc, full: null, low: { soc: 1, h: 0 } } }).full).toBeNull();
    expect(roadModel({ ...base, fc: { ...fc, full: null, low: { soc: 1, h: 0 } } }).low).toBeNull();
    expect(roadModel({ ...base, fc: { points: [] } })).toBeNull();
  });

  it('the HUD and the tap readout for each hour', () => {
    const m = roadModel({ ...base, pool: POOL, ac: AC });
    expect(m.hours[0].hud).toBe('Tue 10 AM · now · ← drag to drive →');
    expect(m.hours[24].hud).toBe('Wed 10 AM · +24 h');
    expect(m.hours[4].readout).toBe('<b>Tue 2 PM</b> · solar 5.4 kW · home 2.0 kW · Powerwalls 100% · export 0.9 kW · pool 2,400 rpm · pre-cool');
    expect(m.hours[30].readout).toBe('<b>Wed 4 PM</b> · solar 3.2 kW · home 2.0 kW · Powerwalls 46% · PEC 1.2 kW · pool 1,500 rpm · coast · rain 44%');
    expect(m.hours[12].readout).toBe('<b>Tue 10 PM</b> · solar 0.0 kW · home 2.0 kW · Powerwalls 69% · PEC 0 · pool off');
    expect(m.hours[40].readout).toBe('<b>Thu 2 AM</b> · solar 0.0 kW · home 2.0 kW · Powerwalls 56% · PEC 0');   // no plan for Thursday: no pool claim
    expect(m.hours.filter(x => x.midnight).length).toBe(2);
    expect([m.hours[0].night, m.hours[12].night, m.hours[21].dusk, m.hours[22].c]).toEqual([false, true, true, .8]);
  });
});
