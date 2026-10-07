// A guest never learns about a trip from the pool or AC views (audit 10b, S-01/S-02): trip days show the plan as if the owner were
// home, reasons and log lines that name the trip are dropped, and a suggested plan that names it is withheld.
import { describe, it, expect } from 'vitest';
import { GUEST_GET } from '../../server/src/redact.js';

const sched = (hours: number, goal: number) => [{ name: 'Pool', rpm: 1750, start: 480, stop: 480 + hours * 60, why: `${hours} h of filtration at 1,750 RPM toward ${goal} turnovers of 14,995 gal a day` }];
const plan = (hours: number, goal: number, boost: number) => ({ month: 9, waterTemp: 75, turnovers: goal, goal, rpm: 1750, hours, boostHours: boost, start: 8, stop: 8 + hours, boostAt: 14, schedules: sched(hours, goal), kwhPerDay: 4, costPerMonth: 13, onSolarPct: 91, turnoverPerDay: goal, hourly: [], uvKwh: .7 });

describe('guest views and trips', () => {
  it('RT-1 the pool view shows trip days as if the owner were home and drops every line that names the trip', () => {
    const view = GUEST_GET.get('/api/appliances/pool')!;
    const owner = {
      id: 'pool', name: 'Pool pump', linked: true,
      autopilot: {
        mode: 'auto', nextRunAt: '2026-10-09T01:15:00.000Z', pending: false, filterHours: 100, filterCleanedOn: null,
        signals: { waterTemp: 75, sunKwhM2: 5.6, sunPct: 69, high: 86, heatDays: 0, rainPct: 1, rainMm: 0, rainYesterdayMm: 0, useDays: 1, pollen: 'low' },
        tomorrow: { date: '2026-10-09', plan: plan(6, 1, 0), why: ['Vacation: 1 turnover a day (water 75°F)'] },
        tomorrowIfHome: { date: '2026-10-09', plan: plan(12, 3, 1), why: ['season plan'] },
        week: [
          { date: '2026-10-09', hours: 6, boost: 0, sunKwhM2: 5.7, rainPct: 8, high: 89, trip: true, ifHome: { hours: 12, boost: 1 } },
          { date: '2026-10-12', hours: 12, boost: 1, sunKwhM2: 5.3, rainPct: 10, high: 85 },
        ],
        log: [
          { at: 1, day: '2026-10-08', text: 'Tomorrow: 6 h at 1,750 RPM, 1× turnover. Vacation: 1 turnover a day (water 75°F)', delta: '2 kWh' },
          { at: 2, day: '2026-10-07', text: 'Tomorrow: 12 h at 1,750 RPM + 1 h skim, 3× turnover. season plan', delta: '4 kWh' },
        ],
      },
      pending: { date: '2026-10-09', plan: plan(6, 1, 0), why: ['Vacation: 1 turnover a day (water 75°F)'] },
      plan: plan(12, 3, 1), todayKwh: .9,
    };
    const g = view(owner) as any;
    expect(g.autopilot.tomorrow).toMatchObject({ date: '2026-10-09', why: ['season plan'], plan: { goal: 3, hours: 12, boostHours: 1 } });
    expect(g.autopilot.tomorrow.plan.schedules[0].why).toContain('toward 3 turnovers');
    expect(g.autopilot.week).toEqual([
      { date: '2026-10-09', hours: 12, boost: 1, sunKwhM2: 5.7, rainPct: 8, high: 89 },
      { date: '2026-10-12', hours: 12, boost: 1, sunKwhM2: 5.3, rainPct: 10, high: 85 },
    ]);
    expect(g.autopilot.log.map((l: any) => l.text)).toEqual(['Tomorrow: 12 h at 1,750 RPM + 1 h skim, 3× turnover. season plan']);
    expect(g.pending).toBeNull();
    expect(JSON.stringify(g)).not.toMatch(/vacation|trip|ifHome/i);
  });
  it('RT-2 with no trip the pool view is unchanged: tomorrow, the week and the log pass through', () => {
    const view = GUEST_GET.get('/api/appliances/pool')!;
    const g = view({ autopilot: { mode: 'auto', tomorrow: { date: '2026-10-09', plan: plan(12, 3, 1), why: ['season plan'] }, tomorrowIfHome: null,
      week: [{ date: '2026-10-09', hours: 12, boost: 1, sunKwhM2: 5.7, rainPct: 8, high: 89 }], log: [{ at: 1, day: '2026-10-08', text: 'Tomorrow: 12 h at 1,750 RPM. season plan' }] },
      pending: { date: '2026-10-09', plan: plan(12, 3, 1), why: ['season plan'] } }) as any;
    expect(g.autopilot.tomorrow.why).toEqual(['season plan']);
    expect(g.autopilot.week[0]).toMatchObject({ hours: 12, boost: 1 });
    expect(g.autopilot.log).toHaveLength(1);
    expect(g.pending.why).toEqual(['season plan']);
    expect(g.autopilot).not.toHaveProperty('tomorrowIfHome');
  });
  it('RT-3 the AC view drops log lines and reasons that name the trip, as it already did for presence', () => {
    const view = GUEST_GET.get('/api/appliances/ac')!;
    const g = view({ id: 'ac', log: [{ at: 1, day: '2026-10-09', text: 'Set 85° (vacation)' }, { at: 2, day: '2026-10-09', text: 'Vacation over: cooling back to 78°' },
      { at: 3, day: '2026-10-09', text: 'Trip plan: humidity guard stepped to 83°' }, { at: 4, day: '2026-10-07', text: 'Set 78° (morning, comfort band)' }],
      plan: { date: '2026-10-09', steps: [], why: ['away: trip target 85°', 'Mild day (high 85°): no pre-cool needed'] } }) as any;
    expect(g.log.map((l: any) => l.text)).toEqual(['Set 78° (morning, comfort band)']);
    expect(g.plan.why).toEqual(['Mild day (high 85°): no pre-cool needed']);
  });
});
