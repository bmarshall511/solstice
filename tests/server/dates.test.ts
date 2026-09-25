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
