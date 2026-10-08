// Systems › AC: the Strip heat card (approved mockup mockups/am-ideas.html frame 6, I-15), from GET /api/appliances/ac/strip
// (server/src/stripwatch.ts stripCard). Pure: views/ac.js puts it under the Thermostat card. Owner only; no buttons; it writes nothing.
import { cBadge, esc } from './conf.js';

/** "1 h 35 m", "45 m", "—" when unknown. */
export const dur = min => min == null ? '—' : min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} m` : `${min} m`;
const kw1 = v => v == null ? '—' : `${(Math.round(v * 10) / 10).toFixed(1)} kW`;
const kwh1 = v => `${Math.round((v ?? 0) * 10) / 10}`;
/** Whether the card shows: Nov–Mar or heating in the last 7 days (the server's `show`), or `?strip` in the address for a check. */
export const stripShows = (d, search = '') => !!d && !!d.today && (!!d.show || new URLSearchParams(search).has('strip'));
/** The 16 half-hour bars, 4 AM to noon, as approved mockup am frame 6 draws them: each pair of the server's 15-minute quarters becomes
 *  one bar (mean kW; amber when either quarter ran strips, else blue when either ran the compressor), height against the window's
 *  highest (8% at least). */
export function stageBars(quarters) {
  const qs = quarters ?? [], bars = [];
  for (let i = 0; i < qs.length; i += 2) {
    const pair = qs.slice(i, i + 2), cls = pair.some(q => q.cls === 'st') ? 'st' : pair.some(q => q.cls === 'hp') ? 'hp' : '';
    bars.push({ cls, kw: pair.reduce((a, q) => a + (q.kw ?? 0), 0) / pair.length });
  }
  const max = Math.max(.1, ...bars.map(b => b.kw));
  return bars.map(b => `<i class="${b.cls}" style="height:${Math.max(8, Math.round(b.kw / max * 100))}%"></i>`).join('');
}
/** The card's inner HTML (frame 6): header with the badge and this morning's kWh, the bars, Strips and Heat pump, Why, the tip, the week and the heating type. */
export function stripCardHtml(d) {
  const t = d.today ?? {}, h = d.heating ?? {}, w = d.week ?? { mornings: 0, kwh: 0 };
  const hp = h.kind === 'heat-pump' || h.kind === 'learning';   // a straight AC heats on the strips alone: no compressor row
  const parts = `<div class="c-part c-acc-solar"><i></i><span>Strips</span><b>${dur(t.stripMin ?? 0)}${t.peakKw != null ? `<em>peak ${kw1(t.peakKw)}</em>` : ''}</b></div>`
    + (hp ? `<div class="c-part c-acc-home"><i></i><span>Heat pump</span><b>${dur(t.hpMin)}${t.hpMin && t.hpKw != null ? `<em>${kw1(t.hpKw)}</em>` : ''}</b></div>` : '');
  return `<div class="c-head"><h5>Strip heat</h5>${cBadge(t.conf)}<span class="c-fig">${kwh1(t.stripKwh)} kWh this morning</span></div>`
    + `<div class="c-stage">${stageBars(t.quarters)}</div><div class="c-dlab"><span>4a</span><span>6a</span><span>8a</span><span>10a</span><span>12p</span></div>`
    + `<div class="c-parts">${parts}</div>`
    + `<div class="c-sum"><b>Why:</b> ${t.why ? esc(t.why) : 'no strip heat so far this morning.'}</div>`
    + (t.tip ? `<div class="c-well" style="margin-top:10px;padding:12px 14px;font-size:12.5px;line-height:1.5;color:var(--dim)"><b style="color:var(--text)">Tip:</b> ${esc(t.tip)}</div>` : '')
    + `<div class="c-kv" style="margin-top:10px"><span>This week</span><b>${w.mornings} morning${w.mornings === 1 ? '' : 's'} · ${w.kwh} kWh</b><span>Your heating</span><b>${esc(h.label ?? '—')} ${cBadge(h.conf)}</b></div>`;
}
