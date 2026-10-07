// Chicago date helpers and the system-age helpers: design §8, cases 22–24. Every case runs under TZ=UTC (Vercel) and
// TZ=America/Chicago (a laptop), which proves the Intl-based helpers do not depend on the process time zone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rfc3339, localMidnight, localDay, addDays } from '../../server/src/tesla/client.js';
import { warrantedDcPct, systemYear } from '../../server/src/system.js';

const at = (iso: string) => new Date(iso);

describe.each(['UTC', 'America/Chicago'])('under TZ=%s', tz => {
  const saved = process.env.TZ;
  beforeAll(() => { process.env.TZ = tz; });
  afterAll(() => { process.env.TZ = saved; });

  it('22: rfc3339 writes Chicago wall time with its offset', () => {
    expect(rfc3339(at('2026-09-24T05:00:00Z'))).toBe('2026-09-24T00:00:00-05:00');
    expect(rfc3339(at('2026-01-15T06:00:00Z'))).toBe('2026-01-15T00:00:00-06:00');
    expect(rfc3339(at('2026-12-31T23:59:59Z'))).toBe('2026-12-31T17:59:59-06:00');
  });
  it('22: rfc3339 across the spring-forward gap (2026-03-08)', () => {
    expect(rfc3339(at('2026-03-08T07:59:59Z'))).toBe('2026-03-08T01:59:59-06:00');
    expect(rfc3339(at('2026-03-08T08:00:00Z'))).toBe('2026-03-08T03:00:00-05:00');
  });
  it('22: rfc3339 across the fall-back overlap (2026-11-01: 01:30 happens twice)', () => {
    expect(rfc3339(at('2026-11-01T06:30:00Z'))).toBe('2026-11-01T01:30:00-05:00');
    expect(rfc3339(at('2026-11-01T07:30:00Z'))).toBe('2026-11-01T01:30:00-06:00');
  });
  it('22: rfc3339 in another zone', () => {
    expect(rfc3339(at('2026-09-24T05:00:00Z'), 'UTC')).toBe('2026-09-24T05:00:00+00:00');
  });
  it('22: the cached formatter writes what a fresh Intl.DateTimeFormat per call did, every 5 min over both DST days, zones interleaved', () => {
    // the formatter is built once per zone (2026-10-07: one per call made the trip estimate take ~12 s); this is the old per-call code
    const fresh = (date: Date, timeZone = 'America/Chicago') => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(date).map(x => [x.type, x.value]));
      const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second), off = Math.round((local - date.getTime()) / 60000), a = Math.abs(off);
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off >= 0 ? '+' : '-'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
    };
    for (const [a, b] of [['2026-03-07T18:00:00Z', '2026-03-09T18:00:00Z'], ['2026-10-31T18:00:00Z', '2026-11-02T18:00:00Z']])
      for (let t = Date.parse(a); t < Date.parse(b); t += 5 * 60_000 + 1_001) {
        const d = new Date(t);
        expect(rfc3339(d)).toBe(fresh(d));
        expect(rfc3339(d, 'Asia/Kolkata')).toBe(fresh(d, 'Asia/Kolkata'));   // another zone in between keeps its own formatter
        expect(rfc3339(d, 'UTC')).toBe(fresh(d, 'UTC'));
      }
  });

  it('23: localMidnight', () => {
    const iso = (d: string) => localMidnight(d).toISOString();
    expect(iso('2026-03-08')).toBe('2026-03-08T06:00:00.000Z');
    expect(iso('2026-03-09')).toBe('2026-03-09T05:00:00.000Z');
    expect(iso('2026-11-01')).toBe('2026-11-01T05:00:00.000Z');
    expect(iso('2026-11-02')).toBe('2026-11-02T06:00:00.000Z');
    expect(iso('2026-09-24')).toBe('2026-09-24T05:00:00.000Z');
  });
  it('23: the DST days are 23 and 25 hours long', () => {
    const hours = (d: string) => (localMidnight(addDays(d, 1)).getTime() - localMidnight(d).getTime()) / 3600e3;
    expect(hours('2026-03-08')).toBe(23);
    expect(hours('2026-11-01')).toBe(25);
    expect(hours('2026-09-24')).toBe(24);
  });
  it('23: localDay rolls over at Chicago midnight, not UTC midnight', () => {
    expect(localDay(at('2026-09-25T04:59:00Z'))).toBe('2026-09-24');
    expect(localDay(at('2026-09-25T05:00:00Z'))).toBe('2026-09-25');
  });
  it('23: localDay across the DST days rolls over at that night\'s Chicago midnight', () => {
    expect([localDay(at('2026-03-08T05:59:59Z')), localDay(at('2026-03-08T06:00:00Z'))]).toEqual(['2026-03-07', '2026-03-08']);   // CST midnight
    expect([localDay(at('2026-03-09T04:59:59Z')), localDay(at('2026-03-09T05:00:00Z'))]).toEqual(['2026-03-08', '2026-03-09']);   // CDT midnight
    expect([localDay(at('2026-11-01T04:59:59Z')), localDay(at('2026-11-01T05:00:00Z'))]).toEqual(['2026-10-31', '2026-11-01']);
    expect([localDay(at('2026-11-02T05:59:59Z')), localDay(at('2026-11-02T06:00:00Z'))]).toEqual(['2026-11-01', '2026-11-02']);   // 25 h later
  });

  it('24: addDays', () => {
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-09-25', -437)).toBe('2025-07-15'); // the backfill horizon
    expect(addDays('2026-09-25', -365)).toBe('2025-09-25');
  });
  it('24: warranted DC output by system year', () => {
    expect([0, 1, 2, 6, 10, 25, 30].map(warrantedDcPct)).toEqual([98, 98, 97.75, 96.75, 95.75, 92, 92]);
  });
  it('24: systemYear', () => {
    expect(systemYear(at('2026-09-25T12:00:00Z'))).toBe(6);
  });
});

import { localAt } from '../../server/src/tesla/client.js';
describe('localAt: local clock times across the DST changes (America/Chicago)', () => {
  const iso = (t: number) => new Date(t).toISOString();
  it('an ordinary day', () => {
    expect(iso(localAt('2026-07-15', 0))).toBe('2026-07-15T05:00:00.000Z');
    expect(iso(localAt('2026-07-15', 18.5))).toBe('2026-07-15T23:30:00.000Z');
  });
  it('fall-back (2026-11-01, 25 h): 02:00 is 3 h after midnight; the repeated 01:30 is its first occurrence', () => {
    expect(localAt('2026-11-01', 2) - localAt('2026-11-01', 0)).toBe(3 * 3600e3);
    expect(iso(localAt('2026-11-01', 1.5))).toBe('2026-11-01T06:30:00.000Z');   // 01:30 CDT
    expect(iso(localAt('2026-11-01', 22))).toBe('2026-11-02T04:00:00.000Z');    // 22:00 CST
  });
  it('spring-forward (2026-03-08, 23 h): 03:00 is 2 h after midnight; the skipped 02:30 lands an hour later', () => {
    expect(localAt('2026-03-08', 3) - localAt('2026-03-08', 0)).toBe(2 * 3600e3);
    expect(iso(localAt('2026-03-08', 2.5))).toBe('2026-03-08T08:30:00.000Z');   // 03:30 CDT
  });
});
