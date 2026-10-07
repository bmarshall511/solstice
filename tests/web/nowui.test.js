// Now and its sheets (web/src/lib/nowui.js; approved mockup mockups/al-ia.html v2). Pure, in the site's time zone.
import { describe, it, expect } from 'vitest';
import { statusPill, spanText, nwsIsWarning, vacationPill, pickBanner, BANNER_ORDER, holdProgress, sumUntil, tileDelta, sparkPaths,
  dialPoint, arcPath, dialFrac, toFrac, fromFrac, snapRpm, snapDeg, thermoTone, pumpPresets, nowPct, scheduleBlocks, acBlocks, hourBlocks,
  chargeBlocks, tripStrip, tripIn, hubFigure, rulesPill, poolSpeedStage, circuitStage, autopilotStage, acStage, barHeights, peakToday } from '../../web/src/lib/nowui.js';

const at = s => Date.parse(s);
const NOW = at('2026-10-07T09:42:00-05:00');

describe('Status pill', () => {
  it('is green with nothing to report', () => {
    expect(statusPill({ readingAt: NOW - 31_000, nws: [], ercot: { condition: 'normal' }, now: NOW })).toEqual({ level: 'ok', text: 'All clear', small: '' });
  });
  it('is red for an outage, with how long', () => {
    expect(statusPill({ outage: true, outageSince: NOW - 72 * 60_000, nws: [{ event: 'Heat Advisory' }], now: NOW })).toEqual({ level: 'alert', text: 'Outage', small: '· 1 h 12 m' });
  });
  it('is red for a warning-level NWS alert, amber for an advisory', () => {
    expect(statusPill({ nws: [{ event: 'Heat Advisory' }, { event: 'Tornado Warning' }], now: NOW })).toMatchObject({ level: 'alert', text: 'Tornado Warning' });
    expect(statusPill({ nws: [{ event: 'Heat Advisory', severity: 'Moderate' }], now: NOW })).toMatchObject({ level: 'warn', text: 'Heat Advisory' });
    expect(nwsIsWarning({ event: 'Wind Advisory', severity: 'Extreme' })).toBe(true);
    expect(nwsIsWarning({ event: 'Flood Watch', severity: 'Severe' })).toBe(false);
  });
  it('takes the worst amber condition first', () => {
    const base = { readingAt: NOW - 10 * 60_000, ercot: { condition: 'conservation', title: 'Conservation appeal' }, stormActive: true, now: NOW };
    expect(statusPill({ ...base, offline: true })).toMatchObject({ level: 'warn', text: 'Can’t reach Solstice' });
    expect(statusPill(base)).toEqual({ level: 'warn', text: 'ERCOT', small: '· Conservation appeal' });
    expect(statusPill({ ...base, ercot: null })).toMatchObject({ text: 'Storm Watch active' });
    expect(statusPill({ ...base, ercot: null, stormActive: false })).toEqual({ level: 'warn', text: 'Last reading', small: '· 10 min ago' });
  });
  it('a reading under 3 minutes old is fresh', () => {
    expect(statusPill({ readingAt: NOW - 179_000, now: NOW }).level).toBe('ok');
    expect(statusPill({ readingAt: NOW - 180_000, now: NOW }).level).toBe('warn');
  });
  it('spans', () => { expect([spanText(45 * 60_000), spanText(120 * 60_000), spanText(51 * 3600_000)]).toEqual(['45 m', '2 h', '2 d 3 h']); });
});

describe('Vacation pill', () => {
  const trip = { leaveAt: at('2026-10-09T10:25:00-05:00'), backAt: at('2026-10-12T15:00:00-05:00') };
  it('idle, planned, running, Away until…', () => {
    expect(vacationPill({ now: NOW })).toEqual({ state: 'idle', text: 'Plan a trip', small: '' });
    expect(vacationPill({ trip, phase: 'planned', now: NOW })).toEqual({ state: 'planned', text: 'Fri Oct 9', small: '· 10:25 AM' });
    expect(vacationPill({ trip, phase: 'active', now: at('2026-10-10T12:00:00-05:00') })).toEqual({ state: 'away', text: 'Away', small: '· back Mon' });
    expect(vacationPill({ trip, phase: 'active', now: at('2026-10-12T09:00:00-05:00') }).small).toBe('· back 3:00 PM');
    expect(vacationPill({ presence: { state: 'away', source: 'manual', until: at('2026-10-07T18:00:00-05:00') }, now: NOW }).small).toBe('· until 6:00 PM');
    expect(vacationPill({ presence: { state: 'away', source: 'nest' }, now: NOW }).state).toBe('idle');
  });
});

describe('Banner slot', () => {
  it('shows one banner, by priority', () => {
    expect(BANNER_ORDER).toEqual(['outage', 'vacation', 'hold', 'pool', 'powerwall', 'bill', 'digest']);
    expect(pickBanner([{ kind: 'digest' }, { kind: 'bill' }, null, { kind: 'hold' }])).toEqual({ kind: 'hold' });
    expect(pickBanner([{ kind: 'digest' }, { kind: 'outage' }, { kind: 'vacation' }])).toEqual({ kind: 'outage' });
    expect(pickBanner([{ kind: 'powerwall' }, { kind: 'pool' }])).toEqual({ kind: 'pool' });
    expect(pickBanner([])).toBeNull();
  });
  it('a hold’s ring', () => {
    expect(holdProgress({ at: NOW - 58 * 60_000, until: NOW + 42 * 60_000 }, NOW)).toEqual({ pct: 58, until: NOW + 42 * 60_000 });
    expect(holdProgress({ at: NOW, until: NOW + 100 * 60_000 }, NOW).pct).toBe(2);
    expect(holdProgress({ at: NOW - 2, until: NOW - 1 }, NOW)).toBeNull();
  });
});

describe('Today tiles', () => {
  const day = { bucketMinutes: 60, buckets: [{ t: 7, solar: 1, home: 2, grid: 1 }, { t: 8, solar: 2, home: 1, grid: -1 }, { t: 9, solar: 4, home: 2, grid: -2 }] };
  it('sums yesterday up to the same time, the bucket holding it in part', () => {
    expect(sumUntil(day, 9.5)).toEqual({ solar: 5, home: 4, import: 1, export: 2 });
    expect(sumUntil(day, 7)).toEqual({ solar: 0, home: 0, import: 0, export: 0 });
    expect(sumUntil({ buckets: [] }, 9)).toBeNull();
  });
  it('five-minute buckets are a twelfth of an hour', () => {
    expect(sumUntil({ buckets: [{ t: 10, solar: 6, home: 0, grid: 0 }] }, 11).solar).toBeCloseTo(.5);
  });
  it('deltas: green is better, orange worse, under 0.05 kWh the same', () => {
    expect(tileDelta(1.0, .8, 'up')).toEqual({ t: 'good', text: '▲ 0.2 kWh' });
    expect(tileDelta(14.8, 15.1, 'down')).toEqual({ t: 'good', text: '▼ 0.3 kWh' });
    expect(tileDelta(12.1, 11.7, 'down')).toEqual({ t: 'bad', text: '▲ 0.4 kWh' });
    expect(tileDelta(0, .02, 'up')).toEqual({ t: 'flat', text: '— same' });
    expect(tileDelta(3, null)).toBeNull();
  });
  it('sparkline paths span the box; a flat week sits in the middle', () => {
    const p = sparkPaths([1, 3, 2, 5, 4, 2, 3]);
    expect(p.line.startsWith('M0.0 ')).toBe(true);
    expect(p.line).toContain(' 100.0 ');
    expect(p.area.endsWith('L100 30 L0 30 Z')).toBe(true);
    expect(p.line).toContain('5.0');   // the highest day touches the top padding
    expect(sparkPaths([2, 2, 2]).line).toBe('M0.0 15.0 C25.0 15.0 25.0 15.0 50.0 15.0 C75.0 15.0 75.0 15.0 100.0 15.0');
    expect(sparkPaths([1])).toBeNull();
  });
});

describe('Dials', () => {
  it('the arc runs 240° from bottom-left over the top (the mockup’s geometry)', () => {
    expect(dialPoint(0).map(v => +v.toFixed(1))).toEqual([43.4, 172]);
    expect(dialPoint(1).map(v => +v.toFixed(1))).toEqual([216.6, 172]);
    expect(dialPoint(toFrac(1750, 450, 3450)).map(v => +v.toFixed(1))).toEqual([102.4, 25.9]);
    expect(arcPath(0, toFrac(1750, 450, 3450))).toBe('M43.4 172.0 A100 100 0 0 1 102.4 25.9');
    expect(arcPath(0, 1)).toBe('M43.4 172.0 A100 100 0 1 1 216.6 172.0');
  });
  it('a pointer maps back to the fraction; the gap at the bottom snaps to the nearer end', () => {
    const [x, y] = dialPoint(.4); expect(dialFrac(x, y)).toBeCloseTo(.4, 5);
    expect(dialFrac(130, 0)).toBeCloseTo(.5, 5);
    expect(dialFrac(110, 190)).toBe(0); expect(dialFrac(150, 190)).toBe(1);
    expect(fromFrac(.5, 65, 85)).toBe(75);
  });
  it('the pump snaps to a preset within 75 rpm, else to 50, inside the limits', () => {
    const P = pumpPresets(null);
    expect(snapRpm(2350, P)).toBe(2400); expect(snapRpm(2140, P)).toBe(2150); expect(snapRpm(3600, P)).toBe(3450); expect(snapRpm(300, P)).toBe(450);
    expect(snapRpm(1700, P, { min: 600, max: 3000 })).toBe(1750);
  });
  it('the thermostat snaps per degree and colours by distance', () => {
    expect([snapDeg(76.4), snapDeg(90), snapDeg(60)]).toEqual([76, 85, 65]);
    expect([thermoTone(76.5, 76), thermoTone(79, 76), thermoTone(81, 76)]).toEqual(['c-near', 'c-far', 'c-hot']);
  });
  it('presets read the controller’s Pool and High Speed speeds where it has them', () => {
    expect(pumpPresets(null).map(p => [p.name, p.rpm, p.src])).toEqual([['Quiet', 1500, 'default'], ['Filter', 1750, 'default'], ['Skim', 2400, 'default'], ['Max', 3000, 'default']]);
    const pool = { settings: { poolCircuit: 6, boostCircuit: 8 }, snapshot: { pump: { circuits: [{ circuitId: 6, speed: 1500 }, { circuitId: 8, speed: 2400 }] } } };
    expect(pumpPresets(pool).slice(1, 3).map(p => [p.rpm, p.src])).toEqual([[1500, 'controller'], [2400, 'controller']]);
  });
});

describe('Hub plan strips', () => {
  it('pool schedules: the plan dimmed, the skim in the alternate colour, a wrap split at midnight', () => {
    expect(nowPct(9.7)).toBe(40.4);
    expect(scheduleBlocks([{ circuitId: 8, start: 840, stop: 900 }, { circuitId: 6, start: 420, stop: 1200 }])).toEqual([
      { left: 29.2, width: 54.2, cls: 'lo' }, { left: 58.3, width: 4.2, cls: 'alt' }]);
    expect(scheduleBlocks([{ circuitId: 6, start: 1320, stop: 120 }])).toEqual([{ left: 91.7, width: 8.3, cls: 'lo' }, { left: 0, width: 8.3, cls: 'lo' }]);
  });
  it('AC: night dimmed, a tick per write', () => {
    const r = acBlocks([{ hour: 0 }, { hour: 7 }, { hour: 21 }, { hour: 22 }], 22, 7);
    expect(r.blocks).toEqual([{ left: 0, width: 29.2, cls: 'lo' }, { left: 29.2, width: 62.5, cls: '' }, { left: 91.7, width: 8.3, cls: 'lo' }]);
    expect(r.ticks).toEqual([29.2, 87.5, 91.7]);
  });
  it('hours → blocks; Powerwall charging measured then forecast', () => {
    const h = Array(24).fill(false); h[9] = h[10] = h[11] = true; h[15] = true;
    expect(hourBlocks(h, 'est')).toEqual([{ left: 37.5, width: 12.5, cls: 'est' }, { left: 62.5, width: 4.2, cls: 'est' }]);
    const day = { bucketMinutes: 60, buckets: [{ t: 8, battery: -1 }, { t: 9, battery: .5 }] };
    const pts = [{ t: '2026-10-07T09:00', soc: .2 }, { t: '2026-10-07T10:00', soc: .3 }, { t: '2026-10-07T11:00', soc: .4 }, { t: '2026-10-07T12:00', soc: .4 }];
    expect(chargeBlocks(day, pts, 9.7, '2026-10-07')).toEqual([{ left: 33.3, width: 4.2, cls: '' }, { left: 41.7, width: 8.3, cls: 'est' }]);
  });
  it('the Away row: six days from today with the trip (the mockup’s Fri 10:25 AM → Mon 3 PM)', () => {
    const s = tripStrip(at('2026-10-09T10:25:00-05:00'), at('2026-10-12T15:00:00-05:00'), NOW);
    expect(s).toEqual({ now: 6.7, block: { left: 40.6, width: 53.2 }, labels: ['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon'] });
    expect(tripStrip(null, null, NOW).block).toBeNull();
    expect(tripIn({ leaveAt: at('2026-10-09T10:25:00-05:00') }, 'planned', NOW)).toBe('in 2 d');
    expect(tripIn({ leaveAt: 0, backAt: NOW + 5 * 3600_000 }, 'active', NOW)).toBe('back in 5 h');
  });
  it('the hub figure and the Powerwall rules’ pill', () => {
    expect(hubFigure(['auto', 'auto', 'suggest'])).toBe('2 Auto · 1 Suggest');
    expect(hubFigure(['off', null])).toBe('1 Off');
    expect([rulesPill([{ mode: 'suggest' }, { mode: 'suggest' }]), rulesPill([{ mode: 'auto' }, { mode: 'off' }]), rulesPill([{ mode: 'off' }, { mode: 'suggest' }]), rulesPill([])]).toEqual(['suggest', 'auto', 'suggest', null]);
  });
});

describe('Staged writes', () => {
  const base = { poolId: 6, boostId: 8, poolSpeed: 1750, boostSpeed: 2400, minutes: 60 };
  it('the Skim speed runs High Speed on its timer; Filter runs Pool; any other speed is saved as Pool’s first', () => {
    expect(poolSpeedStage({ ...base, rpm: 2400, poolOn: true })).toEqual({ label: 'Run 2,400 rpm · 1 h', cmds: [{ kind: 'circuit', id: 8, on: true, minutes: 60 }] });
    expect(poolSpeedStage({ ...base, rpm: 1750 })).toEqual({ label: 'Run 1,750 rpm · 1 h', cmds: [{ kind: 'circuit', id: 6, on: true, minutes: 60 }] });
    expect(poolSpeedStage({ ...base, rpm: 1750, poolOn: true })).toBeNull();   // already running there: nothing to write
    expect(poolSpeedStage({ ...base, rpm: 1500, minutes: 120 })).toEqual({ label: 'Set Pool 1,500 rpm · run 2 h', cmds: [{ kind: 'speed', id: 6, rpm: 1500 }, { kind: 'circuit', id: 6, on: true, minutes: 120 }] });
    expect(poolSpeedStage({ ...base, rpm: 3000, poolOn: true })).toEqual({ label: 'Set Pool 3,000 rpm', cmds: [{ kind: 'speed', id: 6, rpm: 3000 }] });
  });
  it('toggles, modes and the thermostat', () => {
    expect(circuitStage('Waterfall', 5, false, 30)).toEqual({ label: 'Waterfall on · 30 min', cmds: [{ kind: 'circuit', id: 5, on: true, minutes: 30 }] });
    expect(circuitStage('Pool Light', 3, true).label).toBe('Pool Light off');
    expect(autopilotStage('Pool', 'suggest')).toBe('Set Pool Autopilot to Suggest');
    expect(autopilotStage('', 'auto')).toBe('Set Autopilot to Auto');
    expect(acStage({ kind: 'cool', f: 77 })).toEqual({ label: 'Set 77°', cmd: { kind: 'cool', f: 77 } });
    expect(acStage({ kind: 'mode', mode: 'HEATCOOL' }).label).toBe('Switch to Auto');
    expect(acStage({ kind: 'fan', seconds: 3600 }).label).toBe('Run the fan 1 h');
    expect(acStage({ kind: 'fan', seconds: 0 }).label).toBe('Stop the fan');
    expect(acStage({ kind: 'eco', on: false })).toEqual({ label: 'Eco off', cmd: { kind: 'eco', on: false } });
  });
});

describe('Ahead and the Powerwall forecast', () => {
  it('bars scale to the strip’s peak (at least 4 kW)', () => {
    expect(barHeights([0, 2, 7.1])).toEqual([4, 27, 84]);
    expect(barHeights([0, 1, 2])).toEqual([4, 24, 44]);
  });
  it('the peak later today, only when above the present charge', () => {
    const pts = [{ t: '2026-10-07T10:00', soc: .3 }, { t: '2026-10-07T16:00', soc: .74 }, { t: '2026-10-08T12:00', soc: .9 }];
    expect(peakToday(pts, '2026-10-07', 20)).toEqual({ pct: 74, hour: 16 });
    expect(peakToday(pts, '2026-10-07', 80)).toBeNull();
  });
});
