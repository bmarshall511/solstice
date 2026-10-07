// "Away until…" times (web/src/lib/presence.js, approved mockup mockups/t-enhancements.html frame 4).
import { describe, it, expect } from 'vitest';
import { chicagoEpoch, presets, untilLabel, awayButton, awayLines, when, pickedEpoch } from '../../web/src/lib/presence.js';

const now = Date.parse('2026-09-28T14:20:00Z');   // Mon 9:20 AM in Chicago (CDT, UTC−5)

describe('away until', () => {
  it('reads Chicago wall-clock times on both sides of DST', () => {
    expect(chicagoEpoch('2026-09-28', 18)).toBe(Date.parse('2026-09-28T23:00:00Z'));
    expect(chicagoEpoch('2026-12-01', 7)).toBe(Date.parse('2026-12-01T13:00:00Z'));
    expect(pickedEpoch('2026-09-30T15:30')).toBe(Date.parse('2026-09-30T20:30:00Z'));
    expect(pickedEpoch('')).toBeNull();
  });
  it('offers Tonight 6 PM and Tomorrow morning 7 AM, and drops Tonight after 5:45 PM', () => {
    expect(presets(now).map(p => [p.id, p.sub])).toEqual([['open', 'no return time · tap Home when you are'], ['tonight', '6:00 PM today'], ['morning', '7:00 AM Tuesday']]);
    expect(presets(Date.parse('2026-09-28T23:00:00Z')).map(p => p.id)).toEqual(['open', 'morning']);
  });
  it('keeps the old indefinite Away as "Until I’m back" (no until)', () => {
    const open = presets(now)[0];
    expect(open).toMatchObject({ id: 'open', at: null, title: 'Until I’m back' });
    const ac = { mode: 'auto', awayF: 82, band: { homeLo: 74, homeHi: 78, nightLo: 72, nightHi: 75 }, maxStepF: 2 };
    expect(awayLines(null, now, ac, { mode: 'auto' })).toEqual({ ac: 'Will hold 82° until you mark Home, then go back to your 74–78° comfort band, at most 2° per step.', pool: 'No change. The pump plan doesn’t depend on who is home.' });
    expect(awayLines(null, now, { ...ac, mode: 'suggest' }, { mode: 'auto' }).ac).toMatch(/^Suggests holding 82° until you mark Home/);
  });
  it('labels the button and the control as the mockup does', () => {
    expect(untilLabel(chicagoEpoch('2026-09-28', 18), now)).toBe('6:00 PM');
    expect(untilLabel(chicagoEpoch('2026-09-29', 7), now)).toBe('7:00 AM Tue');
    expect(untilLabel(chicagoEpoch('2026-09-30', 15, 30), now)).toBe('Wed 3:30 PM');
    expect(awayButton(chicagoEpoch('2026-09-28', 18), now)).toBe('Away until 6 PM');
    expect(when(Date.parse('2026-09-28T14:12:00Z'), now)).toBe('9:12 AM');
  });
  it('says what each Autopilot will do, by mode', () => {
    const ac = { mode: 'auto', awayF: 82, band: { homeLo: 74, homeHi: 78, nightLo: 72, nightHi: 75 }, maxStepF: 2 };
    const l = awayLines(chicagoEpoch('2026-09-28', 18), now, ac, { mode: 'auto' });
    expect(l.ac).toBe('Will hold 82° until 6:00 PM, then go back to your 74–78° comfort band, at most 2° per step.');
    expect(l.pool).toBe('No change. The pump plan doesn’t depend on who is home.');
    expect(awayLines(chicagoEpoch('2026-09-29', 7), now, ac, { mode: 'suggest' }).ac).toMatch(/tonight instead of the 72–75° night band/);
    expect(awayLines(chicagoEpoch('2026-09-29', 7), now, ac, { mode: 'suggest' }).pool).toMatch(/tomorrow’s plan is still suggested at 8:15 PM/);
    expect(awayLines(chicagoEpoch('2026-09-28', 18), now, { ...ac, mode: 'suggest' }, { mode: 'auto' }).ac).toMatch(/^Suggests holding 82°/);
    expect(awayLines(chicagoEpoch('2026-09-28', 18), now, { ...ac, mode: 'off' }, { mode: 'auto' }).ac).toMatch(/no Nest writes/);
  });
  it('names the evening run time of the day it is about, not of the day the test runs (7:15 PM once CST starts Nov 1)', () => {
    const ac = { mode: 'auto', awayF: 82, band: { homeLo: 74, homeHi: 78, nightLo: 72, nightHi: 75 }, maxStepF: 2 };
    const nov = Date.parse('2026-11-09T15:20:00Z');   // Mon 9:20 AM CST
    expect(awayLines(chicagoEpoch('2026-11-10', 7), nov, ac, { mode: 'suggest' }).pool).toMatch(/still suggested at 7:15 PM as usual/);
    expect(awayLines(chicagoEpoch('2026-09-29', 7), now, ac, { mode: 'suggest' }).pool).toMatch(/still suggested at 8:15 PM as usual/);
    // Oct 31 is still CDT: its 01:15 UTC run (Nov 1, UTC) is 8:15 PM; the next evening's is 7:15 PM
    expect(awayLines(chicagoEpoch('2026-11-01', 7), Date.parse('2026-10-31T15:00:00Z'), ac, { mode: 'auto' }).pool).toMatch(/at 8:15 PM/);
    expect(awayLines(chicagoEpoch('2026-11-02', 7), Date.parse('2026-11-01T15:00:00Z'), ac, { mode: 'auto' }).pool).toMatch(/at 7:15 PM/);
  });
});
