// Settings › Alerts (approved mockup mockups/al-ia.html v2, frame 15; web/src/lib/alertgroups.js): five groups over the sixteen
// switches the server knows, "N of M on", the group switch, and NEW badges that go away 14 days after a feature shipped.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ALERTS, ALERT_GROUPS, NEW_SINCE, NEW_DAYS, isNew, groupIsNew, groupState, toggleGroup, groupOf, isOn } from '../../web/src/lib/alertgroups.js';

describe('groups', () => {
  it('five groups in the mockup order', () => {
    expect(ALERT_GROUPS.map(g => g.title)).toEqual(['Power & grid', 'Solar & panels', 'Comfort & pool', 'Away', 'Reports']);
  });
  it('every switch is in exactly one group, and every switch the server toggles is here', () => {
    const keys = ALERT_GROUPS.flatMap(g => g.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(Object.keys(ALERTS).sort());
    const notify = readFileSync(new URL('../../server/src/notify.ts', import.meta.url), 'utf8');
    const toggles = /TOGGLES[^=]*=\s*\{([\s\S]*?)\};/.exec(notify)[1];
    for (const [, list] of toggles.matchAll(/\[([^\]]*)\]/g)) for (const [, k] of list.matchAll(/'(\w+)'/g)) expect(groupOf(k), k).not.toBeNull();
  });
  it('"N of M on" counts a switch as on unless it was turned off', () => {
    const g = ALERT_GROUPS.find(x => x.id === 'comfort');
    expect(groupState(g, {}).line).toBe('3 of 3 on');
    expect(groupState(g, { anomaly: false }).line).toBe('2 of 3 on');
    expect(groupState(g, { anomaly: false, approval: false, poolTest: false })).toMatchObject({ on: 0, any: false });
    expect(isOn(undefined, 'outage')).toBe(true);
  });
  it('the group switch turns every alert in the group off when any is on, and all on when none is', () => {
    const g = ALERT_GROUPS.find(x => x.id === 'solar');
    const off = toggleGroup({ solar: true, nws: false }, g);
    expect(off).toEqual({ solar: false, panel: false, stale: false, nws: false });   // other groups untouched
    expect(toggleGroup(off, g)).toMatchObject({ solar: true, panel: true, stale: true });
  });
});

describe('NEW badges expire 14 days after the feature ships', () => {
  it('days 0–13 show it, day 14 does not, and before shipping never', () => {
    expect(NEW_DAYS).toBe(14);
    expect(isNew('vacation', '2026-10-06')).toBe(true);
    expect(isNew('vacation', '2026-10-19')).toBe(true);
    expect(isNew('vacation', '2026-10-20')).toBe(false);
    expect(isNew('vacation', '2026-10-05')).toBe(false);
    expect(isNew('outage', '2026-10-07')).toBe(false);   // shipped long before: no date, no badge
  });
  it('a group shows NEW while any of its alerts does', () => {
    const away = ALERT_GROUPS.find(g => g.id === 'away'), power = ALERT_GROUPS.find(g => g.id === 'power');
    expect(groupIsNew(away, '2026-10-07')).toBe(true);
    expect(groupIsNew(power, '2026-10-07')).toBe(true);    // storm and ercot shipped 2026-09-27
    expect(groupIsNew(power, '2026-10-11')).toBe(false);
  });
  it('every dated key exists (or is the push switch)', () => {
    for (const k of Object.keys(NEW_SINCE)) expect(k === 'push' || k in ALERTS, k).toBe(true);
  });
});
