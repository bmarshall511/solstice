// Vacation mode, the trip itself (server/src/vacation/trip.ts; mockup ak): the rules for a trip's dates, its phase at a moment, and
// which days count as trip days for the learning layer. Pure: no database, no device.
//   VT-1 a new trip's body: leave now or later (10 minutes' slack means now), within 60 days; back at least an hour after, at most 60 days
//   VT-2 a date change: the leave time only before the trip starts; the arrival time stays in the future
//   VT-3 the phase: planned → away → due (arrival time, for 2 h) → late; over once ended or cancelled
//   VT-4 trip days: a day counts with 4 h or more away, in Chicago days (a DST day included), cancelled trips never
import { describe, it, expect } from 'vitest';
import { parseTripBody, parsePatch, tripPhase, tripDaysOf, isAway, LATE_MS } from '../../server/src/vacation/trip.js';

const H = 3600_000, D = 864e5;
const NOW = Date.parse('2026-10-06T18:00:00-05:00');   // Tue 6 PM Central

describe('trip dates', () => {
  it('VT-1 a new trip: leave now or later, back at least an hour after and within 60 days', () => {
    const leave = Date.parse('2026-10-15T07:00:00-05:00'), back = Date.parse('2026-10-18T18:00:00-05:00');
    expect(parseTripBody({ leaveAt: leave, backAt: back }, NOW)).toEqual({ leaveAt: leave, backAt: back, detected: false, checklist: {}, macHome: null });
    expect(parseTripBody({ leaveAt: '2026-10-15T07:00:00-05:00', backAt: '2026-10-18T18:00:00-05:00', checklist: { waterHeater: true }, macHome: true }, NOW))
      .toMatchObject({ leaveAt: leave, backAt: back, checklist: { waterHeater: true }, macHome: true });
    expect(parseTripBody({ leaveAt: NOW - 5 * 60_000, backAt: null, detected: true }, NOW)).toEqual({ leaveAt: NOW, backAt: null, detected: true, checklist: {}, macHome: null });   // "leaving now", open-ended
    expect(parseTripBody({ backAt: NOW + 2 * D }, NOW)).toMatchObject({ leaveAt: NOW });                       // no leave time: now
    const bad = (b: unknown) => (parseTripBody(b, NOW) as { error?: string }).error;
    expect(bad({ leaveAt: NOW - 20 * 60_000, backAt: NOW + D })).toBe('leaveAt must be now or later');
    expect(bad({ leaveAt: NOW + 61 * D, backAt: NOW + 62 * D })).toBe('leaveAt must be within 60 days');
    expect(bad({ leaveAt: NOW + D, backAt: NOW + D + 30 * 60_000 })).toBe('backAt must be at least an hour after leaveAt');
    expect(bad({ leaveAt: NOW, backAt: NOW + 61 * D })).toBe('a trip is at most 60 days');
    expect(bad({ leaveAt: 'soon', backAt: NOW + D })).toBe('leaveAt must be a time (epoch ms or ISO 8601)');
    expect(bad({ leaveAt: NOW, backAt: 'later' })).toBe('backAt must be a time (epoch ms or ISO 8601)');
    expect(bad({ leaveAt: NOW, backAt: NOW + D, checklist: { stove: true } })).toBe('checklist must be an object of on/off ticks');
    expect(bad({ leaveAt: NOW, backAt: NOW + D, macHome: 'yes' })).toBe('macHome must be true or false');
    expect(bad(null)).toBe('send leaveAt and backAt');
  });

  it('VT-2 a date change: leave time only before the trip starts; the arrival time in the future', () => {
    const planned = { state: 'planned' as const, leaveAt: NOW + D, backAt: NOW + 4 * D }, active = { ...planned, state: 'active' as const, leaveAt: NOW - D };
    expect(parsePatch({ backAt: NOW + 5 * D }, planned, NOW)).toEqual({ leaveAt: NOW + D, backAt: NOW + 5 * D });
    expect(parsePatch({ leaveAt: NOW + 2 * D }, planned, NOW)).toEqual({ leaveAt: NOW + 2 * D, backAt: NOW + 4 * D });
    expect(parsePatch({ backAt: NOW + 6 * D }, active, NOW)).toEqual({ leaveAt: NOW - D, backAt: NOW + 6 * D });   // "Running late" / extend
    expect(parsePatch({ backAt: null }, active, NOW)).toEqual({ leaveAt: NOW - D, backAt: null });                 // "until I'm back"
    const bad = (b: unknown, t: Parameters<typeof parsePatch>[1] = planned) => (parsePatch(b, t, NOW) as { error?: string }).error;
    expect(bad({ leaveAt: NOW + D }, active)).toBe('the trip has started; only the arrival time can change');
    expect(bad({ backAt: NOW - H }, active)).toBe('backAt must be in the future');
    expect(bad({ leaveAt: NOW + 3 * D + 23.5 * H })).toBe('backAt must be at least an hour after leaveAt');
    expect(bad({})).toBe('send leaveAt and/or backAt');
  });
});

describe('trip phase', () => {
  it('VT-3 planned → away → due for 2 h after the arrival time → late; nothing once it is over', () => {
    const t = { state: 'active' as const, leaveAt: NOW, backAt: NOW + 3 * D };
    expect(tripPhase({ ...t, state: 'planned' }, NOW - 1)).toBe('planned');
    expect(tripPhase({ ...t, state: 'planned' }, NOW)).toBe('away');          // its leave time has come: the tick starts it
    expect(tripPhase(t, NOW + 3 * D - 1)).toBe('away');
    expect(tripPhase(t, NOW + 3 * D)).toBe('due');
    expect(tripPhase(t, NOW + 3 * D + LATE_MS - 1)).toBe('due');
    expect(tripPhase(t, NOW + 3 * D + LATE_MS)).toBe('late');
    expect(tripPhase({ ...t, backAt: null }, NOW + 40 * D)).toBe('away');     // open-ended: away until something ends it
    expect(tripPhase({ ...t, state: 'ended' }, NOW + D)).toBeNull();
    expect(tripPhase({ ...t, state: 'cancelled' }, NOW + D)).toBeNull();
    expect(tripPhase(null, NOW)).toBeNull();
    expect(isAway({ ...t, state: 'planned' }, NOW - 1)).toBe(false);
    expect(isAway(t, NOW + 3 * D + LATE_MS)).toBe(true);                       // late is still the trip's settings until a sign of you
  });

  it('VT-4 trip days: 4 h or more away in a Chicago day; a DST day counts its own length; cancelled trips never count', () => {
    const at = (s: string) => Date.parse(s);
    const trips = [
      { state: 'ended' as const, startedAt: at('2026-10-15T07:00:00-05:00'), endedAt: at('2026-10-18T18:00:00-05:00') },   // Thu 7 AM → Sun 6 PM
      { state: 'cancelled' as const, startedAt: at('2026-10-20T07:00:00-05:00'), endedAt: at('2026-10-22T07:00:00-05:00') },
      { state: 'ended' as const, startedAt: at('2026-10-24T21:00:00-05:00'), endedAt: at('2026-10-25T02:30:00-05:00') },    // a night out: 3 h + 2.5 h
      { state: 'ended' as const, startedAt: at('2026-10-31T20:00:00-05:00'), endedAt: at('2026-11-02T03:00:00-06:00') },    // across the fall-back night
    ];
    expect([...tripDaysOf(trips, '2026-10-01', '2026-11-30', NOW)].sort())
      .toEqual(['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-31', '2026-11-01']);   // 10-24/25 under 4 h each; 11-02 is 3 h
    expect([...tripDaysOf(trips, '2026-10-16', '2026-10-17', NOW)].sort()).toEqual(['2026-10-16', '2026-10-17']);
    // under way: up to now
    expect([...tripDaysOf([{ state: 'active', startedAt: at('2026-10-05T07:00:00-05:00'), endedAt: null }], '2026-10-01', '2026-10-31', NOW)].sort())
      .toEqual(['2026-10-05', '2026-10-06']);
  });
});
