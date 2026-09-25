import { addDays, clamp } from './util.js';

/*
 * Data for the Next 48 hours road (scenes/road48.js, mockups/l-forecast48.html). Pure: everything comes in as arguments.
 *   lanes, SOC wall and markers: forecast48() (the same points the SVG chart drew), plus the SOC it started from;
 *   floor shading and the rain flag: Open-Meteo hourly cloud cover and precipitation probability;
 *   pool windows: today from ScreenLogic's applied schedules (solid), tomorrow from Pool Autopilot's plan (outlined);
 *   AC windows: today's pre-cool / coast from the AC plan (solid once Auto or approved), tomorrow's from the AC week (outlined).
 * x is hours from the start of the current hour (x = 0 is "now"), one unit per hour.
 */
const pad = n => String(n).padStart(2, '0');
const clk = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const weekday = day => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

/** Minutes of the day → "10 AM–7 PM", or "12–5 PM" when both ends share AM/PM. */
export function span(m0, m1) {
  const f = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return { h: Math.floor(m / 60), m: m % 60 }; };
  const a = f(m0), b = f(m1), t = (x, suf) => `${x.h % 12 || 12}${x.m ? ':' + pad(x.m) : ''}${suf ? (x.h < 12 ? ' AM' : ' PM') : ''}`;
  return `${t(a, (a.h < 12) !== (b.h < 12))}–${t(b, true)}`;
}

/**
 * @param o.fc      forecast48() output: { points[{k, t, s, h, soc, g}], full, low, importKwh }
 * @param o.w       the Open-Meteo forecast (S.wx)
 * @param o.soc0    Powerwall charge (0–1) the forecast started from
 * @param o.when    the sentence's own time formatter, so the flags read exactly as #fcTxt does
 * @param o.pool    S.pool (GET /api/appliances/pool) or undefined
 * @param o.ac      S.ac (GET /api/appliances/ac) or undefined
 */
export function roadModel({ fc, w, soc0, capKwh, maxKw, reservePct, pool, ac, when }) {
  const P = fc?.points ?? [], n = P.length;
  if (!n) return null;
  const today = P[0].t.slice(0, 10), tomorrow = addDays(today, 1), x0 = +P[0].t.slice(11, 13);
  const idx = new Map(P.map((p, k) => [p.t, k]));
  const dayN = day => Math.round((Date.parse(day + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 864e5);
  /** x of a local day + hour (hours may run past 24). Looked up on the forecast's own clock, so DST days line up. */
  const xAt = (day, hr) => {
    while (hr >= 24) { day = addDays(day, 1); hr -= 24; }
    const k = idx.get(`${day}T${pad(Math.floor(hr))}:00`);
    return k != null ? k + hr % 1 : dayN(day) * 24 + hr - x0;
  };

  /* ---------- schedule windows ---------- */
  const windows = [];
  const add = (kind, day, d, m0, m1, plan, rpm, name) => {
    const a = xAt(day, m0 / 60), b = xAt(day, (m1 <= m0 ? m1 + 1440 : m1) / 60);
    if (b <= 0 || a >= n) return;
    windows.push({ kind, day: d, a: Math.max(0, a), b: Math.min(n, b), plan, rpm, label: name ? `${name}${plan ? ' plan' : ''} · ${span(m0, m1)}` : null });
  };
  if (pool?.linked) {
    const boost = pool.settings?.boostCircuit;
    const put = (list, day, d, plan) => (list ?? []).forEach(s => {
      const b = s.circuitId === boost; add(b ? 'boost' : 'pool', day, d, s.start, s.stop, plan, s.rpm ?? 0, b ? null : 'pool'); });
    put(pool.current?.schedules, today, 0, false);
    const ap = pool.autopilot, planned = ap && !ap.error && ap.mode !== 'off' && ap.tomorrow?.date === tomorrow ? ap.tomorrow.plan : null;
    put(planned ? planned.schedules : pool.current?.schedules, tomorrow, 1, !!planned);   // Autopilot off: the controller repeats today
  }
  if (ac?.linked) {
    const put = (p, day, d, plan) => { if (!p?.precool || p.precoolFrom == null) return;
      add('pre', day, d, p.precoolFrom * 60, p.precoolTo * 60, plan, 0, 'pre-cool');
      add('coast', day, d, p.coastFrom * 60, p.coastTo * 60, plan, 0, 'coast'); };
    put(ac.plan?.date === today ? ac.plan : null, today, 0, !(ac.settings?.autopilot === 'auto' || ac.applied?.approved));
    put(ac.week?.find(x => x.date === tomorrow), tomorrow, 1, true);
  }

  /* ---------- markers (the flags use the sentence's formatter) ---------- */
  const kFull = fc.full ? P.findIndex(p => p.t === fc.full) : -1;
  let xFull = null;
  if (kFull >= 0) {   // where in that hour the Powerwalls reach 100%, at the charge rate forecast48 simulates
    const prev = kFull ? P[kFull - 1].soc : soc0, p = P[kFull], kw = Math.min(maxKw, Math.max(.01, p.s - p.h));
    xFull = kFull + clamp((1 - prev) * capKwh / .95 / kw, 0, 1);
  }
  const kLow = fc.low?.t ? P.findIndex(p => p.t === fc.low.t) : -1;

  /* ---------- hours ---------- */
  const wi = new Map((w?.hourly?.time ?? []).map((t, i) => [t, i]));
  const poolDays = pool?.linked ? 1 : -1;
  const hours = P.map((p, k) => {
    const i = wi.get(p.t), day = p.t.slice(0, 10), hh = +p.t.slice(11, 13), dn = dayN(day);
    const c = clamp((w?.hourly?.cloud_cover?.[i] ?? 0) / 100, 0, 1), pop = Math.round(w?.hourly?.precipitation_probability?.[i] ?? 0);
    const rpm = Math.max(0, ...windows.filter(x => (x.kind === 'pool' || x.kind === 'boost') && x.a < k + 1 && x.b > k).map(x => x.rpm));
    const acw = windows.find(x => (x.kind === 'pre' || x.kind === 'coast') && k >= x.a && k < x.b);
    const label = `${weekday(day)} ${clk(hh)}`;
    const pec = p.g > .05 ? `PEC ${p.g.toFixed(1)} kW` : p.g < -.05 ? `export ${(-p.g).toFixed(1)} kW` : 'PEC 0';
    const readout = [`<b>${label}</b>`, `solar ${p.s.toFixed(1)} kW`, `home ${p.h.toFixed(1)} kW`, `Powerwalls ${Math.round(p.soc * 100)}%`, pec,
      dn <= poolDays ? rpm ? `pool ${rpm.toLocaleString('en-US')} rpm` : 'pool off' : '',
      acw ? (acw.kind === 'pre' ? 'pre-cool' : 'coast') : '', pop >= 30 ? `rain ${pop}%` : ''].filter(Boolean).join(' · ');
    return { t: p.t, s: p.s, h: p.h, soc: p.soc, c, pop, night: hh < 7 || hh >= 20, dusk: hh === 7 || hh === 19, midnight: hh === 0,
      hud: `${label}${k === 0 ? ' · now · ← drag to drive →' : ` · +${k} h`}`, readout };
  });
  const kRain = hours.findIndex(x => x.pop >= 50);

  return {
    n, soc0, reserve: reservePct / 100, hours, windows,
    day2At: xAt(tomorrow, 0),   // day-2 window labels take over once the view passes tomorrow's midnight
    full: xFull == null ? null : { x: xFull, txt: `full by ${when(fc.full)}` },
    low: kLow < 0 ? null : { x: kLow + 1, soc: fc.low.soc, txt: `lowest ${Math.round(fc.low.soc * 100)}% · ${when(fc.low.t)}` },
    rain: kRain < 0 ? null : { k: kRain, txt: `☂ rain ${hours[kRain].pop}%` },
  };
}
