// Synthetic payloads for the core (non-appliance) routes, shaped exactly as the server answers the owner, for the DOM tests.
// Pure: no imports, no randomness (a sine hash stands in for noise); every time is derived from `now` (epoch ms; the tests use
// 2026-10-07 14:30 America/Chicago). Keys are the path web/src/lib/api.js passes after `/api/`, query string stripped.
// One generated history backs every route: each Chicago day's 5-minute buckets (genDay) are summed into /api/day, /api/daily,
// /api/monthly, /api/grid-days, /api/records, the bills' Tesla totals and so on, so the figures agree across views.
// Synthetic only (public repo): no names, addresses, account numbers, real coordinates, real prices or the system's cost.

/* ======================= time (America/Chicago) ======================= */
const H = 3600e3, D = 864e5, TZ = 'America/Chicago';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const offFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' });
/** YYYY-MM-DD of an epoch in Chicago (server tesla/client.ts localDay). */
const dayOf = ms => dayFmt.format(new Date(ms));
/** "-05:00" / "-06:00" at an epoch. */
const offOf = ms => offFmt.formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
/** The Chicago clock hour of an epoch, fractional. */
const hourOf = ms => { const [h, m] = clockFmt.format(new Date(ms)).split(':').map(Number); return h + m / 60; };
/** The Fleet API's local RFC3339 string (server rfc3339): "2026-10-07T14:25:00-05:00". */
const rfc = ms => `${dayOf(ms)}T${clockFmt.format(new Date(ms))}:00${offOf(ms)}`;
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * D).toISOString().slice(0, 10);
/** Epoch of a Chicago clock hour on a day (DST-aware: the day's own offset at noon). */
const atLocal = (day, h) => Date.parse(`${day}T00:00:00Z`) + h * H - Number(offOf(Date.parse(`${day}T12:00:00Z`)).slice(0, 3)) * H;
const doyOf = day => Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${day.slice(0, 4)}-01-01T12:00:00Z`)) / D);
const mondayOf = day => addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
function isoWeek(monday) {
  const t = new Date(`${addDays(monday, 3)}T12:00:00Z`), y = t.getUTCFullYear(), jan4 = new Date(Date.UTC(y, 0, 4, 12));
  const w1 = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * D;
  return `${y}-W${String(Math.floor((t.getTime() - w1) / (7 * D)) + 1).padStart(2, '0')}`;
}
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
/** Deterministic noise in [0, 1). */
const noise = k => { const x = Math.sin(k * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const seedOf = day => Math.round(Date.parse(`${day}T12:00:00Z`) / D);
const sum = a => a.reduce((s, v) => s + (v ?? 0), 0);
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

/* ======================= the site (synthetic) ======================= */
const SITE_ID = 'site-test', INSTALL_YEAR = 2020, CAP_KWH = 26.42, NAMEPLATE = 27, MAX_KW = 10, RESERVE = 20, MEASURED_KWH = 25.1;
/** server/src/system.ts SOLAR, as `{ ...SOLAR }` serialises it (installer null and installedOn the year: the env is unset). */
const SOLAR = {
  installer: null, module: 'SunPower SPR-E19-320-AC', panels: 30, panelWdc: 320, panelVaAc: 315,
  microinverter: 'Enphase IQ 7XS (factory-integrated, one per module: module-level MPPT, no strings)', efficiencyPct: 19.9, tempCoefPctPerC: -0.35,
  moduleM: { w: 1.046, h: 1.558 }, dcKw: 9.6, acKw: 9.45, installedOn: String(INSTALL_YEAR),
  warranty: { years: 25, dcYear1Pct: 98, dcDeclinePctPerYear: 0.25, acFloorPct: 90, labourYears: 25 },
};
/** Fake coordinates and ZIP (the real ones live only in the server env). */
export const LOCATION = { lat: 30.0, lon: -97.0, zip: '00000', precision: 'exact' };
export const COARSE_LOCATION = { lat: 30, lon: -97, zip: '000xx', precision: 'coarse' };
/** The tariff the two synthetic bills carry (round placeholders, not PEC's or the owner's). */
const TARIFF = { importRate: 0.09, importRateAllIn: 0.0927, exportCredit: 0.05, fixedMonthly: 30, discounts: 0, franchisePct: 0.03 };
const TRIP_DAYS = new Set(['2026-09-10', '2026-09-11', '2026-09-12']);

/* ======================= weather (one source for the forecast, the archive and the day model) ======================= */
const season = day => Math.cos(2 * Math.PI * (doyOf(day) - 196) / 365);       // 1 in mid-July, −1 in mid-January
const highOf = day => r1(78 + 17 * season(day) + (noise(seedOf(day) + 3) - 0.5) * 8);
const lowOf = day => r1(highOf(day) - 18 - noise(seedOf(day) + 5) * 6);
/** Cloud cover (0–1) of a day: mostly clear, a cloudy day now and then. */
const cloudOf = day => { const n = noise(seedOf(day) + 11); return n > 0.85 ? 0.75 : n > 0.65 ? 0.35 : 0.08; };
const rainOf = day => (noise(seedOf(day) + 17) > 0.88 ? r1(6 + noise(seedOf(day) + 19) * 20) : 0);
const sunWin = day => { const len = 12.2 + 1.8 * season(day), noon = 13.3; return [noon - len / 2, noon + len / 2]; };
/** Tilted irradiance W/m² at a fractional Chicago hour of a day (clear sky × the day's cloud). */
const gtiShape = (a, b, amp, h) => (h <= a || h >= b ? 0 : Math.round(Math.sin((h - a) / (b - a) * Math.PI) ** 1.25 * amp));
const gtiAt = (day, h) => { const [a, b] = sunWin(day); return gtiShape(a, b, (880 + 60 * season(day)) * (1 - 0.8 * cloudOf(day)), h); };
const tempAt = (day, h) => r1(lowOf(day) + (highOf(day) - lowOf(day)) * Math.max(0, Math.sin((h - 7) / 16 * Math.PI)) ** 1.3);

/* ======================= one day's 5-minute buckets (server: the energy and soe tables) ======================= */
/**
 * Buckets of one Chicago day up to `untilHour` (24 = the whole day): kW for solar/home/grid/battery as /api/day sends them (battery +
 * discharging, grid + buying), plus the parts the views split out (ac, pool) and the Powerwall charge after each bucket. The battery
 * follows Self-Powered: solar serves the home, the surplus charges the Powerwalls to full and then exports; at night they carry the home
 * down to the 20% reserve and PEC covers the rest.
 */
function genDay(day, untilHour = 24) {
  const s = seedOf(day), trip = TRIP_DAYS.has(day), hot = Math.max(0, highOf(day) - 80);
  let soc = 38 + noise(s + 23) * 14;
  const out = [], d0 = atLocal(day, 0), [sa, sb] = sunWin(day), amp = (880 + 60 * season(day)) * (1 - 0.8 * cloudOf(day));   // a DST day's lost or repeated hour is ignored: buckets run on the clock
  for (let k = 0; k * 5 / 60 < untilHour - 1e-9; k++) {
    const t = k * 5 / 60, epoch = d0 + t * H;
    const solar = Math.min(SOLAR.acKw, gtiShape(sa, sb, amp, t + 1 / 24) / 1000 * 8.1);
    const base = trip ? 0.38 : 0.55 + (t >= 6.5 && t < 8.5 ? 0.9 : 0) + (t >= 17.5 && t < 21.5 ? 1.1 : 0) + (noise(s * 300 + k) - 0.5) * 0.3;
    // the AC: a cycling 3.2 kW draw, more of the hour the hotter the afternoon; the pool pump at 0.35 kW from 10:00 to 19:00
    const duty = trip ? 0 : t >= 12 && t < 21 ? Math.min(0.85, 0.15 + hot * 0.05) : t >= 21 || t < 6 ? Math.min(0.3, hot * 0.02) : 0.05;
    const ac = ((k % 6) / 6 < duty) ? 3.2 : 0;
    const pool = t >= 10 && t < 19 ? 0.35 : 0;
    const big = !trip && k === 222 + (s % 5) * 3 ? 4.5 : 0;   // one water-heater-like burst around 18:30
    const home = Math.max(0.2, base + ac + pool + big);
    let battery = 0, net = solar - home;
    if (net > 0) { const c = Math.min(net, MAX_KW, (100 - soc) / 100 * CAP_KWH * 12 / 0.95); battery = -c; soc += c * 0.95 / 12 / CAP_KWH * 100; }
    else { const d = Math.min(-net, MAX_KW, Math.max(0, soc - RESERVE) / 100 * CAP_KWH * 12 * 0.95); battery = d; soc -= d / 0.95 / 12 / CAP_KWH * 100; }
    soc = Math.max(0, Math.min(100, soc));
    out.push({ k, t, epoch, solar: r2(solar), home: r2(home), grid: r2(home - solar - battery), battery: r2(battery), ac, pool, soc: r1(soc) });
  }
  return out;
}
/** A day's totals in kWh (server app.ts kwhCols: each column summed and rounded to 0.01). */
function totalsOf(B) {
  const kwh = f => r2(sum(B.map(f)) / 12);
  return { solar: kwh(b => b.solar), home: kwh(b => b.home), import: kwh(b => Math.max(0, b.grid)), export: kwh(b => Math.max(0, -b.grid)),
    charge: kwh(b => Math.max(0, -b.battery)), discharge: kwh(b => Math.max(0, b.battery)) };
}
/** Tesla's charge history: every 15 minutes (the soe table), `t` as /api/day sends it. */
const soeOf = B => B.filter(b => b.k % 3 === 2).map(b => ({ t: b.t + 5 / 60, soc: b.soc }));

/* ======================= Open-Meteo, NWS ======================= */
/** The hosts web/src/lib/weather.js fetches, as patterns a fetch stub can route on (tests/web/dom/harness.js router uses the same). */
export const WEATHER_HOSTS = {
  forecast: /api\.open-meteo\.com\/v1\/forecast/,
  archive: /archive-api\.open-meteo\.com\/v1\/archive/,
  nws: /api\.weather\.gov\/alerts\/active/,
};
export const WEATHER_URLS = { forecast: 'https://api.open-meteo.com/v1/forecast', archive: 'https://archive-api.open-meteo.com/v1/archive', nws: 'https://api.weather.gov/alerts/active' };
const wmo = day => (rainOf(day) ? 61 : cloudOf(day) > 0.6 ? 3 : cloudOf(day) > 0.2 ? 2 : 0);
const hhmm = h => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
/** Open-Meteo's forecast (weather.js forecast(): past_days=31, forecast_days=3, °F, mph): hourly values describe the hour ending at `time`. */
export function forecastFixture(now) {
  const today = dayOf(now), days = Array.from({ length: 34 }, (_, i) => addDays(today, i - 31));
  const time = days.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
  const at = t => [t.slice(0, 10), +t.slice(11, 13)];
  return {
    latitude: LOCATION.lat, longitude: LOCATION.lon, generationtime_ms: 0.2, utc_offset_seconds: -18000, timezone: TZ, timezone_abbreviation: 'GMT-5', elevation: 200,
    current_units: { time: 'iso8601', interval: 'seconds', temperature_2m: '°F', cloud_cover: '%', weather_code: 'wmo code', is_day: '', wind_speed_10m: 'mp/h' },
    current: { time: `${today}T${hhmm(Math.floor(hourOf(now) * 4) / 4)}`, interval: 900, temperature_2m: tempAt(today, hourOf(now)), cloud_cover: Math.round(cloudOf(today) * 100), weather_code: wmo(today), is_day: 1, wind_speed_10m: 7.4 },
    hourly_units: { time: 'iso8601', temperature_2m: '°F', cloud_cover: '%', weather_code: 'wmo code', global_tilted_irradiance: 'W/m²', precipitation_probability: '%' },
    hourly: {
      time,
      temperature_2m: time.map(t => tempAt(...at(t))),
      cloud_cover: time.map(t => Math.round(cloudOf(at(t)[0]) * 100)),
      weather_code: time.map(t => wmo(at(t)[0])),
      // the hour ending at t: the irradiance at its middle
      global_tilted_irradiance: time.map(t => { const [d, h] = at(t); return gtiAt(d, h - 0.5); }),
      precipitation_probability: time.map(t => rainOf(at(t)[0]) ? 70 : 5),
    },
    daily_units: { time: 'iso8601', temperature_2m_max: '°F', temperature_2m_mean: '°F', precipitation_sum: 'mm', precipitation_probability_max: '%', uv_index_max: '', sunrise: 'iso8601', sunset: 'iso8601' },
    daily: {
      time: days, temperature_2m_max: days.map(highOf), temperature_2m_mean: days.map(d => r1((highOf(d) + lowOf(d)) / 2)), precipitation_sum: days.map(rainOf),
      precipitation_probability_max: days.map(d => rainOf(d) ? 80 : 10), uv_index_max: days.map(d => r1(5 + 3 * season(d) * (1 - cloudOf(d)))),
      sunrise: days.map(d => `${d}T${hhmm(sunWin(d)[0])}`), sunset: days.map(d => `${d}T${hhmm(sunWin(d)[1])}`),
    },
  };
}
/** Open-Meteo's archive (weather.js archive(from, to)): hourly GTI, daily highs, means and rain. */
export function archiveFixture(from, to) {
  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const time = days.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
  return {
    latitude: LOCATION.lat, longitude: LOCATION.lon, generationtime_ms: 0.4, utc_offset_seconds: -18000, timezone: TZ, timezone_abbreviation: 'GMT-5', elevation: 200,
    hourly_units: { time: 'iso8601', global_tilted_irradiance: 'W/m²' },
    hourly: { time, global_tilted_irradiance: time.map(t => gtiAt(t.slice(0, 10), +t.slice(11, 13) - 0.5)) },
    daily_units: { time: 'iso8601', temperature_2m_max: '°F', temperature_2m_mean: '°F', precipitation_sum: 'mm' },
    daily: { time: days, temperature_2m_max: days.map(highOf), temperature_2m_mean: days.map(d => r1((highOf(d) + lowOf(d)) / 2)), precipitation_sum: days.map(rainOf) },
  };
}
/** NWS active alerts for a point, as GeoJSON (weather.js nwsAlerts() maps features to their properties): one Heat Advisory. */
export function nwsFixture(now) {
  const onset = rfc(atLocal(dayOf(now), 11)), ends = rfc(atLocal(dayOf(now), 20));
  const id = 'urn:oid:2.49.0.1.840.0.test.heat.1';
  return {
    '@context': ['https://geojson.org/geojson-ld/geojson-context.jsonld'], type: 'FeatureCollection',
    features: [{ id: `https://api.weather.gov/alerts/${id}`, type: 'Feature', geometry: null, properties: {
      '@id': `https://api.weather.gov/alerts/${id}`, '@type': 'wx:Alert', id, areaDesc: 'Test County', geocode: { SAME: ['000000'], UGC: ['TXZ000'] }, affectedZones: [],
      references: [], sent: rfc(atLocal(dayOf(now), 4)), effective: onset, onset, expires: ends, ends, status: 'Actual', messageType: 'Alert', category: 'Met',
      severity: 'Moderate', certainty: 'Likely', urgency: 'Expected', event: 'Heat Advisory', sender: 'w-nws.webmaster@noaa.gov', senderName: 'NWS Test Office',
      headline: 'Heat Advisory issued for Test County until 8:00 PM CDT', description: '* WHAT...Heat index values up to 108 expected.\n\n* WHERE...Test County.',
      instruction: 'Drink plenty of fluids, stay in an air-conditioned room, stay out of the sun.', response: 'Execute', parameters: { NWSheadline: ['HEAT ADVISORY IN EFFECT UNTIL 8 PM CDT THIS EVENING'] },
    } }],
    title: 'Current watches, warnings, and advisories for 30 N, 97 W', updated: rfc(now - 600e3),
  };
}
/** { forecast, archive, nws } for the stub router. The archive is the range main.js asks for (today − 423 … today − 3). */
export function weatherFixtures(now) {
  const forecast = forecastFixture(now);
  const to = addDays(dayOf(now), -3);
  return { forecast, archive: archiveFixture(addDays(to, -420), to), nws: nwsFixture(now) };
}

/* ======================= the owner's routes ======================= */
export function coreFixtures(now) {
  const today = dayOf(now), yday = addDays(today, -1), hNow = hourOf(now);
  const memo = new Map();
  /** A day's buckets (today: up to now). */
  const day = d => { if (!memo.has(d)) memo.set(d, genDay(d, d === today ? hNow : 24)); return memo.get(d); };
  /** One /api/daily row (server app.ts /api/daily: kwhCols plus the day's charge range; trip days marked for the owner). */
  const row = d => { const B = day(d), s = B.filter(b => b.k % 3 === 2).map(b => b.soc);
    return { date: d, ...totalsOf(B), socMin: Math.min(...s), socMax: Math.max(...s), ...(TRIP_DAYS.has(d) ? { trip: true } : {}) }; };
  const between = (from, to) => { const out = []; for (let d = from; d < to; d = addDays(d, 1)) out.push(d); return out; };

  /* ---------- /api/now (app.ts: reading, today, summary(), outage, health) ---------- */
  const T = day(today), last = T.at(-1);
  const site = {
    name: 'Home', installed: `${INSTALL_YEAR}-06-15T09:00:00-05:00`, utility: 'Pedernales Electric Cooperative', firmware: '25.10.1',
    batteryCount: 2, batteries: [{ name: 'Powerwall 2', kwh: 13.5, kw: 5 }, { name: 'Powerwall 2', kwh: 13.5, kw: 5 }],
    capacityKwh: NAMEPLATE, maxPowerKw: MAX_KW, measuredKwh: MEASURED_KWH, modelKwh: CAP_KWH, reservePct: RESERVE, mode: 'self_consumption', stormWatch: true,
    solar: { ...SOLAR, year: 6, warrantedDcPct: 96.75 },
  };
  const cronRec = (at, ms, slow) => ({ at, ms, ok: true, slowest: { name: slow, ms: Math.round(ms * 0.6) }, errors: 0 });
  const nowP = {
    reading: { ts: now - 40e3, solarKw: r3(last.solar), homeKw: r3(last.home), batteryKw: r3(last.battery), gridKw: r3(last.grid), soc: last.soc,
      gridStatus: 'Active', islandStatus: 'on_grid', stormActive: false },
    today: totalsOf(T), site, outage: { active: false },
    health: { lastLive: now - 40e3, lastHistory: now - 4 * 60e3, stale: false, liveError: null, errors: { siteInfo: null, lastHistory: null, lastBackups: null, live: null },
      crons: { sync: cronRec(atLocal(today, 5.25), 41200, 'learn'), pool: cronRec(atLocal(yday, 20.25), 6100, 'plan'), nest: cronRec(now - 3 * 60e3, 2300, 'sampling') } },
  };

  /* ---------- /api/day (app.ts: buckets, peaks, soe, totals) ---------- */
  const dayP = { date: today, buckets: T.map(b => ({ t: b.t, solar: b.solar, home: b.home, grid: b.grid, battery: b.battery })),
    peaks: { solarKw: Math.max(0, ...T.map(b => b.solar)), homeKw: Math.max(0, ...T.map(b => b.home)), inflated: 0 }, soe: soeOf(T), totals: totalsOf(T) };

  /* ---------- /api/daily?days=400 (from today − 399; today's partial day is included, as the route's day >= from returns it) ---------- */
  const dailyDays = Array.from({ length: 400 }, (_, i) => addDays(today, i - 399));
  const daily = dailyDays.map(row), byDate = new Map(daily.map(r => [r.date, r]));

  /* ---------- /api/monthly?months=13 (month, days, kwhCols), oldest first ---------- */
  const monthly = [];
  for (const r of daily) { const m = r.date.slice(0, 7); let x = monthly.find(y => y.month === m); if (!x) monthly.push(x = { month: m, days: 0, solar: 0, home: 0, import: 0, export: 0, charge: 0, discharge: 0 });
    x.days++; for (const k of ['solar', 'home', 'import', 'export', 'charge', 'discharge']) x[k] += r[k]; }
  for (const m of monthly) for (const k of ['solar', 'home', 'import', 'export', 'charge', 'discharge']) m[k] = r2(m[k]);
  const monthlyP = monthly.slice(-13);

  /* ---------- /api/profile?days=14 (app.ts: days, hours[{hour, home, solar}], conf, scale, correction) ---------- */
  const pDays = between(addDays(today, -14), today);
  const hourly = (d, f) => { const a = Array(24).fill(0); for (const b of day(d)) a[Math.floor(b.t)] += f(b) / 12; return a; };
  const pHome = pDays.filter(d => !TRIP_DAYS.has(d)).map(d => hourly(d, b => b.home)), pSolar = pDays.map(d => hourly(d, b => b.solar));
  const profile = {
    days: 14,
    hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, home: r3(sum(pHome.map(a => a[h])) / pDays.length), solar: r3(sum(pSolar.map(a => a[h])) / pDays.length) })),
    conf: { 'fc48.solar': 'learned', 'fc48.home': 'estimated', 'fc48.soc': 'learning' },
    scale: { [today]: 1.04, [addDays(today, 1)]: 0.98, [addDays(today, 2)]: 0.95 },   // learn/homeModel.ts dayScales
    correction: { solar: { 'h1-6': 1, 'h7-24': 0.97, 'h25-48': 0.95 }, home: { 'h1-6': 1.02, 'h7-24': 1.01, 'h25-48': 1 } },   // learn/bias.ts biasFactors
  };

  /* ---------- /api/grid-days?days=30 (app.ts: dates, solar[day][hour] kWh, soc[day][hour] mean %; null where no data) ---------- */
  const gDates = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
  const gridDays = { dates: gDates,
    solar: gDates.map(d => Array.from({ length: 24 }, (_, h) => { const bs = day(d).filter(b => Math.floor(b.t) === h); return bs.length ? r2(sum(bs.map(b => b.solar)) / 12) : null; })),
    soc: gDates.map(d => Array.from({ length: 24 }, (_, h) => { const ss = day(d).filter(b => Math.floor(b.t) === h && b.k % 3 === 2).map(b => b.soc); return ss.length ? r2(sum(ss) / ss.length) : null; })) };

  /* ---------- /api/overnight?days=60 (breakdown.ts overnightSplit: [{date, kw, base, ac, pump, split}]) ---------- */
  const overnight = between(addDays(today, -60), addDays(today, 1)).map((d, i) => {
    const bs = day(d).filter(b => b.t >= 1 && b.t < 5), kw = r3(sum(bs.map(b => b.home)) / bs.length), quiet = [...bs.map(b => b.home - b.ac)].sort((a, b) => a - b)[Math.floor(bs.length * 0.1)];
    const split = i >= 14;   // the earliest nights predate the Nest readings: not split
    return split ? { date: d, kw, base: r3(quiet), ac: r3(sum(bs.map(b => b.ac)) / bs.length), pump: 0, split } : { date: d, kw, base: r3(Math.min(kw, quiet)), ac: null, pump: null, split };
  });

  /* ---------- /api/outages (app.ts: backup_events, newest first; ts is the Fleet API's local string) ---------- */
  const outages = [
    { ts: rfc(atLocal(addDays(today, -23), 16.4)), duration_s: 1260 },
    { ts: rfc(atLocal(addDays(today, -96), 3.2)), duration_s: 5400 },
    { ts: rfc(atLocal(addDays(today, -160), 18.75)), duration_s: 420 },
    { ts: rfc(atLocal(addDays(today, -300), 7.1)), duration_s: 11880 },
  ];

  /* ---------- /api/records (records.ts recordsFor) ---------- */
  const past = daily.filter(r => r.date < today), best = (f, desc) => past.reduce((a, r) => (desc ? f(r) > f(a) : f(r) < f(a)) ? r : a);
  const bS = best(r => r.solar, true), bH = best(r => r.home, true), bI = best(r => r.import, false);
  const records = {
    bestSolarDay: { date: bS.date, kwh: r1(bS.solar) }, biggestUsageDay: { date: bH.date, kwh: r1(bH.home) }, lowestImportDay: { date: bI.date, kwh: r1(bI.import) },
    // lifetime totals: the back-filled history to the install year plus the 400 days generated here
    totals: { since: `${INSTALL_YEAR}-06-15`, solar: r2(sum(daily.map(r => r.solar)) + 61240.5), home: r2(sum(daily.map(r => r.home)) + 70110.25), import: r2(sum(daily.map(r => r.import)) + 21980.4),
      export: r2(sum(daily.map(r => r.export)) + 12210.8), charge: r2(sum(daily.map(r => r.charge)) + 18040.1), discharge: r2(sum(daily.map(r => r.discharge)) + 16770.6) },
    batteryFullDays: { days: daily.filter(r => r.socMax >= 99).length + 1210, of: daily.length + 1800 },
    longestOutage: { ts: outages[3].ts, duration_s: outages[3].duration_s }, outages: outages.length,
  };

  /* ---------- /api/reconcile (reconcile.ts: each bill against Tesla's totals over the same dates, and the same dates last year) ---------- */
  const tesla = (from, to) => { const ds = between(from, to).filter(d => byDate.has(d) || d < today);
    const rs = ds.map(d => byDate.get(d) ?? row(d)), k = f => (rs.length ? Math.round(sum(rs.map(f)) * 10) / 10 : null);
    return { days: rs.length, solarKwh: k(r => r.solar), homeKwh: k(r => r.home), importKwh: k(r => r.import), exportKwh: k(r => r.export), chargeKwh: k(r => r.charge), dischargeKwh: k(r => r.discharge) }; };
  const bill = (from, to, billDate, lyKwh, skew) => {
    const t = tesla(from, to), days = Math.round((Date.parse(to) - Date.parse(from)) / D);
    const delivered = Math.round(t.importKwh * skew), received = Math.round(t.exportKwh);
    const charges = [
      { label: 'Service Availability Charge', kwh: null, rate: null, amount: TARIFF.fixedMonthly },
      { label: 'Delivery Charge', kwh: delivered, rate: 0.05, amount: r2(delivered * 0.05) },
      { label: 'Power Cost Charge', kwh: delivered, rate: 0.04, amount: r2(delivered * 0.04) },
      { label: 'Distributed Generation Credit', kwh: received, rate: -0.05, amount: r2(-received * 0.05) },
    ];
    const preFee = sum(charges.filter(c => c.amount > 0).map(c => c.amount));
    charges.push({ label: 'Franchise Fee', kwh: null, rate: null, amount: r2(preFee * TARIFF.franchisePct) });
    const total = r2(sum(charges.map(c => c.amount)));
    const ly = tesla(addDays(from, -365), addDays(to, -365));
    const gap = t.importKwh != null && delivered ? Math.round((t.importKwh - delivered) / delivered * 1000) / 10 : null;
    return {
      billDate, period: { from, to, days }, total, tariff: { ...TARIFF }, charges,
      pec: { deliveredKwh: delivered, receivedKwh: received, lastYearKwh: lyKwh },
      tesla: t, lastYear: ly, coverage: Math.round(t.days / days * 100) / 100, importGapPct: gap,
      checks: [
        { id: 'meter', ok: gap == null || Math.abs(gap) <= 5, label: 'Meter matches Tesla', detail: `PEC billed ${delivered} kWh bought; Tesla measured ${Math.round(t.importKwh)} kWh (${gap > 0 ? '+' : ''}${gap}%).` },
        { id: 'export', ok: Math.abs(t.exportKwh - received) <= Math.max(5, received * 0.05), label: 'Export credit complete', detail: `PEC credited ${received} kWh sent; Tesla measured ${Math.round(t.exportKwh)} kWh.` },
        { id: 'math', ok: true, label: 'Bill adds up', detail: `Line items sum to $${total.toFixed(2)}.` },
      ],
      solarShareOfHome: t.homeKwh ? Math.round((t.homeKwh - (t.importKwh ?? 0)) / t.homeKwh * 100) : null,
      withoutSolarCost: Math.round((TARIFF.fixedMonthly + TARIFF.discounts + t.homeKwh * TARIFF.importRateAllIn) * 100) / 100,
    };
  };
  const p2to = addDays(today, -15), p2from = addDays(p2to, -31), p1from = addDays(p2from, -30);
  const reconcile = [bill(p1from, p2from, addDays(p2from, 4), 1180, 1.02), bill(p2from, p2to, addDays(p2to, 4), 1040, 0.98)];

  /* ---------- /api/ercot (watch.ts ercotNow) ---------- */
  const ercot = { condition: 'normal', title: 'Normal Conditions', note: 'There is enough power for current demand.', eea: 0, demandMw: 54210, capacityMw: 68930, at: rfc(now - 5 * 60e3) };

  /* ---------- /api/status (app.ts: connected, siteId, lastLive, lastHistory, backfill {daysDone, deep: deepBackfill.ts deepStatus}) ---------- */
  const status = { connected: true, siteId: SITE_ID, lastLive: now - 40e3, lastHistory: now - 4 * 60e3,
    backfill: { daysDone: 2310, deep: { from: `${INSTALL_YEAR}-06-15`, through: addDays(today, -400), daysTotal: 1910, daysDone: 1910, done: true } } };

  /* ---------- /api/settings (app.ts: the owner's settings:owner plus location: site.ts exactLocation; fake coordinates) ---------- */
  const settings = {
    calm: false, ownerName: 'Test Owner', alerts: { baseline: false, strip: true, digest: true },
    pool: { autopilot: 'auto', turnoverGoal: 3, skimHours: 1 },
    ac: { autopilot: 'auto', presence: 'home', dayF: 78, nightF: 77, precoolDepth: 2, driftF: 1, band: { homeLo: 76, homeHi: 79, nightLo: 77, nightHi: 77 } },
    powerwall: { rules: { reserve: 'suggest', storm: 'suggest', export: 'suggest' }, reserveFloorPct: 20 },
    location: { ...LOCATION },
  };

  /* ---------- /api/flows?range=day (flows.ts flowsFor; every bucket carries Tesla's per-path split, so `measured`) ---------- */
  const paths = { solarHome: 0, solarBatt: 0, solarGrid: 0, gridHome: 0, gridBatt: 0, battHome: 0, battGrid: 0 };
  for (const b of T) {
    const s = b.solar / 12, h = b.home / 12, c = Math.max(0, -b.battery) / 12, d = Math.max(0, b.battery) / 12, sh = Math.min(s, h), sb = Math.min(Math.max(s - sh, 0), c);
    paths.solarHome += sh; paths.solarBatt += sb; paths.solarGrid += Math.max(s - sh - sb, 0);
    const bh = Math.min(d, Math.max(h - sh, 0)); paths.battHome += bh; paths.gridHome += Math.max(h - sh - bh, 0);
    paths.gridBatt += Math.max(c - sb, 0); paths.battGrid += Math.max(d - bh, 0);
  }
  const FROM = { solarHome: ['solar', 'home'], solarBatt: ['solar', 'battery'], solarGrid: ['solar', 'grid'], gridHome: ['grid', 'home'], gridBatt: ['grid', 'battery'], battHome: ['battery', 'home'], battGrid: ['battery', 'grid'] };
  const tt = totalsOf(T), homeFlow = r2(paths.solarHome + paths.battHome + paths.gridHome);
  const poolK = r2(sum(T.map(b => b.pool)) / 12), acK = r2(sum(T.map(b => b.ac)) / 12);
  const flows = {
    range: 'day', from: today, to: today, days: 1, dataDays: 1, buckets: T.length, splitBuckets: T.length, method: 'measured',
    ribbons: Object.keys(paths).map(id => ({ id, from: FROM[id][0], to: FROM[id][1], kwh: r2(paths[id]), estimated: false })),
    totals: tt, residual: { home: r2(tt.home - homeFlow), export: r2(tt.export - paths.solarGrid - paths.battGrid) },
    unaccounted: r2(tt.home - homeFlow + tt.export - paths.solarGrid - paths.battGrid),
    home: { kwh: homeFlow,
      pool: { kwh: poolK, source: 'readings', coverage: 0.94, rpm: 1500, watts: 172, kwhPerDay: 3.4 },   // appliances/pool.ts poolKwhBetween (perDay left out)
      ac: { kwh: acK, source: 'readings', days: 1, readingDays: 1, modelDays: 0, acKw: 3.2, acKwSource: 'learned', slope: 2.4 },   // appliances/ac.ts acKwhBetween
      rest: Math.max(0, r2(homeFlow - poolK - acK)) },
    rate: { importRateAllIn: TARIFF.importRateAllIn, exportCredit: TARIFF.exportCredit },
    money: { importUsd: r2(tt.import * TARIFF.importRateAllIn), exportCreditUsd: r2(tt.export * TARIFF.exportCredit) },
  };

  /* ---------- /api/breakdown?range=week (breakdown.ts breakdownFor) ---------- */
  const wk = between(addDays(today, -7), today).map(row), wkHome = r1(sum(wk.map(r => r.home)) / wk.length);
  const part = (id, kwh, conf, extra = {}) => ({ id, kwh, share: Math.round(kwh / wkHome * 100), conf, ...extra });
  const bAc = r1(wkHome * 0.31), bOn = 13.2, bLoad = 2.1, bBig = 1.4, bPool = 3.4;
  const breakdown = { range: 'week', from: addDays(today, -7), to: yday, days: 7, spanDays: 8, homeKwh: wkHome,
    parts: [
      part('ac', bAc, 'measured', { hours: 4.2, kw: 3.2, heatHours: 0, heatKw: null }),
      part('alwaysOn', bOn, 'measured', { kw: 0.55 }),
      part('load:1', bLoad, 'learned', { name: 'Water heater', hue: 0, kw: 4.5, minutes: 25 }),
      part('big', bBig, 'estimated', { unnamed: 1, perDay: 0.6, minutes: [15, 40], burstKw: 2.8 }),
      part('pool', bPool, 'measured'),
      part('other', Math.max(0, r1(wkHome - bAc - bOn - bLoad - bBig - bPool)), 'estimated'),
    ],
    bursts: [],
    trend: monthlyP.map((m, i) => ({ month: m.month, kw: r2(0.5 + 0.08 * Math.cos(2 * Math.PI * (i - 9) / 12)) })),
  };

  /* ---------- /api/loads (loads.ts loadClusters: at, day, days, since, clusters, unsorted) ---------- */
  const hist = from => Array.from({ length: 24 }, (_, h) => r2(Math.max(0, Math.cos((h - from) / 24 * 2 * Math.PI)) ** 2));
  const loads = { at: atLocal(today, 5.3), day: today, days: 30, since: addDays(today, -58), clusters: [
    { sig: 'k3m1', labelId: 1, name: 'Water heater', dismissed: false, hue: 0, kw: 4.5, minutes: 25, daypart: null, count: 96, days: 30, kwhPerDay: 2.1, perDay: 3.2,
      hist: hist(18), window: null, suggestion: null, badge: 'learned', overlap: 0.12, found: true },
    { sig: 'k4m2', labelId: null, name: null, dismissed: false, hue: null, kw: 5.2, minutes: 55, daypart: null, count: 11, days: 8, kwhPerDay: 0.9, perDay: 0.37,
      hist: hist(20), window: { from: 18, to: 22 }, suggestion: { name: 'Dryer', text: 'Looks like the dryer.' }, badge: 'estimated', overlap: 0.3, found: true },
    { sig: 'k1m2', labelId: null, name: null, dismissed: false, hue: null, kw: 2.1, minutes: 70, daypart: null, count: 4, days: 3, kwhPerDay: 0.2, perDay: 0.13,
      hist: hist(22), window: { from: 21, to: 0 }, suggestion: null, badge: 'learning', overlap: 0.25, found: false },
  ], unsorted: { count: 9, kwhPerDay: 0.31 } };

  /* ---------- /api/spare (spare.ts spareHistory: months, days, exportKwh, now) ---------- */
  const spMonths = monthly.slice(-12).map(m => ({ month: m.month, days: daily.filter(r => r.date.slice(0, 7) === m.month && (r.socMax >= 95 || r.export > 2)).length, exportKwh: Math.round(m.export) }));
  const spare = { months: spMonths, days: sum(spMonths.map(m => m.days)), exportKwh: sum(spMonths.map(m => m.exportKwh)),
    now: { exportW: Math.round(Math.max(0, -last.grid) * 1000), soc: Math.round(last.soc), surplusW: Math.round((last.solar - last.home) * 1000), full: last.soc >= 95, spare: last.soc >= 95 && -last.grid >= 0.3 } };

  /* ---------- /api/capacity (capacity.ts summarize) ---------- */
  const capacity = { measuredKwh: MEASURED_KWH, nameplateKwh: NAMEPLATE, count: 12, countAll: 41, since: addDays(today, -380),
    months: monthlyP.map((m, i) => ({ month: m.month, kwh: r1(25.6 - i * 0.04), n: 3 + (i % 3) })), range: [25.1, 25.6], fade: null, at: atLocal(today, 5.2) };

  /* ---------- /api/soiling (soiling.ts soiling(): owner shape, with dollarsPerMonth) ---------- */
  const clearPts = between(addDays(today, -40), today).filter(d => cloudOf(d) < 0.2).map((d, i) => ({ day: d, y: r2(6.4 - i * 0.03) }));
  const lastRainDay = between(addDays(today, -40), today).filter(d => rainOf(d) >= 5).at(-1) ?? addDays(today, -19);
  const soiling = { state: 'getting', lossPct: 3.6, lossSd: 1.2, score: 36, kwhPerDay: 1.5, dollarsPerMonth: 4,
    ref: { from: clearPts[0]?.day ?? addDays(today, -30), to: clearPts[2]?.day ?? addDays(today, -28), y: 6.4, after: 'rain' }, now: 6.17, resetOn: lastRainDay, resetBy: 'rain',
    lastRain: { day: lastRainDay, mm: rainOf(lastRainDay) || 12.4, daysAgo: Math.round((Date.parse(today) - Date.parse(lastRainDay)) / D) }, nextRain: null, clearSince: clearPts.length,
    points: clearPts, rains: between(addDays(today, -60), addDays(today, 3)).filter(d => rainOf(d) >= 5).map(d => ({ day: d, mm: rainOf(d) })), at: atLocal(today, 5.3) };

  /* ---------- /api/events (app.ts: id, type, day, note, created_at; newest day first) ---------- */
  const events = [
    { id: 7, type: 'filter_cleaned', day: addDays(today, -12), note: null, created_at: new Date(atLocal(addDays(today, -12), 10)).toISOString() },
    { id: 6, type: 'cleaned', day: addDays(today, -64), note: 'Rinsed from the ground', created_at: new Date(atLocal(addDays(today, -64), 9)).toISOString() },
    { id: 4, type: 'note', day: addDays(today, -90), note: 'New thermostat schedule', created_at: new Date(atLocal(addDays(today, -90), 20)).toISOString() },
  ];

  /* ---------- /api/models (learn/api.ts modelsReport) ---------- */
  const model = (id, label, unit, abs, tier, n, need, mape, note, help = null) => {
    const T2 = { measured: 'm', learned: 'l', estimated: 'e', learning: 'n', unscored: 'u', dormant: 'u' };
    const ds = Array.from({ length: Math.min(n, 30) }, (_, i) => { const d = addDays(today, i - Math.min(n, 30)), a = r2(abs ? 60 + 20 * noise(i) : 30 + 15 * noise(i + 40)), p = r2(a * (1 + (noise(i + 7) - 0.5) * 0.2));
      return { day: d, p, a, err: r3(p - a), ape: abs ? null : r3(Math.abs(p - a) / a), n: 1 }; });
    return { id, label, unit, abs, dot: tier === 'dormant' ? 'unscored' : tier, t: T2[tier], v: `${tier}${mape != null ? ` · ±${mape}${abs ? ' pts' : '%'}` : ''}`, tier,
      confidence: tier === 'learned' ? 0.82 : tier === 'estimated' ? 0.55 : 0.2, n, need, mape: abs ? null : mape, mae: abs ? mape : (mape != null ? r2(mape / 10) : null), mad: abs ? mape : null,
      bias: mape != null ? r1((noise(n) - 0.5) * 6) : null, base: ds.length ? r2(sum(ds.map(x => x.a)) / ds.length) : null, spark: mape != null ? [14.2, 12.8, 11.9, 12.4, 10.6, 9.8, 9.1, mape] : [],
      improvement: tier === 'learned' ? 0.18 : null, bands: id.startsWith('fc48.') ? { 'h1-6': 0.8, 'h7-24': 1.6, 'h25-48': 2.4 } : undefined,
      bandsPct: id === 'fc48.solar' || id === 'fc48.home' ? { 'h1-6': 4.1, 'h7-24': 7.9, 'h25-48': 11.2 } : undefined, version: 1, relearningSince: null, note, help,
      why: tier === 'dormant' ? 'dormant until the cooling season (May)' : null,
      scores: { '7d': mape != null ? { mae: r2(mape / 10), mape: r3(mape / 100), bias: 0.01, n: Math.min(n, 7) } : null, '30d': mape != null ? { mae: r2(mape / 10), mape: r3(mape / 100), bias: 0.01, n } : null, '365d': null },
      days: ds };
  };
  const models = {
    summary: { learned: 2, measured: 1, total: 8, dormant: 1, active: 7, improvement: 0.18, headline: 'Forecasts are 18% more accurate than 8 weeks ago.' },
    lastRun: { at: atLocal(today, 5.4), ms: 9100, queries: 38, scored: 6, predicted: 52, errors: [], waiting: ['bill.cycleImport'] },
    models: [
      model('fc48.solar', 'Next 48 h solar', 'kWh', false, 'learned', 30, 14, 8.4, '30 days scored'),
      model('fc48.home', 'Next 48 h home use', 'kWh', false, 'learned', 28, 14, 9.6, '28 days scored'),
      model('fc48.soc', 'Next 48 h battery %', 'pts', true, 'estimated', 12, 14, 6.2, '12 days scored'),
      model('pool.kwhDay', 'Pool kWh/day', 'kWh', false, 'measured', 20, 14, 3.1, '20 days scored'),
      model('ac.shifted', 'AC kWh shifted onto solar', 'kWh', false, 'dormant', 0, 10, null, 'dormant until the cooling season (May)', null),
      model('ac.eveningAvoided', 'AC evening kWh avoided', 'kWh', false, 'estimated', 0, 10, null, 'estimated from the plan until control days measure it',
        'needs control days: 1 in 5 hot, sunny days holds the comfort band so pre-cool days can be compared'),
      model('bill.cycleImport', 'Billing-cycle kWh bought', 'kWh', false, 'learning', 1, 3, null, '1 cycles scored', 'needs a parsed bill and a few finished billing cycles'),
      model('home.alwaysOn', 'Always-on load (1–5 AM)', 'kW', false, 'unscored', 0, 14, null, 'no scored days yet', 'needs two more weeks of nights'),
    ],
    anomalies: [{ id: 3, kind: 'panel.low@r2c7', day: addDays(today, -2), severity: 'warn', openedAt: atLocal(addDays(today, -2), 5.4), title: 'Row 2 · 7 is running low',
      body: 'It made 88% of the median panel for 3 clear days.', detail: { title: 'Row 2 · 7 is running low', body: 'It made 88% of the median panel for 3 clear days.', action: 'open_panels' } }],
    log: [{ at: atLocal(today, 5.4), day: today, text: 'Home model refitted on 365 days', delta: '+0.1 kWh/°F' }, { at: atLocal(yday, 5.4), day: yday, text: 'Solar forecast bias settled', delta: '−3%' }],
    ac: { trim: null, measured: null, warmupFPerH: 0.6, control: { every: 5, eligibleDays: 23, nextIn: 2, today: null } },
    home: {   // learn/homeModel.ts homeForecast
      fit: { a: 31.2, b: 1.4, c: 0.9, tc: 82, th: 50, n: 14, points: between(addDays(today, -14), today).map(d => ({ day: d, high: highOf(d), low: lowOf(d), kwh: byDate.get(d).home })),
        year: { n: 351, heatDays: 61, from: addDays(today, -366), to: yday, rmse: 4.1, a: 30.4 } },
      scale: profile.scale, today: { high: highOf(today), low: lowOf(today) },
      tomorrow: { day: addDays(today, 1), high: highOf(addDays(today, 1)), low: lowOf(addDays(today, 1)), kwh: 38.6 },
      check: [4, 3, 2, 1].map(i => addDays(today, -i)).map(d => ({ day: d, high: highOf(d), used: byDate.get(d).home, old: r2(byDate.get(d).home * 0.94), new: r2(byDate.get(d).home * 1.01) })),
    },
  };

  /* ---------- /api/pvs/panels (panels.ts panelsDay, plus the owner's `alerts` from panelAlerts) ---------- */
  const pvsB = T.filter(b => b.solar > 0.05), times = pvsB.map(b => b.epoch);
  const factor = (r, c) => (r === 2 && c === 7 ? 0.88 : 1 + (noise(r * 10 + c) - 0.5) * 0.05);
  const pan = [];
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 10; c++) {
    const f = factor(r, c), sp = pvsB.map(b => r3(b.solar / 30 * f)), kw = sp.at(-1) ?? null, kwh = r3(sum(sp) / 12);
    pan.push({ id: `r${r}c${c}`, row: r, col: c, name: `Row ${r} · ${c}`, reporting: true, at: rfc(times.at(-1)), ageS: Math.round((now - times.at(-1)) / 1000),
      kw, kwDc: kw == null ? null : r3(kw / 0.965), tempC: r1(44 + noise(r * 7 + c) * 4), kwh, kwhSource: 'lifetime', maxTempC: r1(49 + noise(r * 9 + c) * 4), sharePct: 0, pctNow: 0, pctToday: 0,
      flagged: r === 2 && c === 7, spark: sp });
  }
  const arrayKwh = sum(pan.map(p => p.kwh)), medKwh = median(pan.map(p => p.kwh)), medKw = median(pan.map(p => p.kw));
  for (const p of pan) { p.sharePct = r2(p.kwh / arrayKwh * 100); p.pctNow = r1(p.kw / medKw * 100); p.pctToday = r1(p.kwh / medKwh * 100); }
  const got = [...pan].sort((a, b) => a.pctToday - b.pctToday), hot = [...pan].sort((a, b) => b.maxTempC - a.maxTempC)[0];
  const panels = {
    date: today, today: true, timeZone: TZ, at: new Date(now).toISOString(), bucketMinutes: 5, times,
    layout: { learned: true, mapped: 30, expected: 30, unmapped: 0 },
    relay: { lastPoll: rfc(times.at(-1)), ageS: Math.round((now - times.at(-1)) / 1000), silent: false, daylight: true, silentMin: 0, heardAt: new Date(now - 60e3).toISOString(), cause: null, note: null,
      pvs: { status: 'ok', http: 200, error: null, uptimeS: 86400, at: new Date(now - 60e3).toISOString() } },
    since: addDays(today, -21), days: 22, sunDown: false, reporting: 30,
    now: { medianKw: r3(medKw), medianKwDc: r3(medKw / 0.965), medianConvPct: 96.5, arrayKw: r3(sum(pan.map(p => p.kw))), weakest: { id: got[0].id, name: got[0].name, pct: got[0].pctNow } },
    totals: { kwh: r3(arrayKwh), medianKwh: r3(medKwh), spread: { loPct: got[0].pctToday, hiPct: got.at(-1).pctToday }, hottest: { id: hot.id, name: hot.name, tempC: hot.maxTempC } },
    lowest: got.slice(0, 3).map(p => ({ id: p.id, name: p.name, kwh: p.kwh, pct: p.pctToday })),
    notReporting: [], panels: pan, medianSeries: pvsB.map(b => r3(b.solar / 30)),
    anomalies: [{ kind: 'panel.low@r2c7', id: 'r2c7', name: 'Row 2 · 7', day: addDays(today, -2), openedAt: atLocal(addDays(today, -2), 5.4), title: 'Row 2 · 7 is running low',
      body: 'It made 88% of the median panel for 3 clear days.', nLow: 3, window: 7, days: [{ day: addDays(today, -4), pct: 88.4 }, { day: addDays(today, -3), pct: 87.9 }, { day: addDays(today, -2), pct: 88.1 }],
      diag: { kind: 'dc', lead: 'Less light reaching it', text: 'Its DC input is low while its conversion is normal: shade or dirt on that panel.' } }],
    alerts: { 'panel.low@r2c7': { pushed: true, at: new Date(atLocal(addDays(today, -2), 7)).toISOString() } },
  };

  /* ---------- /api/auth/me, /api/auth/devices, /api/share (app.ts, auth.ts listOwnerSessions, share.ts listShares) ---------- */
  const me = { mode: 'single', owner: true, user: null, site: { id: SITE_ID, name: 'Home' } };
  const devices = [
    { id: 'a1b2c3', label: 'iPhone · Safari', createdAt: new Date(now - 40 * D).toISOString(), lastSeen: new Date(now - 30e3).toISOString(), current: true },
    { id: 'd4e5f6', label: 'Mac · Chrome', createdAt: new Date(now - 90 * D).toISOString(), lastSeen: new Date(now - 2 * D).toISOString(), current: false },
  ];
  const share = [
    { id: 'sh-live', label: 'Neighbour', createdAt: new Date(now - 5 * D).toISOString(), expiresAt: new Date(now + 25 * D).toISOString(), revokedAt: null,
      openedCount: 3, lastOpenedAt: new Date(now - D).toISOString(), lastUa: 'iPhone · Safari', state: 'active' },
    { id: 'sh-old', label: 'Installer', createdAt: new Date(now - 20 * D).toISOString(), expiresAt: new Date(now - 13 * D).toISOString(), revokedAt: null,
      openedCount: 1, lastOpenedAt: new Date(now - 19 * D).toISOString(), lastUa: 'Mac · Chrome', state: 'expired' },
  ];

  /* ---------- /api/alerts?limit= (notify.ts listAlerts: unread, alerts newest first) ---------- */
  const digestWeek = mondayOf(addDays(today, -7));
  const alerts = { unread: 2, alerts: [
    { id: 41, kind: 'approval', title: 'Backup reserve for tonight: 30%?', body: 'Tonight the Powerwalls reach the 20% reserve around 04:00 and the house would buy about 2.1 kWh from PEC before the sun is back; 30% keeps more for an outage.',
      data: { rule: 'reserve', value: 30, current: 20 }, createdAt: new Date(now - 2 * H).toISOString(), readAt: null },
    { id: 40, kind: 'grid', title: 'Grid is back', body: 'PEC came back after 21 minutes. The Powerwalls carried the house.', data: { minutes: 21 }, createdAt: new Date(atLocal(addDays(today, -3), 16.8)).toISOString(), readAt: new Date(atLocal(addDays(today, -3), 17)).toISOString() },
    { id: 39, kind: 'digest', title: 'Your week: 78% from sunshine', body: 'Solar 290 kWh, home 300 kWh, bought 66 kWh.', data: { week: isoWeek(digestWeek) }, createdAt: new Date(atLocal(addDays(today, -2), 7)).toISOString(), readAt: null },
    { id: 38, kind: 'panel', title: 'Row 2 · 7 is running low', body: 'It made 88% of the median panel for 3 clear days.', data: { anomaly: 'panel.low@r2c7' }, createdAt: new Date(atLocal(addDays(today, -2), 7)).toISOString(), readAt: new Date(atLocal(addDays(today, -2), 8)).toISOString() },
  ] };

  /* ---------- /api/changed?scope=day (learn/changed.ts changedFor; the default date is yesterday) ---------- */
  const changed = changedClean(now);

  /* ---------- /api/digest (digest.ts buildDigest for last week, stored) ---------- */
  const wkRows = d0 => Array.from({ length: 7 }, (_, i) => byDate.get(addDays(d0, i)) ?? row(addDays(d0, i)));
  const wTot = rs => { const h = sum(rs.map(r => r.home)), i = sum(rs.map(r => r.import));
    return { days: rs.length, solarKwh: r1(sum(rs.map(r => r.solar))), homeKwh: r1(h), importKwh: r1(i), exportKwh: r1(sum(rs.map(r => r.export))), sunsharePct: h > 0 ? Math.max(0, Math.min(100, Math.round((1 - i / h) * 100))) : null }; };
  const cw = wkRows(digestWeek), pw = wkRows(addDays(digestWeek, -7)), cur = wTot(cw), prev = wTot(pw), bw = cw.reduce((a, r) => r.solar > a.solar ? r : a);
  const digest = {
    week: isoWeek(digestWeek), from: digestWeek, to: addDays(digestWeek, 6), partial: false, builtAt: atLocal(addDays(digestWeek, 7), 7), totals: cur, lastWeek: prev,
    vsLastWeek: { solarKwh: r1(cur.solarKwh - prev.solarKwh), homeKwh: r1(cur.homeKwh - prev.homeKwh), importKwh: r1(cur.importKwh - prev.importKwh), exportKwh: r1(cur.exportKwh - prev.exportKwh), sunsharePts: cur.sunsharePct - prev.sunsharePct },
    bestSolarDay: { date: bw.date, kwh: r1(bw.solar) },
    powerwall: { fullDays: cw.filter(r => r.socMax >= 99).length, daysWithData: 7, lowestPct: Math.round(Math.min(...cw.map(r => r.socMin))) },
    autopilot: { pool: { applied: 6, suggested: 0, refused: 0, lines: ['Plan applied: Pool 10a–7p at 1,500 RPM', 'Spare solar: Pool up to 2,400 RPM while the Powerwalls are full'] },
      ac: { set: 11, refused: 1, lines: ['Pre-cool to 76° from 1 PM', 'Back to 78° at 5 PM'] }, powerwall: { sent: 0, refused: 0, suggested: 2, scopeMissing: 0 } },
    anomalies: { open: 1, openedThisWeek: 0, items: [{ kind: 'panel.low@r2c7', title: 'Row 2 · 7 is running low', severity: 'warn', day: addDays(today, -2) }] },
    confidence: { 'fc48.solar': 'learned', 'fc48.home': 'learned', 'fc48.soc': 'estimated', 'pool.kwhDay': 'measured', 'ac.shifted': 'dormant', 'ac.eveningAvoided': 'estimated', 'bill.cycleImport': 'learning', 'home.alwaysOn': 'unscored' },
    trips: [],
    changed: { scope: 'week', date: digestWeek, to: addDays(digestWeek, 6), baseline: { kind: 'week', days: 7 }, wx: { high: 90, baseHigh: 88 },
      home: { obs: cur.homeKwh, base: prev.homeKwh, delta: r1(cur.homeKwh - prev.homeKwh), parts: [{ id: 'weather', kwh: r1((cur.homeKwh - prev.homeKwh) * 0.6), conf: 'estimated' },
        { id: 'pool', kwh: 0.4, conf: 'measured' }, { id: 'unexplained', kwh: r1(cur.homeKwh - prev.homeKwh - r1((cur.homeKwh - prev.homeKwh) * 0.6) - 0.4), conf: null }] },
      import: { obs: cur.importKwh, base: prev.importKwh, delta: r1(cur.importKwh - prev.importKwh), parts: [{ id: 'home', kwh: r1(cur.homeKwh - prev.homeKwh), conf: null },
        { id: 'solar', kwh: r1(cur.importKwh - prev.importKwh - (cur.homeKwh - prev.homeKwh)), conf: 'measured' }], solar: { obs: cur.solarKwh, base: prev.solarKwh } },
      clean: true, notes: [] },
    stored: true,
  };

  /* ---------- /api/presence (appliances/presence.ts presenceFor) ---------- */
  const presence = { state: 'home', source: 'nest', since: atLocal(today, 6.5), until: null };

  /* ---------- /api/tesla/scopes (tesla/commands.ts teslaScopes) ---------- */
  const scopes = { connected: true, scopes: ['openid', 'offline_access', 'energy_device_data', 'energy_cmds'], energyCmds: true, source: 'token', relink: null };

  /* ---------- /api/powerwall/rules (powerwall.ts route: scope, floorPct, rules[], log, trip) ---------- */
  const pwLog = [
    { at: now - 2 * H, rule: 'reserve', command: 'backup', value: 30, result: 'suggested', reason: 'Tonight the Powerwalls reach the 20% reserve around 04:00 and the house would buy about 2.1 kWh from PEC before the sun is back; 30% keeps more for an outage.', source: 'auto' },
    { at: now - 9 * D, rule: 'storm', command: 'backup', value: 100, result: 'sent', reason: 'Severe Thunderstorm Warning for your area: raise the reserve to 100%.', source: 'owner' },
    { at: now - 8.6 * D, rule: 'storm', command: 'backup', value: 20, result: 'sent', reason: 'The storm has passed: back to your 20% reserve.', source: 'auto' },
  ];
  const pwRules = {
    scope: { energyCmds: true, relink: null }, floorPct: 20,
    rules: [
      { id: 'reserve', label: 'Backup reserve for tonight', mode: 'suggest',
        suggestion: { rule: 'reserve', command: 'backup', action: 'set', value: 30, current: 20, reason: pwLog[0].reason }, last: null },
      { id: 'storm', label: 'Reserve before a storm', mode: 'suggest',
        suggestion: { rule: 'storm', command: 'backup', action: 'none', value: null, current: 20, reason: 'No storm alert for your area and Storm Watch is idle.' }, last: pwLog[2] },
      { id: 'export', label: 'Grid export rule', mode: 'suggest',
        suggestion: { rule: 'export', command: 'grid_import_export', action: 'none', value: null, current: 'pv_only', reason: 'PEC credits an exported kWh at 54% of what an imported one costs, so energy in the Powerwalls is worth more used at home: export solar only.' }, last: null },
    ],
    log: pwLog, trip: null,
  };

  /* ---------- POST /api/sync (sync.ts syncSite) ---------- */
  const sync = { done: ['live', 'lastHistory'], filled: 0, remaining: 0, errors: [], ms: 812 };

  /* ---------- /api/whatif (app.ts; no panels or Powerwalls added: upgraded = baseline; owner settings carry no system price, so system is null) ---------- */
  const yr = daily.filter(r => r.date >= addDays(today, -365) && r.date < today), yImp = Math.round(sum(yr.map(r => r.import))), yExp = Math.round(sum(yr.map(r => r.export)));
  const ySol = Math.round(sum(yr.map(r => r.solar))), yHome = Math.round(sum(yr.map(r => r.home)));
  const replay = (imp, exp, sol, full) => ({ importKwh: imp, exportKwh: exp, solarKwh: sol, homeKwh: yHome, selfPowered: yHome ? Math.round((1 - imp / yHome) * 100) : 0, batteryFullDays: full,
    netCost: Math.round(imp * TARIFF.importRateAllIn - exp * TARIFF.exportCredit) });
  const base = replay(Math.round(yImp * 1.03), Math.round(yExp * 0.98), ySol, 214), none = replay(yHome, 0, 0, 0);
  const whatif = { days: yr.length, kwpNow: SOLAR.dcKw, acKw: SOLAR.acKw, panels: SOLAR.panels, panelWdc: SOLAR.panelWdc,
    assumptions: { panelW: 400, dollarsPerW: 2.75, powerwallCost: 11500, tariff: { ...TARIFF } },
    actual: { importKwh: yImp, exportKwh: yExp }, baseline: base, upgraded: { ...base }, noSystem: none, cost: 0, savesPerYear: 0, paybackYears: null, system: null,
    backupHoursEvening: { now: Math.round(CAP_KWH * 0.8 / 4.5), upgraded: Math.round(CAP_KWH * 0.8 / 4.5) } };

  /* ---------- /api/outage (outage.ts outageDetail) ---------- */
  const usable = r2(Math.max(0, last.soc) / 100 * CAP_KWH * 0.95), on = 0.55, poolKw = 0.35, acKw = 3.2, duty = 0.42, draw = r3(last.home);
  const rung = (id, label, below, kw) => ({ id, label, addKw: r3(kw - below), kw: r3(kw), hours: kw > 0 ? r3(usable / kw) : null });
  const ac2 = on + poolKw + acKw * duty, all = Math.max(ac2, draw);
  const island = loadKw => { let soc = last.soc / 100, emptyH = null, unmet = 0, min = soc, sunAdds = 0; const points = [];
    for (let k = 0; k < 48; k++) { const ms = now + k * H, d = dayOf(ms), h = hourOf(ms), s = r3(Math.min(SOLAR.acKw, gtiAt(d, h + 0.5) / 1000 * 8.1)), hh = loadKw, n = s - hh;
      const b = n > 0 ? -Math.min(n, MAX_KW, (1 - soc) * CAP_KWH / 0.95) : Math.min(-n, MAX_KW, soc * CAP_KWH * 0.95);
      soc = Math.max(0, Math.min(1, soc + (b < 0 ? -b * 0.95 : -b / 0.95) / CAP_KWH)); const u = n < 0 ? Math.max(0, hh - s - b) : 0; unmet += u; min = Math.min(min, soc);
      if (emptyH == null && u > 1e-6 && soc < 1e-9) emptyH = k + b / (hh - s); if (emptyH != null && k >= Math.ceil(emptyH) && k < Math.ceil(emptyH) + 24 && u < 1e-6) sunAdds++;
      points.push({ k, soc: r3(soc), s, h: r3(hh), b: r3(b), u: r3(u) }); }
    return { emptyH: emptyH == null ? null : r3(emptyH), emptyAt: emptyH == null ? null : Math.round(now + emptyH * H), sunAdds, minSoc: r3(min), unmetKwh: r2(unmet), points }; };
  const scen = kw => ({ drawKw: r3(kw), backupH: r3(usable / kw), island: island(kw) });
  const outage = {
    at: now, date: today, startHour: r3(hNow), readingAt: now - 40e3, soc: r1(last.soc), capacityKwh: CAP_KWH, measuredKwh: MEASURED_KWH, usableKwh: usable, reservePct: RESERVE, maxKw: MAX_KW, batteries: 2, drawKw: draw,
    loads: { alwaysOnKw: on, poolKw, poolRpm: 1500, acKw, acSource: 'measured', acDuty: duty, dutySource: 'nest', acHeat: false },
    ladder: [rung('on', 'Always-on', 0, on), rung('pool', '+ Pool pump', on, on + poolKw), rung('ac', '+ AC', on + poolKw, ac2), rung('else', '+ Everything else', ac2, all)],
    scenarios: { asis: scen(Math.max(draw, ac2)), noac: scen(on + poolKw + 0.4), noacpool: scen(on + 0.4) },
    solar: { tomorrowKwh: 41.8, cloudy: false, yieldK: 6.42 },
    outages: { list: outages.filter(o => o.ts.slice(0, 10) >= addDays(today, -365)), last: { ...outages[0] }, count12: outages.filter(o => o.ts.slice(0, 10) >= addDays(today, -365)).length, longest12: { ...outages[3] } },
    storm: { active: false, stormWatch: { enabled: true, active: false }, nws: [], ercot: { condition: 'normal', title: 'Normal Conditions', eea: 0, at: ercot.at } },
  };

  return {
    'now': nowP, 'day': dayP, 'daily': daily, 'monthly': monthlyP, 'profile': profile, 'grid-days': gridDays, 'overnight': overnight, 'records': records,
    'outages': outages, 'outage': outage, 'reconcile': reconcile, 'ercot': ercot, 'status': status, 'settings': settings, 'flows': flows, 'changed': changed,
    'breakdown': breakdown, 'loads': loads, 'spare': spare, 'capacity': capacity, 'soiling': soiling, 'events': events, 'models': models, 'pvs/panels': panels,
    'auth/me': me, 'auth/devices': devices, 'share': share, 'alerts': alerts, 'digest': digest, 'presence': presence, 'tesla/scopes': scopes,
    'powerwall/rules': pwRules, 'sync': sync, 'whatif': whatif,
  };
}

/* ======================= I-18 What changed (learn/changed.ts attribute + changedFor), yesterday against a typical weekday ======================= */
const changedBase = now => {
  const date = addDays(dayOf(now), -1);
  return { scope: 'day', date, to: date, baseline: { kind: 'weekday', days: 4 }, wx: { high: 91, baseHigh: 86 },
    import: { obs: 9.4, base: 5.2, delta: 4.2, parts: [{ id: 'home', kwh: 6.1, conf: null }, { id: 'solar', kwh: -1.9, conf: 'measured' }], solar: { obs: 41, base: 40 } } };
};
/** The split shown: parts add up to the change (owner: weather, AC, pool, always-on, unexplained). */
export function changedClean(now) {
  return { ...changedBase(now), home: { obs: 41.3, base: 35.2, delta: 6.1, parts: [
    { id: 'weather', kwh: 3.8, conf: 'estimated' }, { id: 'ac', kwh: 0.9, conf: 'measured' }, { id: 'pool', kwh: 1.2, conf: 'measured' },
    { id: 'alwaysOn', kwh: -0.2, conf: 'measured' }, { id: 'unexplained', kwh: 0.4, conf: null }] }, clean: true, notes: [] };
}
/** History not clean yet (changedFor empties home.parts; the totals and the bought split still go out). */
export function changedNotClean(now) {
  return { ...changedBase(now), home: { obs: 41.3, base: 35.2, delta: 6.1, parts: [] }, clean: false, notes: ['not-clean'] };
}

/* ======================= guests (server/src/redact.ts) ======================= */
/** redact.ts pick(): keys a rule doesn't name are dropped; `true` keeps primitives (and lists of them); 'veil' hides money. */
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const plain = v => v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every(plain));
function pick(v, rule) {
  if (v === undefined) return undefined;
  if (typeof rule === 'function') return rule(v);
  if (rule === 'veil') return v === null ? null : Array.isArray(v) ? [] : isObj(v) ? { veiled: true } : null;
  if (rule === true) return plain(v) ? v : null;
  if (Array.isArray(rule)) return Array.isArray(v) ? v.map(x => pick(x, rule[0])) : null;
  if (!isObj(v)) return null;
  const out = {};
  for (const [k, r] of Object.entries(rule)) if (Object.hasOwn(v, k) && v[k] !== undefined) out[k] = pick(v[k], r);
  return out;
}
const fixed = text => v => (v == null ? null : text);
const KWH = { solar: true, home: true, import: true, export: true, charge: true, discharge: true };
const ERR = { at: true, message: fixed('unavailable') };
const SOLAR_RULE = { module: true, panels: true, panelWdc: true, panelVaAc: true, microinverter: true, efficiencyPct: true, tempCoefPctPerC: true, moduleM: { w: true, h: true }, dcKw: true, acKw: true,
  year: true, warrantedDcPct: true, warranty: { years: true, dcYear1Pct: true, dcDeclinePctPerYear: true, acFloorPct: true, labourYears: true } };
const REPLAY = { importKwh: true, exportKwh: true, solarKwh: true, homeKwh: true, selfPowered: true, batteryFullDays: true };
const POS = { id: true, name: true };
const RULES = {
  'now': { reading: { ts: true, solarKw: true, homeKw: true, batteryKw: true, gridKw: true, soc: true, gridStatus: true, islandStatus: true, stormActive: true }, today: KWH,
    site: { name: fixed('Home'), batteryCount: true, batteries: [{ name: true, kwh: true, kw: true }], capacityKwh: true, measuredKwh: true, modelKwh: true, maxPowerKw: true, reservePct: true, mode: true, stormWatch: true, solar: SOLAR_RULE },
    outage: { active: true, since: true }, health: { lastLive: true, lastHistory: true, stale: true, liveError: fixed('unavailable'), errors: { siteInfo: ERR, lastHistory: ERR, lastBackups: ERR, live: ERR } } },
  'status': { connected: true, lastLive: true, lastHistory: true, backfill: { daysDone: true } },
  'daily': [{ date: true, ...KWH, socMin: true, socMax: true }],
  'monthly': [{ month: true, days: true, ...KWH }],
  'profile': { days: true, hours: [{ hour: true, home: true, solar: true }], conf: { 'fc48.solar': true, 'fc48.home': true, 'fc48.soc': true }, scale: true,
    correction: { solar: { 'h1-6': true, 'h7-24': true, 'h25-48': true }, home: { 'h1-6': true, 'h7-24': true, 'h25-48': true } } },
  'grid-days': { dates: true, solar: true, soc: true },
  'soiling': { state: true, lossPct: true, lossSd: true, score: true, kwhPerDay: true, ref: { from: true, to: true, y: true, after: true }, now: true, resetOn: true, resetBy: true,
    lastRain: { day: true, mm: true, daysAgo: true }, nextRain: { day: true, mm: true }, clearSince: true, points: [{ day: true, y: true }], rains: [{ day: true, mm: true }], at: true },
  'overnight': [{ date: true, kw: true, base: true, ac: true, pump: true, split: true }],
  'records': { bestSolarDay: { date: true, kwh: true }, biggestUsageDay: { date: true, kwh: true }, lowestImportDay: { date: true, kwh: true }, totals: { since: true, ...KWH },
    batteryFullDays: { days: true, of: true }, longestOutage: { ts: true, duration_s: true }, outages: true },
  'outages': [{ ts: true, duration_s: true }],
  'ercot': { condition: true, title: true, note: true, eea: true, demandMw: true, capacityMw: true, at: true },
  'whatif': { days: true, kwpNow: true, acKw: true, panels: true, panelWdc: true, assumptions: { panelW: true, dollarsPerW: 'veil' }, actual: { importKwh: true, exportKwh: true },
    baseline: REPLAY, upgraded: REPLAY, noSystem: REPLAY, savesPerYear: 'veil', system: () => ({ veiled: true }), backupHoursEvening: { now: true, upgraded: true } },
  'pvs/panels': { date: true, today: true, timeZone: true, at: true, bucketMinutes: true, times: true, layout: { learned: true, mapped: true, expected: true, unmapped: true },
    relay: { lastPoll: true, ageS: true, silent: true, daylight: true, silentMin: true, heardAt: true, cause: true, note: true }, since: true, days: true, sunDown: true, reporting: true,
    now: { medianKw: true, medianKwDc: true, medianConvPct: true, arrayKw: true, weakest: { ...POS, pct: true } },
    totals: { kwh: true, medianKwh: true, spread: { loPct: true, hiPct: true }, hottest: { ...POS, tempC: true } }, lowest: [{ ...POS, kwh: true, pct: true }],
    notReporting: [{ ...POS, at: true, lastKw: true, kwh: true, silentMin: true, pushAt: true }],
    panels: [{ ...POS, row: true, col: true, reporting: true, at: true, ageS: true, kw: true, kwDc: true, tempC: true, kwh: true, kwhSource: true, maxTempC: true, sharePct: true, pctNow: true, pctToday: true, flagged: true, spark: true }],
    medianSeries: true, anomalies: [{ kind: true, ...POS, day: true, openedAt: true, title: true, body: true, nLow: true, window: true, days: [{ day: true, pct: true }], diag: { kind: true, lead: true, text: true } }] },
  'changed': { scope: true, date: true, to: true, baseline: { kind: true, days: true }, wx: { high: true, baseHigh: true }, clean: true,
    home: { obs: true, base: true, delta: true, parts: v => (Array.isArray(v) ? v : []).filter(p => isObj(p) && ['weather', 'pool', 'other'].includes(p.id)).map(p => pick(p, { id: true, kwh: true, conf: true })) } },
};
/** redact.ts hourlyDay: /api/day's five-minute buckets summed into hours (kWh = the hour's mean kW), battery % the hour's mean. */
function hourlyDay(b) {
  const hours = new Map(), soc = new Map();
  for (const x of b.buckets) { const h = Math.floor(x.t), a = hours.get(h) ?? { solar: 0, home: 0, grid: 0, battery: 0 }; for (const k of ['solar', 'home', 'grid', 'battery']) a[k] += x[k] / 12; hours.set(h, a); }
  for (const x of b.soe) { const h = Math.floor(x.t); soc.set(h, [...(soc.get(h) ?? []), x.soc]); }
  return { date: b.date, bucketMinutes: 60,
    buckets: [...hours].sort((p, q) => p[0] - q[0]).map(([t, a]) => ({ t, solar: r2(a.solar), home: r2(a.home), grid: r2(a.grid), battery: r2(a.battery) })),
    soe: [...soc].sort((p, q) => p[0] - q[0]).map(([t, v]) => ({ t, soc: Math.round(sum(v) / v.length * 10) / 10 })), totals: pick(b.totals, KWH) };
}
/** redact.ts guestBills: the month, the period, kWh bought and sent, and whether the meter matched Tesla. */
const guestBills = rows => rows.map(r => ({ month: r.billDate.slice(0, 7), period: pick(r.period, { from: true, to: true, days: true }), deliveredKwh: r.pec.deliveredKwh,
  receivedKwh: r.pec.receivedKwh, checks: { meterMatchesTesla: r.checks.find(c => c.id === 'meter')?.ok === true } }));

/** What a share-link guest gets from each route that has a guest view (redact.ts GUEST_GET), plus /api/auth/me's guest answer. */
export function guestFixtures(now) {
  const o = coreFixtures(now), out = {};
  for (const [k, rule] of Object.entries(RULES)) out[k] = pick(o[k], rule);
  out['settings'] = { location: { ...COARSE_LOCATION } };
  out['day'] = hourlyDay(o.day);
  out['reconcile'] = guestBills(o.reconcile);
  out['events'] = o.events.filter(e => e.type === 'cleaned' || e.type === 'filter_cleaned').map(e => ({ type: e.type, day: e.day }));
  // changedFor({ guest: true }) folds AC, always-on and unexplained into one "other" part before the view picks it
  const c = changedClean(now);
  out['changed'] = pick({ ...c, home: { ...c.home, parts: [{ id: 'weather', kwh: 3.8, conf: 'estimated' }, { id: 'pool', kwh: 1.2, conf: 'measured' }, { id: 'other', kwh: 1.1, conf: null }] }, notes: [] }, RULES.changed);
  out['auth/me'] = { mode: 'single', owner: false, guest: true, label: null, ownerName: 'Test Owner', expiresAt: new Date(now + 25 * D).toISOString() };
  return out;
}
/** Route keys (of coreFixtures) a guest is refused: no view in redact.ts GUEST_GET (access.ts fails closed), or a write (sync is a POST). */
export const OWNER_ONLY = ['flows', 'breakdown', 'loads', 'spare', 'capacity', 'outage', 'models', 'auth/devices', 'share', 'alerts', 'digest', 'presence', 'tesla/scopes', 'powerwall/rules', 'sync'];
