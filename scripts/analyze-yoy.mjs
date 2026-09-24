// Year-over-year analysis for each PEC bill period: Tesla-measured flows vs. weather (Open-Meteo archive).
// Separates "solar produced less" from "less sunshine" from "the house used more".
// Usage: node --no-warnings scripts/analyze-yoy.mjs   (reads data/solstice.db and data/bills/*.json)
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

const db = new DatabaseSync(new URL('../data/solstice.db', import.meta.url).pathname, { readOnly: true });
const billsDir = new URL('../data/bills/', import.meta.url).pathname;
const bills = readdirSync(billsDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(billsDir + f, 'utf8')));
const shiftYear = (d, dy) => `${+d.slice(0, 4) + dy}${d.slice(4)}`;
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

function tesla(from, to) {
  const r = db.prepare(`SELECT COUNT(DISTINCT substr(ts,1,10)) days, SUM(solar_wh)/1000 solar, SUM(home_wh)/1000 home, SUM(import_wh)/1000 imp,
    SUM(export_wh)/1000 exp, SUM(charge_wh)/1000 chg, SUM(discharge_wh)/1000 dis FROM energy WHERE substr(ts,1,10) >= ? AND substr(ts,1,10) < ?`).get(from, to);
  const daily = db.prepare(`SELECT substr(ts,1,10) day, SUM(solar_wh)/1000 solar, SUM(home_wh)/1000 home FROM energy
    WHERE substr(ts,1,10) >= ? AND substr(ts,1,10) < ? GROUP BY day ORDER BY day`).all(from, to);
  return { ...r, daily };
}

async function weather(from, to) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=LAT&longitude=LON&start_date=${from}&end_date=${addDays(to, -1)}` +
    `&hourly=global_tilted_irradiance,temperature_2m&daily=temperature_2m_max,temperature_2m_mean&tilt=27&azimuth=64&timezone=America%2FChicago&temperature_unit=fahrenheit`;
  const w = await (await fetch(url)).json();
  const gti = w.hourly.global_tilted_irradiance.reduce((a, v) => a + (v ?? 0), 0) / 1000; // kWh/m² on the panel plane
  const byDay = {};
  w.hourly.time.forEach((t, i) => { const d = t.slice(0, 10); byDay[d] = (byDay[d] ?? 0) + (w.hourly.global_tilted_irradiance[i] ?? 0) / 1000; });
  const cdd = w.daily.temperature_2m_mean.reduce((a, t) => a + Math.max(0, (t ?? 65) - 65), 0);  // cooling degree-days (base 65°F)
  const hi = w.daily.temperature_2m_max.filter(v => v != null);
  return { gti, byDay, cdd, avgHigh: hi.reduce((a, b) => a + b, 0) / hi.length };
}

const f = (v, d = 0) => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (a, b) => a && b ? `${b >= a ? '+' : ''}${((b - a) / a * 100).toFixed(0)}%` : '—';

for (const bill of bills.sort((a, b) => a.billDate.localeCompare(b.billDate))) {
  const now = { from: bill.period.from, to: bill.period.to }, prev = { from: shiftYear(now.from, -1), to: shiftYear(now.to, -1) };
  const [tN, tP, wN, wP] = [tesla(now.from, now.to), tesla(prev.from, prev.to), await weather(now.from, now.to), await weather(prev.from, prev.to)];
  // performance ratio proxy: kWh produced per kWh/m² of sunlight on the panel plane (same system both years → comparable)
  const prN = tN.solar / wN.gti, prP = tP.solar / wP.gti;
  // clear-day check: on the sunniest 25% of days, solar per unit of sunlight
  const clear = (t, w) => { const ds = t.daily.filter(d => w.byDay[d.day]).map(d => ({ ...d, g: w.byDay[d.day] })).sort((a, b) => b.g - a.g).slice(0, Math.ceil(t.daily.length / 4));
    return ds.reduce((a, d) => a + d.solar, 0) / ds.reduce((a, d) => a + d.g, 0); };
  console.log(`\n=== Bill ${bill.billDate}  (${now.from} → ${now.to})  vs same dates ${prev.from.slice(0, 4)}`);
  console.log(`days of Tesla data        ${tN.days} / ${tP.days}`);
  const row = (label, a, b, d = 0) => console.log(`${label.padEnd(26)}${f(b, d).padStart(9)}  ${f(a, d).padStart(9)}   ${pct(b, a)}`);
  console.log(`${''.padEnd(26)}${String(prev.from.slice(0, 4)).padStart(9)}  ${String(now.from.slice(0, 4)).padStart(9)}   change`);
  row('Home used (kWh)', tN.home, tP.home);
  row('Solar produced (kWh)', tN.solar, tP.solar);
  row('Bought from PEC (kWh)', tN.imp, tP.imp);
  row('Sent to PEC (kWh)', tN.exp, tP.exp);
  row('Powerwall charged (kWh)', tN.chg, tP.chg);
  row('Sunlight on panels kWh/m²', wN.gti, wP.gti, 1);
  row('Solar per sunlight', prN, prP, 2);
  row('  … on the sunniest days', clear(tN, wN), clear(tP, wP), 2);
  row('Cooling degree-days', wN.cdd, wP.cdd);
  row('Average daily high °F', wN.avgHigh, wP.avgHigh, 1);
  console.log(`PEC billed: ${bill.deliveredKwh} kWh bought (last year ${bill.comparison?.lastYearKwh ?? '—'}), ${bill.receivedKwh} kWh sent  →  Tesla import ${pct(bill.deliveredKwh, tN.imp)} vs meter`);
}
