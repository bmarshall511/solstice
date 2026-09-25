// The year ring's data (web/src/scenes/yearring.js, mockup o-year-ring): one slot per calendar day for the last 365 days,
// gaps stay empty, DST days are ordinary days, last year's ghost only where last year's row exists. Runs in Chicago time.
import { describe, it, expect } from 'vitest';
import { yearModel, yearStats, ghostRuns, yearFrac, dayOfYear, yearLen, lastYearOf, dur } from '../../web/src/scenes/yearring.js';
import { addDays } from '../../web/src/lib/util.js';

const TODAY = '2026-09-25';
const row = (date, o = {}) => ({ date, solar: 40, home: 80, import: 40, export: 5, charge: 10, discharge: 9, socMin: 20, socMax: 90, ...o });
/** Every day from `from` to `to` inclusive, minus `skip`. */
const span = (from, to, skip = [], o) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) if (!skip.includes(d)) out.push(row(d, typeof o === 'function' ? o(d) : o)); return out; };

describe('calendar positions', () => {
  it('day of year, year length and the ring fraction', () => {
    expect(dayOfYear('2026-01-01')).toBe(0);
    expect(dayOfYear('2026-12-31')).toBe(364);
    expect(dayOfYear('2028-12-31')).toBe(365);
    expect([yearLen(2026), yearLen(2028), yearLen(2100), yearLen(2000)]).toEqual([365, 366, 365, 366]);
    expect(yearFrac('2026-01-01')).toBeCloseTo(.5 / 365, 9);
    expect(yearFrac('2026-12-31')).toBeCloseTo(364.5 / 365, 9);
  });
  it('last year of a date (Feb 29 falls on Mar 1)', () => {
    expect(lastYearOf('2026-09-25')).toBe('2025-09-25');
    expect(lastYearOf('2028-02-29')).toBe('2027-03-01');
  });
});

describe('yearModel', () => {
  it('365 slots ending today, oldest first, one per calendar day', () => {
    const m = yearModel({ daily: span('2025-09-26', TODAY), today: TODAY });
    expect(m.days).toHaveLength(365);
    expect(m.days[0].date).toBe('2025-09-26');
    expect(m.days.at(-1).date).toBe(TODAY);
    expect(m.days.every((s, i) => s.i === i && (i === 0 || s.date === addDays(m.days[i - 1].date, 1)))).toBe(true);
    expect(new Set(m.days.map(s => s.date)).size).toBe(365);
  });
  it('DST days (23 h on 2026-03-08, 25 h on 2025-11-02) are one slot each, with their own totals', () => {
    const daily = span('2025-09-26', TODAY, [], d => d === '2026-03-08' ? { solar: 30, home: 70 } : d === '2025-11-02' ? { solar: 25, home: 85 } : {});
    const m = yearModel({ daily, today: TODAY });
    const spring = m.days.filter(s => s.date === '2026-03-08'), fall = m.days.filter(s => s.date === '2025-11-02');
    expect(spring).toHaveLength(1); expect(fall).toHaveLength(1);
    expect(spring[0].d).toMatchObject({ solar: 30, home: 70 });
    expect(fall[0].d).toMatchObject({ solar: 25, home: 85 });
    expect(m.days[m.days.indexOf(spring[0]) + 1].date).toBe('2026-03-09');
  });
  it('a missing day stays an empty slot (no row), never a zero', () => {
    const m = yearModel({ daily: span('2025-09-26', TODAY, ['2026-03-08', '2026-06-01']), today: TODAY });
    expect(m.days).toHaveLength(365);
    expect(m.days.find(s => s.date === '2026-03-08').d).toBeNull();
    expect(m.days.find(s => s.date === '2026-06-01').d).toBeNull();
    expect(m.days.filter(s => s.d)).toHaveLength(363);
  });
  it('outages are summed per day in minutes, only inside the window', () => {
    const outages = [{ ts: '2026-01-25T03:10:00-06:00', duration_s: 3 * 3600 + 32 * 60 }, { ts: '2026-01-25T20:00:00-06:00', duration_s: 360 },
      { ts: '2025-09-20T10:00:00-05:00', duration_s: 600 }];
    const m = yearModel({ daily: span('2025-09-26', TODAY), today: TODAY, outages });
    expect(m.days.find(s => s.date === '2026-01-25').outage).toBe(218);
    expect(m.events).toBe(2);
    expect(m.eventMin).toBe(218);
  });
});

describe("last year's ghost", () => {
  it('only where last year has a row; the 800-day history and the daily rows both count', () => {
    const history = span('2025-07-16', '2025-09-20', [], { solar: 50 });   // older rows from api.daily(800)
    const daily = span('2025-09-21', TODAY, [], { solar: 40 });
    const m = yearModel({ daily, history, today: TODAY });
    const g = m.days.filter(s => s.ghost != null);
    expect(g[0].date).toBe('2026-07-16');
    expect(g.at(-1).date).toBe(TODAY);
    expect(g).toHaveLength(72);
    expect(m.days.find(s => s.date === '2026-09-20').ghost).toBe(50);
    expect(m.days.find(s => s.date === '2026-09-21').ghost).toBe(40);
    expect(m.ghostMax).toBe(50);
  });
  it('splits into runs around missing days, so the outline never bridges a gap', () => {
    const history = span('2025-07-16', '2025-09-25', ['2025-08-01', '2025-08-02']);
    const m = yearModel({ daily: span('2025-09-26', TODAY), history, today: TODAY });
    const runs = ghostRuns(m.days);
    expect(runs.map(r => [r[0].date, r.at(-1).date])).toEqual([['2026-07-16', '2026-07-31'], ['2026-08-03', TODAY]]);
  });
});

describe('yearStats', () => {
  it('sums, share covered, full-battery days of the days with charge data, month averages and the best day', () => {
    const daily = span('2025-09-26', TODAY, ['2025-12-01'], d => ({
      solar: d === '2026-06-14' ? 61 : 40, home: d.slice(5, 7) === '07' ? 100 : 60, import: d.slice(5, 7) === '07' ? 50 : 30,
      socMax: d.slice(5, 7) === '10' ? null : d.slice(8) === '01' ? 100 : 90 }));
    const s = yearStats(yearModel({ daily, today: TODAY }));
    expect(s.present).toBe(364);                // Dec 1 is missing
    expect(s.solar).toBe(363 * 40 + 61);
    expect(s.covered).toBeCloseTo(1 - s.import / s.home, 9);
    expect(s.socDays).toBe(364 - 31);          // October has no charge data
    expect(s.full).toBe(10);                    // the 1st of each month in the window, except October (no data) and Dec 1 (missing)
    expect(s.jul).toBe(100); expect(s.dec).toBe(60);
    expect(s.best.date).toBe('2026-06-14');
  });
  it('an empty year has no numbers to show', () => {
    const s = yearStats(yearModel({ daily: [], today: TODAY }));
    expect(s).toMatchObject({ present: 0, covered: null, best: null, jul: null, dec: null, ghost: 0 });
  });
  it('durations read like the mockup', () => {
    expect(dur(6)).toBe('6 m');
    expect(dur(212)).toBe('3 h 32 m');
  });
});
