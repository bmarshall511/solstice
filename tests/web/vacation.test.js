// Vacation mode's words and numbers in the app (web/src/lib/vacation.js; mockup ak). Pure, in the site's time zone.
import { describe, it, expect } from 'vitest';
import { backLabel, spanLabel, dayOfTrip, tripProgress, defaultDates, poolBackLabel, welcomeSteps, dateLabel, minus, k0 } from '../../web/src/lib/vacation.js';

const at = s => Date.parse(s);
describe('Vacation mode labels', () => {
  it('back, span and day labels', () => {
    const now = at('2026-10-16T14:00:00-05:00');
    expect(backLabel(at('2026-10-18T18:00:00-05:00'), now)).toBe('back Sun 6 PM');
    expect(backLabel(at('2026-10-16T18:30:00-05:00'), now)).toBe('back 6:30 PM');
    expect(backLabel(null, now)).toBe('until you’re back');
    expect(spanLabel(at('2026-10-15T07:00:00-05:00'), at('2026-10-18T18:00:00-05:00'))).toBe('Thu → Sun');
    expect(spanLabel(at('2026-10-15T07:00:00-05:00'), null)).toBe('from Thu');
    expect(dayOfTrip(at('2026-10-15T07:00:00-05:00'), at('2026-10-18T18:00:00-05:00'), now)).toBe('day 2 of 4');
    expect(dayOfTrip(at('2026-10-15T07:00:00-05:00'), null, now)).toBe('day 2');
    expect(tripProgress(0, 100, 50)).toBe(.5);
    expect(dateLabel(at('2026-10-15T07:00:00-05:00'))).toBe('Thu Oct 15');
    expect([minus(2.84), minus(null), k0(70.6), k0(null)]).toEqual(['−2.8', '—', '71', '—']);
  });
  it('defaults, the evening pool run, the welcome steps', () => {
    const d = defaultDates(at('2026-10-06T19:00:00-05:00'));
    expect(d.leaveAt).toBe(at('2026-10-06T19:00:00-05:00'));
    expect(d.backAt).toBe(at('2026-10-09T18:00:00-05:00'));
    expect(defaultDates(at('2026-10-06T22:00:00-05:00')).leaveAt).toBe(at('2026-10-07T07:00:00-05:00'));
    expect(poolBackLabel(at('2026-10-18T18:00:00-05:00'))).toBe('Sat 8:15 PM');
    expect(poolBackLabel(at('2026-11-08T18:00:00-06:00'))).toBe('Sat 7:15 PM');                 // after the November change
    const s = welcomeSteps(at('2026-10-18T15:00:00-05:00'), 81.2, 78, at('2026-10-18T18:00:00-05:00'));
    expect(s.map(x => [x.label, x.sub, !!x.done])).toEqual([['3:00', '81°', false], ['3:30', '79°', false], ['4:00', '78°', true], ['6:00', 'you', false]]);
  });
});
