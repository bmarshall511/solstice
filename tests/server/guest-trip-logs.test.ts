// After a trip, a guest's AC and pool views still never name it (audit 10b, S-02), and outside a trip a manual Away or Nest's Eco
// never shows the away setpoint (S-03). Every text vacation/ac.ts and vacation/pool.ts can write is fed through the guest views here,
// numbers filled in; the hygiene half reads those two files and checks that every text literal is caught by the filter or flagged.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GUEST_GET, PRESENCE_WORDS, noPresence, guestLogEntry } from '../../server/src/redact.js';

type Entry = { text: string; delta?: string; private?: boolean };
const REFUSAL = 'the last setpoint write was under 30 minutes ago';

/** vacation/ac.ts: every line its logAc writes, as written (delta, and `private: true` from the logger). */
const AC_LOG: Entry[] = [
  { text: 'Vacation mode: AC Autopilot is Off, so the thermostat stays as it is', delta: 'trip' },
  { text: `Did not turn Eco off: ${REFUSAL}`, delta: 'refused' },
  { text: 'Vacation mode: turned Eco off so Solstice can hold the trip setting', delta: 'trip' },
  { text: 'Humidity 61–64% for 2 h: holding 83° to dry the house', delta: 'humidity' },
  { text: 'Humidity under 55%: back up to 85°', delta: 'humidity' },
  { text: 'Welcome home: cooling from 84° to 78° for 5:30 PM, on spare solar', delta: 'welcome' },
  { text: 'Welcome home: cooling from 84° to 77° for 11:00 PM', delta: 'welcome' },
  { text: 'Set 85° (vacation)', delta: 'trip' },
  { text: 'Set 83° (vacation: drying the house)', delta: 'trip' },
  { text: 'Set 81° (vacation: drying the house); safety stepped 2°', delta: 'stepping' },
  { text: 'Set 78° (welcome home, on spare solar)', delta: 'trip' },
  { text: 'Set 85° (not back yet: holding the trip setting)', delta: 'trip' },
  { text: 'Set heat 55° (vacation)', delta: 'trip' },
  { text: 'Set heat 64° (vacation)', delta: 'stepping' },
  { text: 'Set heat 68° (welcome home)', delta: 'trip' },
  { text: 'Vacation mode holds nothing while the thermostat is in Heat · Cool', delta: 'trip' },
  { text: 'Vacation mode holds nothing while the thermostat is in Off', delta: 'trip' },
  { text: `Did not set 83° (vacation: drying the house): ${REFUSAL}`, delta: 'refused' },
  { text: `Did not set heat 55° (vacation): ${REFUSAL}`, delta: 'refused' },
  { text: `Did not put heat back to 68°: ${REFUSAL}`, delta: 'refused' },
  { text: 'Vacation over: heat back to 68°', delta: 'trip' },
].map(e => ({ ...e, private: true }));
/** vacation/ac.ts tripTarget's reasons (a plan step's `why` during a trip). */
const AC_WHY = ['not back yet: holding the trip setting', 'welcome home, on spare solar', 'welcome home', 'vacation: drying the house', 'vacation'];
/** vacation/ac.ts and pool.ts: the trip's own log (logTrip) and pool.ts's notifications. Neither has a guest route; fed anyway. */
const TRIP_LOG = ['Turned Nest Eco off', 'The house reached 78° in 2.5 h', 'The house reached 78°',
  'A run-once schedule on the controller ran the pump at 2:05 PM', 'The pump ran outside the plan at 2:05 PM (a pool service, or the panel)',
  'The pool pump ran on a controller schedule', "Seen running at 2:05 PM on a run-once schedule set on the panel, not Solstice's plan.",
  'The pool pump was started outside the plan', 'Seen running at 2:05 PM. A pool service visit, or someone at the panel.'];
/** vacation/pool.ts tripGoal's reasons: always as a set, the first naming the trip. */
const POOL_WHY = [['Vacation: 1 turnover a day (water 75°F)'], ['Vacation: 1.5 turnovers a day (water 82°F)', '+0.5 turnover: day 3 of a heat wave'],
  ['Vacation: 1.5 turnovers a day (water 89°F)', '+0.5 turnover: water at 89°F'], ['Vacation: the trip plan waits because your last water test said hazy']];

const sched = (why: string) => ({ name: 'Pool', rpm: 1500, start: 600, stop: 1140, why });
const plan = (whys: string[]) => ({ goal: 1, hours: 6, schedules: whys.map(sched), kwhPerDay: 2, why: whys });
const all = [...AC_LOG.map(e => e.text), ...AC_WHY, ...TRIP_LOG, ...POOL_WHY.flat()];
const at = (i: number) => ({ at: i, day: '2026-10-12' });

describe('S-02: nothing a trip writes reaches a guest', () => {
  const acView = GUEST_GET.get('/api/appliances/ac')!, poolView = GUEST_GET.get('/api/appliances/pool')!;

  it('GT-1 the AC log: every line vacation/ac.ts writes is dropped (flag, delta and text each drop it on their own)', () => {
    const ok = { ...at(0), text: 'Set 76° (morning, comfort band)' };
    const g = acView({ id: 'ac', log: [ok, ...AC_LOG.map((e, i) => ({ ...at(i + 1), ...e }))] }) as any;
    expect(g.log).toEqual([ok]);
    // without the flag (a line logged before it existed), the delta or the text still drops every trip line but the refusals
    const unflagged = AC_LOG.map(({ private: _p, ...e }, i) => ({ ...at(i), ...e }));
    expect((acView({ log: unflagged }) as any).log.map((x: any) => x.text)).toEqual([`Did not put heat back to ${68}°: ${REFUSAL}`]);
  });
  it('GT-2 the pool log: the same lines, trip log lines and every trip reason are dropped from Pool Autopilot\'s log', () => {
    const ok = { ...at(0), text: 'Tomorrow: 12 h at 1,750 RPM, 3× turnover. season plan', delta: '4 kWh' };
    const lines = [...AC_LOG, ...TRIP_LOG.map(text => ({ text, delta: 'pool', private: true })),
      ...POOL_WHY.map(w => ({ text: `Tomorrow: 6 h at 1,500 RPM, 1× turnover. ${w.join('; ')}`, delta: '2 kWh' }))];
    const g = poolView({ autopilot: { mode: 'auto', log: [ok, ...lines.map((e, i) => ({ ...at(i + 1), ...e }))] } }) as any;
    expect(g.autopilot.log).toEqual([ok]);
  });
  it('GT-3 every pool `why`: tomorrow, tomorrowIfHome, pending, each schedule of every plan', () => {
    for (const whys of POOL_WHY) {
      const day = { date: '2026-10-12', plan: plan(whys), why: whys };
      const g = poolView({ autopilot: { mode: 'auto', tomorrow: day, tomorrowIfHome: day }, pending: day, plan: plan(whys) }) as any;
      expect(g.autopilot.tomorrow.why).toEqual([]);
      expect(g.autopilot.tomorrow.plan.schedules.map((s: any) => s.why)).toEqual(whys.map(w => (noPresence(w) ? w : null)));
      expect(g.pending).toBeNull();
      expect(g.plan).not.toHaveProperty('why');
      expect(JSON.stringify(g)).not.toMatch(/vacation|trip/i);
    }
  });
  it('GT-4 the AC plan: reasons, step reasons, the current step and a trim reason drop every trip text', () => {
    const g = acView({ plan: { date: '2026-10-12', steps: AC_WHY.map((why, hour) => ({ hour, coolF: 85, why })), why: [...AC_WHY, 'Mild day (high 85°): no pre-cool needed'],
      trim: { what: 'precool', reason: 'welcome home' } }, currentStep: { hour: 0, coolF: 85, why: 'vacation: drying the house' } }) as any;
    expect(g.plan.why).toEqual(['Mild day (high 85°): no pre-cool needed']);
    expect(g.plan.steps.every((s: any) => s.why === null)).toBe(true);
    expect([g.currentStep.why, g.plan.trim.reason]).toEqual([null, null]);
  });
  it('GT-5 the text filter alone catches every literal but the few that only ever reach a log through a flagged or trip-only writer', () => {
    expect(all.filter(noPresence).sort()).toEqual([
      '+0.5 turnover: day 3 of a heat wave', '+0.5 turnover: water at 89°F',                   // always after a "Vacation:" reason (whySet)
      `Did not put heat back to 68°: ${REFUSAL}`, 'Humidity under 55%: back up to 85°',        // logAc: private, delta refused/humidity
      'The house reached 78°', 'The house reached 78° in 2.5 h',                                // trip log only
      'The pool pump ran on a controller schedule', 'The pool pump was started outside the plan', 'The pump ran outside the plan at 2:05 PM (a pool service, or the panel)',
      'A run-once schedule on the controller ran the pump at 2:05 PM', "Seen running at 2:05 PM on a run-once schedule set on the panel, not Solstice's plan.",
      'Seen running at 2:05 PM. A pool service visit, or someone at the panel.',                 // trip log and notifications only
    ].sort());
    expect(guestLogEntry({ text: 'Set 76°', delta: 'eco' })).toBe(false);
    expect(guestLogEntry({ text: 'Set 76°', private: true })).toBe(false);
    expect(guestLogEntry({ text: 'Set 76°', delta: 'hold' })).toBe(true);
  });
  it('GT-6 neither the trip log nor notifications have a guest route', () => {
    expect([...GUEST_GET.keys()].filter(p => /vacation|trip|notif/.test(p))).toEqual([]);
  });
});

/* ---------- hygiene: the source files themselves ---------- */
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
/** Text literals on each code line (quoted or template; a nested template is cut at its inner backtick, which is enough to classify). */
const literals = (file: string) => src(file).split('\n').flatMap((line, i) => {
  if (/^\s*(\/\/|\*|\/\*\*|import )/.test(line)) return [];
  const code = line.replace(/\s\/\/ .*$/, '');
  return [...code.matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map(m => (m[1] ?? m[2]).replace(/\$\{[^}]*\}?/g, '#'))
    .filter(t => /[A-Za-z]{2,}.* /.test(t) && !/^(SELECT|INSERT|UPDATE)\b/.test(t)).map(text => ({ line: i + 1, code, text }));
});
/** Literals that are not log or reason text at all: tripAcTick's and writeToward's return codes, logRefusal's 'heat ' prefix
 *  (its line is a flagged logAc), and the departure check's names (owner-only). */
const NOT_TEXT = new Set(['at target', 'no thermostat reading', 'cool #', 'heat #', 'heat ', 'refused: #', 'the spa', 'Spa heat']);
/** Reason literals that reach a log only through vacation/ac.ts's flagged logAc or the trip log (humidStep's `why`). */
const FLAGGED_ELSEWHERE = new Set(['Humidity under #%: back up to #°']);

describe('S-02 hygiene: every text literal in vacation/ac.ts and vacation/pool.ts is filtered or flagged', () => {
  it('GT-7 vacation/ac.ts logs every AC line with private: true', () => {
    expect(src('server/src/vacation/ac.ts')).toMatch(/log\.unshift\(\{[^}]*private: true[^}]*\}\); await kv\.set\(`\$\{siteId\}:ac:log`/);
  });
  for (const file of ['server/src/vacation/ac.ts', 'server/src/vacation/pool.ts']) {
    it(`GT-8 ${file}`, () => {
      const lits = literals(file);
      expect(lits.length).toBeGreaterThan(5);
      const loose = lits.filter(l => !PRESENCE_WORDS.test(l.text) && !NOT_TEXT.has(l.text) && !FLAGGED_ELSEWHERE.has(l.text)
        && !/\blogAc\(/.test(l.code)                              // flagged: private: true (GT-7)
        && !/\b(logTrip|notify)\(|\bkey: `/.test(l.code)          // the trip's log, notifications and their keys: no guest route (GT-6)
        && !/^\+0\.5 turnover/.test(l.text));                      // tripGoal's second reason: only ever after its "Vacation:" one (whySet)
      expect(loose.map(l => `${file}:${l.line} ${l.text}`)).toEqual([]);
    });
  }
  it('GT-9 the exception lists are not stale', () => {
    const texts = new Set(['server/src/vacation/ac.ts', 'server/src/vacation/pool.ts'].flatMap(f => literals(f).map(l => l.text)));
    for (const t of [...NOT_TEXT, ...FLAGGED_ELSEWHERE]) expect(texts.has(t), t).toBe(true);
  });
});

describe('S-03: the away setpoint never reaches a guest', () => {
  const view = GUEST_GET.get('/api/appliances/ac')!;
  const AWAY = 84;
  const numbers = (v: unknown): number[] => (typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(numbers) : []);
  const body = (state: Record<string, unknown>) => ({ id: 'ac', settings: { awayF: AWAY, presence: 'home', dayF: 78, nightF: 77 },
    state: { at: 1, deviceId: 'enterprises/p/devices/d', name: 'Hallway', online: true, indoorF: 79, humidity: 52, hvac: 'OFF', heatF: null, ecoCoolF: AWAY, ecoHeatF: 55, ...state },
    currentStep: { hour: 14, coolF: 77, why: 'afternoon, comfort band' }, presence: { state: 'away', source: 'manual' } });

  it('GT-10 manual Away: the thermostat at the away setpoint shows the plan\'s step instead; awayF is gone', () => {
    const g = view(body({ mode: 'COOL', coolF: AWAY, eco: false })) as any;
    expect(g.settings).not.toHaveProperty('awayF');
    expect(g.state).toEqual({ at: 1, name: 'Thermostat', online: true, indoorF: 79, humidity: 52, mode: 'COOL', hvac: 'OFF', coolF: 77, heatF: null });
    expect(numbers(g)).not.toContain(AWAY);
    expect(g).not.toHaveProperty('presence');
  });
  it('GT-11 Nest Eco: coolF null at the thermostat, the plan\'s step for the guest; no Eco setpoints', () => {
    const g = view(body({ mode: 'COOL', coolF: null, eco: true })) as any;
    expect(g.state.coolF).toBe(77);
    expect(g.state).not.toHaveProperty('eco');
    expect(numbers(g)).not.toContain(AWAY);
    expect(numbers(g)).not.toContain(55);
  });
  it('GT-12 heating or off: no setpoint at all for a guest', () => {
    for (const mode of ['HEAT', 'OFF']) expect((view(body({ mode, coolF: null, heatF: 55, eco: false })) as any).state).toMatchObject({ mode, coolF: null, heatF: null });
    expect((view(body({ mode: 'HEATCOOL', coolF: AWAY, heatF: 55 })) as any).state).toMatchObject({ coolF: 77, heatF: null });
  });
});
