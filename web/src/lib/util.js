export const $ = id => document.getElementById(id);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const fmtDur = hrs => { if (!isFinite(hrs) || hrs <= 0) return '—'; const H = Math.floor(hrs), M = Math.round((hrs - H) * 60); return H ? `${H}h ${String(M).padStart(2, '0')}m` : `${M}m`; };
export const clock12 = h => { h = ((h % 24) + 24) % 24; const H = Math.floor(h), M = Math.floor((h % 1) * 60); return `${(H + 11) % 12 + 1}:${String(M).padStart(2, '0')} ${H < 12 ? 'AM' : 'PM'}`; };
export const hourLabel = h => `${(h + 11) % 12 + 1}${h % 24 < 12 ? 'a' : 'p'}`;
export const kwh = (v, d = 1) => v == null ? '—' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })}<small>kWh</small>`;
export const money = v => v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
export const money2 = v => v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
export const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

/* Site-local time (America/Chicago) */
export const TZ = 'America/Chicago';
export const localParts = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(p => [p.type, p.value]));
export const localDate = (d = new Date()) => { const p = localParts(d); return `${p.year}-${p.month}-${p.day}`; };
export const localHour = (d = new Date()) => { const p = localParts(d); return +p.hour + +p.minute / 60; };
export const addDays = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const niceDate = (day, opts = { month: 'short', day: 'numeric' }) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

/* The site's location is not in the code (the repo and this bundle are public). The server reads SITE_LAT, SITE_LON and SITE_ZIP
   from its env and sends them with /api/settings; main.js passes them to setSiteLocation() at boot, before weather loads. */
export const RAD = Math.PI / 180;
let site = null;
/** Keep {lat, lon, zip} from the server. Returns it, or null when the server has no location. */
export function setSiteLocation(loc) {
  const ok = loc && typeof loc.lat === 'number' && typeof loc.lon === 'number' && isFinite(loc.lat) && isFinite(loc.lon);
  site = ok ? { lat: loc.lat, lon: loc.lon, zip: loc.zip ?? null } : null;
  return site;
}
export const siteLocation = () => site;

/* Sun position (NOAA approximation) at the site. Until the location arrives it is a fixed daytime sun due south, a neutral placeholder. */
export function sunAt(date, loc = site) {
  if (!loc) return { el: 45, az: 180 };
  const LAT = loc.lat, LON = loc.lon;
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0)), doy = Math.floor((date - start) / 864e5);
  const hr = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600, g = 2 * Math.PI / 365 * (doy - 1 + (hr - 12) / 24);
  const eqt = 229.18 * (.000075 + .001868 * Math.cos(g) - .032077 * Math.sin(g) - .014615 * Math.cos(2 * g) - .040849 * Math.sin(2 * g));
  const dec = .006918 - .399912 * Math.cos(g) + .070257 * Math.sin(g) - .006758 * Math.cos(2 * g) + .000907 * Math.sin(2 * g) - .002697 * Math.cos(3 * g) + .00148 * Math.sin(3 * g);
  const ha = ((hr * 60 + eqt + 4 * LON) / 4 - 180) * RAD, lat = LAT * RAD;
  const el = 90 - Math.acos(clamp(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha), -1, 1)) / RAD;
  return { el, az: (Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) / RAD + 540) % 360 };
}

export function toast(icon, bg, title, sub) {
  $('toastI').textContent = icon; $('toastI').style.background = bg; $('toastT').textContent = title; $('toastS').textContent = sub;
  $('toast').classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => $('toast').classList.remove('show'), 4500);
}

/* tiny SVG helpers */
export const svgText = (x, y, t, { size = 9.5, fill = 'rgba(242,244,248,.4)', anchor = 'start', font = 'JetBrains Mono', weight = 400 } = {}) =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-family="${font}" font-weight="${weight}" text-anchor="${anchor}">${t}</text>`;
export const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
