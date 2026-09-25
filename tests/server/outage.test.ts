// Outage readiness (server/src/outage.ts): the "If it kept drawing" ladder, the island simulation and the storm flag.
// The worked numbers are the approved mockup's (mockups/n-outage.html) and the design's HUD line
// (docs/audit-designs/visualizations.md §6): "9 h 40 m at 2.4 kW · sun tomorrow adds ~6 h". Everything here is synthetic.
import { describe, it, expect } from 'vitest';
import { usableKwh, ladder, simulateIsland, scenarioLoads, solarByHour, poolKwByHour, acDuty, stormState, type NwsAlert } from '../../server/src/outage.js';
import { powerModel } from '../../server/src/appliances/pool.js';

/** A hot September day's typical home load by hour (kW), about 78 kWh; 9 PM draws 2.4 kW (the mockup's PROFILE). */
const PROFILE = [1.95, 1.9, 1.85, 1.8, 1.75, 1.75, 2.05, 2.5, 3.2, 3.6, 4.0, 4.2, 4.4, 4.6, 4.9, 5.1, 5.0, 4.9, 4.7, 4.1, 3.1, 2.4, 2.2, 2.0];
/** The mockup's pool plan (10a–7p at 1,500 RPM ≈ 0.153 kW, 2p–3p boost ≈ 0.8 kW) by hour. */
const POOL = Array.from({ length: 24 }, (_, h) => h === 14 ? .8 : h >= 10 && h < 19 ? .153 : 0);
/** A day's array output (kW for the hour starting at h) that sums to `kwh` (the mockup's solarDay). */
const solarDay = (kwh: number) => { const w = Array.from({ length: 24 }, (_, h) => Math.max(0, Math.sin(Math.PI * (h + .5 - 7.3) / 12.2)) ** 1.7), s = w.reduce((a, b) => a + b, 0); return w.map(x => x / s * kwh); };
/** 48 hours from 9 PM tonight: tonight is dark, then tomorrow and the day after. */
const solarFrom9pm = (tomorrow: number, dayAfter: number) => [...Array(24).fill(0), ...solarDay(tomorrow), ...solarDay(dayAfter)].slice(21, 69);
const fmtHM = (h: number) => { let H = Math.floor(h), M = Math.round((h - H) * 60); if (M === 60) { H++; M = 0; } return M ? `${H} h ${M} m` : `${H} h`; };

const PW = { capKwh: 27, maxKw: 10 };                         // 2 × Powerwall 2: 27 kWh, 5 kW continuous each
const loads = { startHour: 21, profile: PROFILE, drawKw: 2.4, alwaysOnKw: .6, acAvgKw: 2.0 * .7, poolKwByHour: POOL };

describe('usable energy', () => {
  it('is charge × 27 kWh × 95%', () => {
    expect(usableKwh(74, 27)).toBeCloseTo(18.981, 3);
    expect(usableKwh(100, 27)).toBeCloseTo(25.65, 3);
    expect(usableKwh(-5, 27)).toBe(0);
  });
});

describe('the "If it kept drawing" ladder', () => {
  const rungs = ladder({ usableKwh: usableKwh(74, 27), alwaysOnKw: .6, poolKw: .15, acKw: 2.0, duty: .7, drawKw: 2.4 });
  it('stacks always-on, the pump, AC × duty and everything else up to the current draw', () => {
    expect(rungs.map(r => r.id)).toEqual(['on', 'pool', 'ac', 'else']);
    expect(rungs.map(r => r.label)).toEqual(['Always-on', '+ Pool pump', '+ AC', '+ Everything else']);
    expect(rungs.map(r => r.kw)).toEqual([.6, .75, 2.15, 2.4]);
    expect(rungs.map(r => r.addKw)).toEqual([.6, .15, 1.4, .25]);
  });
  it('divides usable kWh by each rung\'s steady draw', () => {
    expect(rungs.map(r => r.hours)).toEqual([31.635, 25.308, 8.828, 7.909]);
    expect(rungs.map(r => fmtHM(r.hours!))).toEqual(['31 h 38 m', '25 h 18 m', '8 h 50 m', '7 h 55 m']);
  });
  it('never puts "everything else" below the rung above it', () => {
    const low = ladder({ usableKwh: 10, alwaysOnKw: .6, poolKw: .15, acKw: 2, duty: .7, drawKw: 1 });
    expect(low[3]).toEqual({ id: 'else', label: '+ Everything else', addKw: 0, kw: 2.15, hours: 4.651 });
  });
  it('clamps the duty and reports no end for a zero draw', () => {
    expect(ladder({ usableKwh: 10, alwaysOnKw: 0, poolKw: 0, acKw: 2, duty: 1.5, drawKw: 0 }).map(r => r.hours)).toEqual([null, null, 5, 5]);
  });
});

describe('simulateIsland against the design\'s worked numbers', () => {
  const solar = solarFrom9pm(41, 38);
  it('builds the mockup\'s hourly loads from 9 PM', () => {
    const asis = scenarioLoads(loads, 'asis'), noac = scenarioLoads(loads, 'noac'), both = scenarioLoads(loads, 'noacpool');
    expect(asis).toHaveLength(48);
    expect(asis.slice(0, 4)).toEqual([2.4, 2.2, 2.0, 1.95]);
    expect(noac[0]).toBeCloseTo(1.0, 9);                          // 2.4 − 2.0 × 70%
    expect(noac[4]).toBeCloseTo(.6, 9);                           // 1.8 − 1.4 = 0.4, held at always-on
    expect(both[17] - noac[17]).toBeCloseTo(-.8, 9);              // 2 PM tomorrow: the boost hour comes off too
  });
  it('As is at 74%: 9 h 40 m at 2.4 kW, and tomorrow\'s 41 kWh of sun adds ~6 h', () => {
    const m = simulateIsland({ soc0: 74, ...PW, solarKw: solar, loadKw: scenarioLoads(loads, 'asis') });
    expect(m.emptyH).toBeCloseTo(9.6737, 4);
    expect(fmtHM(m.emptyH!)).toBe('9 h 40 m');
    expect(m.sunAdds).toBe(6);
    expect(m.minSoc).toBe(0);
    expect(m.points).toHaveLength(48);
    expect(m.points[0]).toMatchObject({ k: 0, s: 0, h: 2.4, b: 2.4, u: 0 });
    expect(m.points[0].soc).toBeCloseTo(.74 - 2.4 / .95 / 27, 9);
  });
  it('Without AC (and pool) the Powerwalls last the night and the sun refills them', () => {
    const noac = simulateIsland({ soc0: 74, ...PW, solarKw: solar, loadKw: scenarioLoads(loads, 'noac') });
    const both = simulateIsland({ soc0: 74, ...PW, solarKw: solar, loadKw: scenarioLoads(loads, 'noacpool') });
    expect([noac.emptyH, noac.unmetKwh, noac.sunAdds]).toEqual([null, 0, 0]);
    expect(noac.minSoc).toBeCloseTo(.173, 3);
    expect(both.emptyH).toBeNull();
    expect(both.minSoc).toBeCloseTo(.246, 3);
  });
  it('the storm variant: 100% before a cloudy 16 kWh day runs dry after about 12 h and the sun adds nothing', () => {
    const m = simulateIsland({ soc0: 100, ...PW, solarKw: solarFrom9pm(16, 30), loadKw: scenarioLoads(loads, 'asis') });
    expect(m.emptyH).toBeCloseTo(12.2341, 4);
    expect(fmtHM(m.emptyH!)).toBe('12 h 14 m');
    expect(m.sunAdds).toBe(0);
  });
  it('conserves energy: the Powerwalls deliver no more than they held plus what the sun put in', () => {
    const m = simulateIsland({ soc0: 74, ...PW, solarKw: solar, loadKw: scenarioLoads(loads, 'asis') });
    const out = m.points.reduce((a, p) => a + Math.max(0, p.b), 0), charged = m.points.reduce((a, p) => a + Math.max(0, -p.b), 0);
    expect(out).toBeCloseTo(usableKwh(74, 27) + charged * .95 * .95 - m.points[47].soc * 27 * .95, 6);
  });
  it('a load above 10 kW goes unmet without calling the Powerwalls empty', () => {
    const m = simulateIsland({ soc0: 100, ...PW, hours: 2, solarKw: [0, 0], loadKw: [12, 12] });
    expect(m.points[0].b).toBe(10);
    expect(m.unmetKwh).toBeCloseTo(4, 9);
    expect(m.emptyH).toBeNull();
  });
});

describe('inputs to the simulation', () => {
  it('forecast sun: the hour from h to h+1 is the value stamped h+1, and 11 PM reads the next day\'s midnight', () => {
    const day = solarDay(41), stamp = (d: string, hourEnding: number) => d === '2026-09-26' && hourEnding > 0 ? day[hourEnding - 1] : 0;
    const got = solarByHour({ startDate: '2026-09-25', startHour: 21.5, yieldK: 1, sunAt: stamp });
    expect(got.slice(0, 27)).toEqual([0, 0, 0, ...day]);
    const seen: string[] = [];
    solarByHour({ startDate: '2026-09-25', startHour: 23, yieldK: 2, sunAt: (d, h) => { seen.push(`${d} ${h}`); return 0; } });
    expect(seen.slice(0, 2)).toEqual(['2026-09-26 0', '2026-09-26 1']);
  });
  it('pool: the applied plan (10a–7p at 1,500 RPM, 2p–3p at 2,400) by hour from the pump model', () => {
    const W = powerModel([]), hourly = poolKwByHour([{ circuitId: 6, start: 600, stop: 1140 }, { circuitId: 8, start: 840, stop: 900 }], new Map([[6, 1500], [8, 2400]]), W);
    expect(hourly[9]).toBe(0);
    expect(hourly[10]).toBeCloseTo(W(1500) / 1000, 9);
    expect(hourly[14]).toBeCloseTo(W(2400) / 1000, 9);
    expect(hourly[19]).toBe(0);
  });
  it('AC duty: measured Nest duty first, 60% on a 90°F+ day, else the heat model', () => {
    expect(acDuty({ measuredPct: 70, high: 99, slope: 2.5, acKw: 2 })).toEqual({ duty: .7, source: 'nest' });
    expect(acDuty({ measuredPct: 0, high: 99, slope: 2.5, acKw: 2 })).toEqual({ duty: 0, source: 'nest' });
    expect(acDuty({ measuredPct: null, high: 94, slope: 2.5, acKw: 2 })).toEqual({ duty: .6, source: 'estimated' });
    expect(acDuty({ measuredPct: null, high: 86, slope: 2.5, acKw: 2 }).duty).toBeCloseTo(6 * 2.5 / 24 / 2, 9);
    expect(acDuty({ measuredPct: null, high: 72, slope: 2.5, acKw: 2 }).duty).toBe(0);
  });
});

describe('the storm flag', () => {
  const alert: NwsAlert = { event: 'Severe Thunderstorm Warning', headline: null, severity: 'Severe', ends: null };
  const ercot = { condition: 'normal', title: null, eea: 0, at: null };
  it('is off on a clear night, even with Storm Watch switched on', () => {
    expect(stormState({ stormWatchEnabled: true, stormActive: false, nws: [], ercot }).active).toBe(false);
    expect(stormState({ stormWatchEnabled: false, stormActive: false, nws: [], ercot: null }).active).toBe(false);
  });
  it('turns on while Storm Watch is active', () => {
    const s = stormState({ stormWatchEnabled: true, stormActive: true, nws: [], ercot });
    expect(s.active).toBe(true);
    expect(s.stormWatch).toEqual({ enabled: true, active: true });
  });
  it('turns on for an NWS alert', () => {
    const s = stormState({ stormWatchEnabled: true, stormActive: false, nws: [alert], ercot });
    expect(s.active).toBe(true);
    expect(s.nws[0].event).toBe('Severe Thunderstorm Warning');
  });
  it('an ERCOT emergency alone does not', () => {
    expect(stormState({ stormWatchEnabled: null, stormActive: false, nws: [], ercot: { condition: 'eea1', title: 'Energy Emergency', eea: 1, at: null } }).active).toBe(false);
  });
});
