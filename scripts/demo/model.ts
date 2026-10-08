// The demo's synthetic world (scripts/demo-server.mjs): one made-up house in central Texas, simulated in 5-minute steps. Pure: no
// database, no network. Every figure here is invented. The weather the Open-Meteo fixtures serve (fixtures.ts) and the energy, Nest and
// pool rows the seed writes (seed.ts) come from the same functions, so the solar matches the sun, the AC matches the heat and the
// strip heat matches the cold mornings.
import { rfc3339, localMidnight, addDays, localDay } from '../../server/src/tesla/client.js';

/* ---------- the made-up site ---------- */
/** A generic public point (central Austin), never the owner's. The demo server puts these in SITE_LAT / SITE_LON / SITE_ZIP. */
export const DEMO_LOCATION = { lat: 30.2672, lon: -97.7431, zip: '78701' } as const;
export const DEMO_SITE_ID = 'demo-site-1';
export const DEMO_DEVICE_ID = 'enterprises/demo-project/devices/demo-thermostat';
/** Two 13.5 kWh Powerwall 2s: 27 kWh, 10 kW together; a 20% backup reserve. */
export const BATTERY = { kwh: 27, kw: 10, reservePct: 20, eff: .95 } as const;
/** The roof: 9.6 kW DC (30 × 320 W), 9.45 kW AC, 27° tilt facing 244° (west-south-west). */
export const ROOF = { dcKw: 9.6, acKw: 9.45, tilt: 27, azimuth: 244, derate: .86, panels: 30 } as const;
/** Pool pump programs: Pool 10:00–19:00 at 1500 RPM, High Speed 14:00–15:00 at 2400 RPM (circuits 6 and 8, as on the real controller type). */
export const POOL = { poolCircuit: 6, boostCircuit: 8, poolStart: 10, poolStop: 19, boostStart: 14, boostStop: 15, poolRpm: 1500, boostRpm: 2400 } as const;
export const pumpWatts = (rpm: number) => rpm <= 0 ? 0 : Math.round(55 * (rpm / 1000) ** 2.9);

/* ---------- deterministic randomness ---------- */
export function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
/** mulberry32 seeded by a string: the same day always gets the same weather and the same water-heater times. */
export function rng(seed: string) {
  let a = hash(seed);
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const DEG = Math.PI / 180;

/* ---------- weather ---------- */
export type Sky = 'clear' | 'partly' | 'overcast' | 'rain';
export type DayWx = { day: string; high: number; low: number; prevHigh: number; nextLow: number; sky: Sky; cloud: number; rainMm: number; cold: boolean; setback: boolean; wind: number };
/**
 * The demo's cold snap: these days (relative to the demo's today) get a 36–40 °F dawn, so the heat pump runs and the strips come on
 * (the Strip heat card shows: Nest said HEATING in the last 7 days). On `setback` mornings the thermostat recovers from 64 to 68 °F at
 * 06:00, which is what the card calls a setback recovery; the other cold mornings are "the cold".
 */
export const COLD_DAYS: ReadonlyArray<{ ago: number; setback: boolean }> = [{ ago: 5, setback: true }, { ago: 4, setback: false }, { ago: 2, setback: true }, { ago: 0, setback: true }];
export function coldOf(day: string, today = localDay()) {
  const ago = Math.round((Date.parse(today) - Date.parse(day)) / 864e5);
  return COLD_DAYS.find(c => c.ago === ago) ?? null;
}
const doy = (day: string) => Math.floor((Date.parse(day) - Date.UTC(+day.slice(0, 4), 0, 1)) / 864e5) + 1;
/** One day's weather. Seasonal Austin-like highs (64 °F in January, 96 °F in late July), mostly sunny, a rainy day now and then. */
export function dayWx(day: string, today = localDay()): DayWx {
  const w = rawWx(day, today);
  return { ...w, prevHigh: rawWx(addDays(day, -1), today).high, nextLow: rawWx(addDays(day, 1), today).low };
}
function rawWx(day: string, today: string): Omit<DayWx, 'prevHigh' | 'nextLow'> {
  const r = rng(`wx:${day}`), d = doy(day);
  const seasonal = 80 + 16 * Math.cos(2 * Math.PI * (d - 205) / 365);
  let high = seasonal + (r() - .5) * 8, low = high - 17 - r() * 6;
  const x = r();
  let sky: Sky = x < .6 ? 'clear' : x < .8 ? 'partly' : x < .92 ? 'overcast' : 'rain';
  const cold = coldOf(day, today);
  if (cold) { sky = 'clear'; low = 36 + r() * 4; high = 63 + r() * 4; }
  // winter mornings below freezing now and then, so last winter's energy-only strip days (the back-test) exist
  if (!cold && [12, 1, 2].includes(+day.slice(5, 7)) && r() < .25) { low = 26 + r() * 8; high = Math.min(high, 55); }
  const cloud = sky === 'clear' ? 5 + r() * 10 : sky === 'partly' ? 30 + r() * 30 : sky === 'overcast' ? 80 + r() * 15 : 90 + r() * 10;
  const rainMm = sky === 'rain' ? Math.round((4 + r() * 18) * 10) / 10 : sky === 'overcast' && r() < .3 ? Math.round(r() * 3 * 10) / 10 : 0;
  return { day, high: Math.round(high * 10) / 10, low: Math.round(low * 10) / 10, sky, cloud, rainMm, cold: !!cold, setback: !!cold?.setback, wind: Math.round((5 + r() * 9) * 10) / 10 };
}
/** Outdoor °F at a local hour (fractional): the low at 06:30, the high at 16:00; the night joins yesterday's high to today's low and
 *  today's high to tomorrow's low, so midnight has no step. */
export function tempAt(w: DayWx, hour: number) {
  const h = Math.max(0, Math.min(24, hour)), cos = (f: number) => (1 - Math.cos(Math.PI * f)) / 2;
  if (h >= 6.5 && h < 16) return w.low + (w.high - w.low) * cos((h - 6.5) / 9.5);
  if (h >= 16) return w.high + (w.nextLow - w.high) * cos((h - 16) / 14.5);
  return w.prevHigh + (w.low - w.prevHigh) * cos((h + 8) / 14.5);
}
/** Hourly cloud cover (%), wobbling around the day's. */
export const cloudAt = (w: DayWx, hour: number) => clamp(w.cloud + (rng(`cl:${w.day}:${Math.floor(hour)}`)() - .5) * (w.sky === 'partly' ? 50 : 14), 0, 100);

/* ---------- the sun ---------- */
/** Sun elevation and compass azimuth (degrees) at an epoch, NOAA's simplified equations. */
export function sunAt(ms: number, lat: number = DEMO_LOCATION.lat, lon: number = DEMO_LOCATION.lon) {
  const d = new Date(ms), start = Date.UTC(d.getUTCFullYear(), 0, 1), n = (ms - start) / 864e5;
  const g = 2 * Math.PI / 365 * n;
  const eqt = 229.18 * (.000075 + .001868 * Math.cos(g) - .032077 * Math.sin(g) - .014615 * Math.cos(2 * g) - .040849 * Math.sin(2 * g));
  const decl = .006918 - .399912 * Math.cos(g) + .070257 * Math.sin(g) - .006758 * Math.cos(2 * g) + .000907 * Math.sin(2 * g) - .002697 * Math.cos(3 * g) + .00148 * Math.sin(3 * g);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const ha = ((utcMin + eqt + 4 * lon) / 4 - 180) * DEG, la = lat * DEG;
  const cosZ = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha), zen = Math.acos(clamp(cosZ, -1, 1));
  const el = 90 - zen / DEG;
  let az = Math.acos(clamp((Math.sin(la) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(la) * Math.sin(zen) || 1e-9), -1, 1)) / DEG;
  az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
  return { el, az };
}
/** Irradiance on the panels' plane (W/m²) at an epoch for a cloud cover: a clear-sky beam and diffuse model, attenuated by cloud (Kasten). */
export function gtiAt(ms: number, cloudPct: number) {
  const { el, az } = sunAt(ms); if (el <= 0) return 0;
  const am = 1 / (Math.sin(el * DEG) + .50572 * (el + 6.07995) ** -1.6364), dni = 1353 * .7 ** (am ** .678), dhi = .1 * dni;
  const t = ROOF.tilt * DEG, cosI = Math.sin(el * DEG) * Math.cos(t) + Math.cos(el * DEG) * Math.sin(t) * Math.cos((az - ROOF.azimuth) * DEG);
  const clear = dni * Math.max(0, cosI) + dhi * (1 + Math.cos(t)) / 2 + .2 * (dni * Math.sin(el * DEG) + dhi) * (1 - Math.cos(t)) / 2;
  return Math.max(0, clear * (1 - .75 * (cloudPct / 100) ** 3.4));
}
/** Global horizontal irradiance (W/m²), for `shortwave_radiation`. */
export function ghiAt(ms: number, cloudPct: number) {
  const { el } = sunAt(ms); if (el <= 0) return 0;
  const am = 1 / (Math.sin(el * DEG) + .50572 * (el + 6.07995) ** -1.6364), dni = 1353 * .7 ** (am ** .678);
  return Math.max(0, (dni * Math.sin(el * DEG) + .1 * dni) * (1 - .75 * (cloudPct / 100) ** 3.4));
}
/** Sunrise and sunset (epoch ms) of a local day, to the minute. */
export function sunTimes(day: string) {
  const m0 = localMidnight(day).getTime(); let rise = 0, set = 0;
  for (let m = 0; m < 1440; m++) { const up = sunAt(m0 + m * 60_000).el > -.83; if (up && !rise) rise = m0 + m * 60_000; if (!up && rise && !set) set = m0 + m * 60_000; }
  return { rise, set };
}

/* ---------- the house, one day in 5-minute buckets ---------- */
export type HvacState = 'OFF' | 'COOLING' | 'HEATING';
export type Bucket = {
  ts: string; epoch: number; day: string; hour: number;
  solarKw: number; homeKw: number; acKw: number; heatKw: number; stripKw: number; poolKw: number; waterHeaterKw: number; ovenKw: number;
  hvac: HvacState; outdoorF: number; cloud: number;
};
const B = 300_000;
/** Minutes of [a, b) inside [s, e). */
const overlap = (a: number, b: number, s: number, e: number) => Math.max(0, Math.min(b, e) - Math.max(a, s));
type Burst = { start: number; minutes: number; kw: number };
/** The day's water-heater (4.4 kW, 22 minutes, three or four times) and oven (2.6 kW, about 45 minutes, most evenings) runs, local hours. */
export function burstsOf(day: string): { water: Burst[]; oven: Burst[] } {
  const r = rng(`loads:${day}`), m0 = localMidnight(day).getTime(), at = (h: number) => m0 + Math.round(h * 60) * 60_000;
  const water = [6.9 + r() * .6, 12 + r() * 3, 19.4 + r() * 1.2].map(h => ({ start: at(h), minutes: 22, kw: 4.4 }));
  if (r() < .45) water.push({ start: at(9.5 + r()), minutes: 22, kw: 4.4 });
  const oven = r() < .7 ? [{ start: at(17.2 + r() * .6), minutes: 40 + Math.round(r() * 10), kw: 2.6 }] : [];
  return { water, oven };
}
/** The pool pump's RPM at an epoch (the programs above; nothing else runs it). */
export function pumpRpmAt(ms: number) {
  const t = rfc3339(new Date(ms)), h = +t.slice(11, 13) + +t.slice(14, 16) / 60;
  if (h >= POOL.boostStart && h < POOL.boostStop) return POOL.boostRpm;
  return h >= POOL.poolStart && h < POOL.poolStop ? POOL.poolRpm : 0;
}
/**
 * The thermostat at an epoch: cooling above about 80 °F outside (a 30-minute cycle whose on-share grows with the heat), heating on cold
 * mornings (the heat pump cycles; a setback recovery at 06:00 runs 45 minutes straight and the 9 kW strips come on 10 minutes in).
 * Every switch falls on a 5-minute boundary (the on-share is whole 5-minute steps), so each energy bucket holds one state, as the
 * readings (taken on the boundaries) say.
 */
export function hvacAt(ms: number, w: DayWx) {
  ms = Math.floor(ms / B) * B;   // one state per 5-minute bucket
  const t = rfc3339(new Date(ms)), h = +t.slice(11, 13) + +t.slice(14, 16) / 60, out = tempAt(w, h), cyc = Math.floor(ms / 60_000) % 30;
  const on = (duty: number) => cyc < Math.round(duty * 6) * 5;   // whole 5-minute steps of each 30-minute cycle
  const coolF = h >= 22 || h < 6 ? 77 : 78;
  let heatF: number | null = null, hvac: HvacState = 'OFF', strip = false;
  const heatMorning = w.cold || w.low < 42;
  if (heatMorning && (h < 11 || h >= 22)) {
    heatF = w.setback && h < 6 ? 64 : 68;
    if (w.setback && h >= 6 && h < 6.75) { hvac = 'HEATING'; strip = h >= 6 + 10 / 60 && h < 6 + 40 / 60; }
    else if (on(clamp((heatF - 10 - out) / 25, 0, .67))) hvac = 'HEATING';
    // on the cold mornings without a setback the strips help the heat pump in the coldest half hour
    if (!w.setback && w.cold && hvac === 'HEATING' && h >= 6.5 && h < 7) strip = true;
  } else {
    if (on(clamp((out - 80) / 20 + (h >= 15 && h < 19 ? .1 : 0), 0, .84))) hvac = 'COOLING';
  }
  return { hvac, strip, coolF, heatF, outdoorF: out, mode: heatF != null ? 'HEATCOOL' : 'COOL' };
}
export const AC_KW = 3.6, HEAT_PUMP_KW = 3.2, STRIP_KW = 9;
/** Soiling: the panels lose 0.12% a day since the last cleaning or the last soaking rain (5 mm or more), at most 6%. */
export function soilFactor(day: string, cleanedOn: string | null, today = localDay()) {
  for (let i = 0; i < 90; i++) { const d = addDays(day, -i); if (d === cleanedOn || dayWx(d, today).rainMm >= 5) return 1 - Math.min(.06, .0012 * i); }
  return .94;
}
/** One local day of the house in 5-minute buckets (23, 24 or 25 hours across a DST change), without the battery. */
export function houseDay(day: string, o: { today?: string; cleanedOn?: string | null } = {}): Bucket[] {
  const today = o.today ?? localDay(), w = dayWx(day, today), r = rng(`house:${day}`), soil = soilFactor(day, o.cleanedOn ?? null, today);
  const start = localMidnight(day).getTime(), end = localMidnight(addDays(day, 1)).getTime(), { water, oven } = burstsOf(day);
  const out: Bucket[] = [];
  for (let e = start; e < end; e += B) {
    const ts = rfc3339(new Date(e)), hour = +ts.slice(11, 13), hf = hour + +ts.slice(14, 16) / 60, cloud = cloudAt(w, hf);
    // solar: the plane irradiance at the bucket's middle, a little flicker on partly cloudy days, temperature derate, soiling, the AC cap
    const flick = w.sky === 'partly' ? .65 + .35 * r() : .97 + .03 * r(), cellF = tempAt(w, hf) + gtiAt(e + B / 2, cloud) / 40;
    const solarKw = clamp(gtiAt(e + B / 2, cloud) / 1000 * ROOF.dcKw * ROOF.derate * flick * soil * (1 - .0035 * Math.max(0, (cellF - 32) / 1.8 - 25)), 0, ROOF.acKw);
    // the house: an always-on base with the fridge's cycle, mornings and evenings busier
    const base = .42 + .05 * Math.sin(e / 3600e3) + ((e / 60_000) % 40 < 15 ? .12 : 0) + r() * .04;
    const activity = (hf >= 6.5 && hf < 8.5 ? .35 : 0) + (hf >= 17 && hf < 22.5 ? .7 : hf >= 8.5 && hf < 17 ? .15 : 0) + (r() < .04 ? .6 + r() : 0);
    const mins = (bs: Burst[]) => bs.reduce((a, b) => a + overlap(e, e + B, b.start, b.start + b.minutes * 60_000) / B * b.kw, 0);
    const waterHeaterKw = mins(water), ovenKw = mins(oven);
    // HVAC: one state per bucket (hvacAt), the compressor's draw and the strips on top
    const hv = hvacAt(e, w), ac = hv.hvac === 'COOLING' ? AC_KW : 0, heat = hv.hvac === 'HEATING' ? HEAT_PUMP_KW : 0, strip = hv.strip ? STRIP_KW : 0;
    const poolKw = pumpWatts(pumpRpmAt(e + B / 2)) / 1000;
    const homeKw = base + activity + waterHeaterKw + ovenKw + ac + heat + strip + poolKw;
    out.push({ ts, epoch: e, day, hour, solarKw, homeKw, acKw: ac, heatKw: heat, stripKw: strip, poolKw, waterHeaterKw, ovenKw,
      hvac: hv.hvac, outdoorF: tempAt(w, hf), cloud });
  }
  return out;
}

/* ---------- the Powerwalls ---------- */
export type EnergyRow = {
  ts: string; epoch: number; day: string; hour: number; solar: number; home: number; imp: number; exp: number; chg: number; dis: number;
  solar_home_wh: number; solar_battery_wh: number; solar_grid_wh: number; battery_home_wh: number; battery_grid_wh: number; grid_home_wh: number; grid_battery_wh: number;
  soc: number;
};
/**
 * Self-powered: solar feeds the house first, then charges the Powerwalls (10 kW at most), then exports; the house draws on the
 * Powerwalls down to the reserve, then imports. 95% each way. Returns each bucket's Tesla-style Wh by path and the charge after it.
 */
export function batteryRun(buckets: Bucket[], startSoc: number): { rows: EnergyRow[]; soc: number } {
  let soc = startSoc; const rows: EnergyRow[] = [], cap = BATTERY.kwh * 1000, maxWh = BATTERY.kw * 1000 / 12, floor = BATTERY.reservePct / 100 * cap;
  for (const b of buckets) {
    const s = b.solarKw * 1000 / 12, h = b.homeKw * 1000 / 12, sh = Math.min(s, h);
    let left = s - sh, need = h - sh, sb = 0, sg = 0, bh = 0, gh = 0;
    if (left > 0) { sb = Math.min(left, maxWh, Math.max(0, (cap - soc) / BATTERY.eff)); soc += sb * BATTERY.eff; left -= sb; sg = left; }
    if (need > 0) { bh = Math.min(need, maxWh, Math.max(0, (soc - floor) * BATTERY.eff)); soc -= bh / BATTERY.eff; need -= bh; gh = need; }
    const r1 = (v: number) => Math.round(v * 10) / 10;
    rows.push({ ts: b.ts, epoch: b.epoch, day: b.day, hour: b.hour, solar: r1(s), home: r1(h), imp: r1(gh), exp: r1(sg), chg: r1(sb), dis: r1(bh),
      solar_home_wh: r1(sh), solar_battery_wh: r1(sb), solar_grid_wh: r1(sg), battery_home_wh: r1(bh), battery_grid_wh: 0, grid_home_wh: r1(gh), grid_battery_wh: 0,
      soc: Math.round(soc / cap * 1000) / 10 });
  }
  return { rows, soc };
}

/* ---------- device samples ---------- */
export type NestRow = { ts: number; day: string; hour: number; indoor_f: number; humidity: number; mode: string; hvac: HvacState; cool_f: number; heat_f: number | null; eco: boolean };
/** Thermostat readings every 5 minutes (the 5-minute cron plus Pub/Sub events), from the same thermostat model as the energy. */
export function nestDay(day: string, today = localDay(), until = Infinity): NestRow[] {
  const w = dayWx(day, today), start = localMidnight(day).getTime(), end = Math.min(until, localMidnight(addDays(day, 1)).getTime()), out: NestRow[] = [];
  for (let e = start; e < end; e += B) {
    const s = hvacAt(e, w), set = s.hvac === 'HEATING' || s.heatF != null && tempAt(w, +rfc3339(new Date(e)).slice(11, 13)) < 60 ? (s.heatF ?? 68) - .4 : s.coolF + .4;
    const r = rng(`nest:${e}`)();
    out.push({ ts: e, day, hour: +rfc3339(new Date(e)).slice(11, 13), indoor_f: Math.round((set + (r - .5) * .8) * 10) / 10, humidity: Math.round(46 + 8 * r),
      mode: s.mode, hvac: s.hvac, cool_f: s.coolF, heat_f: s.heatF, eco: false });
  }
  return out;
}
export type PoolRow = { ts: number; day: string; hour: number; running: boolean; watts: number; rpm: number; water_temp: number; air_temp: number; circuits: number[] };
/** Read-only pump reads at :05/:20/:35/:50 of pump hours and HH:05 otherwise (sampling.ts's cadence). */
export function poolDay(day: string, today = localDay(), until = Infinity): PoolRow[] {
  const w = dayWx(day, today), start = localMidnight(day).getTime(), end = Math.min(until, localMidnight(addDays(day, 1)).getTime()), out: PoolRow[] = [];
  const waterF = Math.round((74 + 13 * Math.cos(2 * Math.PI * (doy(day) - 215) / 365)) * 10) / 10;
  for (let e = start + 5 * 60_000; e < end; e += 15 * 60_000) {
    const rpm = pumpRpmAt(e), hour = +rfc3339(new Date(e)).slice(11, 13);
    if (!rpm && Math.round((e - start) / 60_000) % 60 !== 5) continue;
    out.push({ ts: e, day, hour, running: rpm > 0, watts: pumpWatts(rpm), rpm, water_temp: waterF, air_temp: Math.round(tempAt(w, hour + .1)),
      circuits: rpm === POOL.boostRpm ? [POOL.poolCircuit, POOL.boostCircuit] : rpm ? [POOL.poolCircuit] : [] });
  }
  return out;
}
/** The 30 microinverters (made-up serials) at one reading: the array's AC output shared out, one panel a little shaded in the afternoon. */
export function pvsAt(ms: number, solarKw: number, outdoorF: number) {
  return Array.from({ length: ROOF.panels }, (_, i) => {
    const shade = i === 27 && +rfc3339(new Date(ms)).slice(11, 13) >= 17 ? .55 : 1, k = (0.97 + (hash(`pv:${i}`) % 60) / 1000) * shade;
    const kw = Math.min(.315, solarKw / ROOF.panels * k);
    return { sn: `DEMO-INV-${String(i + 1).padStart(2, '0')}`, kw: Math.round(kw * 1e4) / 1e4, kwDc: kw > 0 ? Math.round(kw / .965 * 1e4) / 1e4 : 0,
      v: kw > 0 ? Math.round((54 + (i % 5)) * 100) / 100 : 0, tempC: Math.round(((outdoorF - 32) / 1.8 + kw * 80) * 10) / 10, kwhLifetime: null as number | null };
  });
}
