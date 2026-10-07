// The Log sheet's timeline (approved mockup mockups/al-ia.html v2, frame 18; web/src/lib/timeline.js): four logs merged newest
// first, each line's kind, repeats folded into "×N", the filter pills, day labels and the CSV Export saves.
import { describe, it, expect } from 'vitest';
import { logKind, pwEntry, guestSafe, mergeLog, foldRepeats, filterLog, filterCounts, groupByDay, dayLabel, rangeLabel, timeOf, timelineCsv, FILTERS } from '../../web/src/lib/timeline.js';

const at = (day, h, m = 0) => Date.parse(`${day}T00:00:00-05:00`) + (h * 60 + m) * 60_000;   // Chicago (CDT) wall clock
const logs = {
  ac: [{ at: at('2026-10-07', 7), day: '2026-10-07', text: 'Set 78° (morning, comfort band)' },
    { at: at('2026-10-06', 17, 40), day: '2026-10-06', text: 'You set 76° in Solstice (5:40 PM). Holding until 7:40 PM', delta: 'hold' }],
  pool: [{ at: at('2026-10-06', 20, 15), day: '2026-10-06', text: 'Tomorrow: 12 h at 1,750 RPM + 1 h skim' }],
  pw: [{ at: at('2026-10-06', 16, 10), rule: 'storm', command: 'backup_reserve', value: 50, result: 'suggested' }],
  learn: [{ at: at('2026-10-06', 1, 5), day: '2026-10-06', text: "Scored last night's solar forecast" },
    { at: at('2026-10-06', 0, 30), day: '2026-10-06', text: 'AC trim: coast ends 30 min earlier' },
    { at: at('2026-10-05', 0, 30), day: '2026-10-05', text: 'AC trim: coast ends 30 min earlier' },
    { at: at('2026-10-04', 0, 30), day: '2026-10-04', text: 'AC trim: coast ends 30 min earlier' }],
};

describe('kinds', () => {
  it('reads the logs’ own words and deltas', () => {
    expect(logKind('Set 78° (morning, comfort band)')).toBe('wrote');
    expect(logKind('Tomorrow: 12 h at 1,750 RPM')).toBe('wrote');
    expect(logKind('You saved the pump schedule', 'you')).toBe('you');
    expect(logKind('Someone set 76° at the thermostat', 'hold')).toBe('you');
    expect(logKind('Suggested for tomorrow: 12 h')).toBe('sugg');
    expect(logKind('Refused your change: too fast', 'refused')).toBe('warn');
    expect(logKind('Forecast is 98°')).toBe('info');
  });
  it('Powerwall rows: sent, suggested, refused', () => {
    expect(pwEntry({ rule: 'reserve', command: 'backup_reserve', value: 40, result: 'sent', source: 'auto' })).toMatchObject({ text: 'Set reserve 40%', kind: 'wrote' });
    expect(pwEntry({ rule: 'export', command: 'grid_import_export', value: 'pv_only', result: 'sent', source: 'owner' })).toMatchObject({ text: 'Set export to Solar only', kind: 'you' });
    expect(pwEntry({ rule: 'storm', command: 'backup_reserve', value: 50, result: 'suggested' })).toEqual({ text: 'Suggested reserve 50% (storm)', sub: 'not applied', kind: 'sugg' });
    expect(pwEntry({ rule: 'reserve', command: 'backup_reserve', value: 5, result: 'refused', reason: 'below the floor', at: at('2026-10-06', 9) }).kind).toBe('warn');
  });
});

describe('merge, fold, filter', () => {
  const all = mergeLog(logs);
  it('all four sources, newest first, with their source line', () => {
    expect(all.map(e => e.src)).toEqual(['ac', 'pool', 'ac', 'pw', 'learn', 'learn']);
    expect(all[0]).toMatchObject({ text: 'Set 78° (morning, comfort band)', sub: 'AC Autopilot', kind: 'wrote', n: 1 });
    expect(all.find(e => e.src === 'ac' && e.kind === 'you').sub).toBe('AC Autopilot · hold');
  });
  it('folds consecutive repeats into one entry with ×N and the day range', () => {
    const trim = all.find(e => /trim/.test(e.text));
    expect(trim).toMatchObject({ n: 3, from: '2026-10-04', to: '2026-10-06', day: '2026-10-06' });
    expect(rangeLabel(trim.from, trim.to)).toBe('Oct 4 – Oct 6');
    expect(foldRepeats([{ src: 'a', text: 'x', day: 'd1' }, { src: 'b', text: 'x', day: 'd1' }])).toHaveLength(2);   // different sources stay apart
  });
  it('the filter pills (Info also shows warnings)', () => {
    expect(FILTERS.map(f => f[1])).toEqual(['All', 'Wrote', 'You', 'Suggested', 'Info']);
    expect(filterLog(all, 'you').map(e => e.src)).toEqual(['ac']);
    expect(filterLog(all, 'sugg').map(e => e.src)).toEqual(['pw']);
    expect(filterCounts(all)).toEqual({ all: 6, wrote: 3, you: 1, sugg: 1, info: 1 });
    const warn = mergeLog({ pool: [{ at: at('2026-10-06', 9), day: '2026-10-06', text: 'Refused your change: limit', delta: 'refused' }] });
    expect(filterLog(warn, 'info')).toHaveLength(1);
  });
  it('a row with only a day still lands on that day, without a time', () => {
    const e = mergeLog({ pool: [{ day: '2026-10-01', text: 'Tomorrow: 10 h' }] })[0];
    expect(e.day).toBe('2026-10-01'); expect(timeOf(e)).toBe('—');
    expect(timeOf(all[0])).toBe('7:00 AM');
    expect(mergeLog({})).toEqual([]);
  });
});

describe('day labels and CSV', () => {
  it('sticky day labels: Today, Yesterday, then the date', () => {
    expect(dayLabel('2026-10-07', '2026-10-07')).toBe('Today · Wed Oct 7');
    expect(dayLabel('2026-10-06', '2026-10-07')).toBe('Yesterday · Tue Oct 6');
    expect(dayLabel('2026-10-04', '2026-10-07')).toBe('Sun Oct 4');
    const g = groupByDay(mergeLog(logs), '2026-10-07');
    expect(g.map(x => x.label)).toEqual(['Today · Wed Oct 7', 'Yesterday · Tue Oct 6']);
    expect(g[1].items).toHaveLength(5);
  });
  it('Export: one CSV row per entry, quoted where needed', () => {
    const csv = timelineCsv(mergeLog(logs)).trim().split('\n');
    expect(csv[0]).toBe('day,time,source,kind,text,detail,repeats,first day');
    expect(csv).toHaveLength(7);
    expect(csv[1]).toBe('2026-10-07,7:00 AM,AC Autopilot,wrote,"Set 78° (morning, comfort band)",AC Autopilot,1,2026-10-07');
    expect(csv.some(l => l.includes(',You set 76° in Solstice (5:40 PM). Holding until 7:40 PM,'))).toBe(true);   // no comma: not quoted
    expect(timelineCsv([{ day: 'd', src: 'pool', kind: 'info', text: 'say "hi"', n: 1 }])).toContain('"say ""hi"""');
  });
});

describe('a guest’s log', () => {
  it('keeps Solstice’s own lines and drops what a person did, holds, Away, trips and Eco', () => {
    const e = mergeLog({ ...logs, ac: [...logs.ac, { at: at('2026-10-05', 9), day: '2026-10-05', text: 'Away: ended the hold on 76°; back to the plan' }, { at: at('2026-10-05', 8), day: '2026-10-05', text: 'Eco on at the thermostat', delta: 'eco' }] });
    const g = guestSafe(e);
    expect(g.some(x => x.kind === 'you')).toBe(false);
    expect(g.some(x => /away|hold|eco/i.test(x.text))).toBe(false);
    expect(g.map(x => x.text)).toContain('Set 78° (morning, comfort band)');
    expect(g.map(x => x.text)).toContain('Tomorrow: 12 h at 1,750 RPM + 1 h skim');
  });
});
