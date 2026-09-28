// Per-panel health (approved mockup u-panels). Built on the PVS6 readings in `pvs_readings` (pvs.ts):
//   layout     a stable map from inverter serial to roof position, learned on first sight in the order the PVS lists the inverters
//              (Row 1 · 1 … Row 1 · 10, then Row 2, then Row 3) and kept in kv `pvs:layout`. Row 1 is the ridge row, Row 3 the eave
//              row; columns count 1–10 from the north end. GET /api/pvs/layout shows the positions, POST /api/pvs/layout moves them.
//              A serial never leaves the server: every response names panels by position only.
//   panels     GET /api/pvs/panels?date= — each panel's kW now (AC and DC), heat-sink °C, kWh today, share of the array, % of the
//              median panel (now and today), the age of its last reading, whether it is reporting, and the day's 5-minute sparkline;
//              plus the array totals, the lowest three, the panels not reporting, the relay's last poll and any open panel.low anomaly.
//   metrics    per-panel daily figures for the learning layer's nightly rules (learn/rules.ts panelRules)
//   watch      every 5 minutes: a `panel` push for a panel silent for 60 minutes of daylight, or once for the relay itself when the
//              whole relay is silent (never 30 panel pushes for one sleeping Mac).
// Read only towards every device: nothing here writes to the PVS.
import { q, one, kv } from './db.js';
import { config } from './config.js';
import { localDay, localMidnight } from './tesla/client.js';
import { pvsDay, pvsLatest } from './pvs.js';
import { siteLocation } from './site.js';
import { notify } from './notify.js';
import { panelDiagnosis } from './learn/rules.js';

export const PANELS = {
  rows: 3, cols: 10,
  staleMs: 15 * 60_000,         // a panel is "not reporting" when its newest reading is this far behind the relay's newest poll
  silentPolls: 12,              // 60 minutes of daylight polls (5-minute cadence) before a `panel` push
  relaySilentMs: 60 * 60_000,   // the relay itself: one push after an hour of daylight silence
  sunDownKw: .02,               // array median under 20 W: sun down (no tint, no daylight poll)
};
export const LAYOUT_KEY = 'pvs:layout';

export type Pos = { row: number; col: number };
export type Layout = { v: 1; slots: Record<string, Pos>; learnedAt: number; updatedAt: number };

export const posId = (p: Pos) => `r${p.row}c${p.col}`;
export const posName = (p: Pos) => `Row ${p.row} · ${p.col}`;
export function parsePos(s: unknown): Pos | null {
  const m = typeof s === 'string' ? /^r([1-3])c(10|[1-9])$/.exec(s) : null;
  return m ? { row: +m[1], col: +m[2] } : null;
}
/** Slot order for first sight: Row 1 (ridge) left to right, then Row 2, then Row 3. */
export const SLOT_ORDER: Pos[] = Array.from({ length: PANELS.rows * PANELS.cols }, (_, i) => ({ row: Math.floor(i / PANELS.cols) + 1, col: i % PANELS.cols + 1 }));

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* ---------------------------------------------------------------- layout ---------------------------------------------------------------- */
/** Pure: give each serial not yet placed the next free slot, in the order given. Extra serials beyond 30 stay unplaced. */
export function learnSlots(cur: Layout | null, sns: string[], now = Date.now()): { layout: Layout; added: number } {
  const layout: Layout = cur ? { ...cur, slots: { ...cur.slots } } : { v: 1, slots: {}, learnedAt: now, updatedAt: now };
  const taken = new Set(Object.values(layout.slots).map(posId)), free = SLOT_ORDER.filter(p => !taken.has(posId(p)));
  let added = 0;
  for (const sn of sns) {
    if (layout.slots[sn] || !free.length) continue;
    layout.slots[sn] = free.shift()!; added++;
  }
  if (added) layout.updatedAt = now;
  return { layout, added };
}
export const getLayout = async () => (await kv.get<Layout>(LAYOUT_KEY)) ?? null;
/** Called on every ingest: places serials seen for the first time. One kv read; a write only when something new was placed. */
export async function learnLayout(sns: string[], now = Date.now()) {
  const cur = await getLayout(), r = learnSlots(cur, sns, now);
  if (r.added) await kv.set(LAYOUT_KEY, r.layout);
  return r.layout;
}
/** Pure: move panels by position ({ "r1c3": "r2c5", "r2c5": "r1c3" } swaps two). The result must still put at most one inverter on a position. */
export function applyMoves(layout: Layout, moves: unknown, now = Date.now()): { ok: true; layout: Layout } | { ok: false; error: string } {
  if (!moves || typeof moves !== 'object' || Array.isArray(moves)) return { ok: false, error: 'moves must be an object like { "r1c3": "r2c5" }' };
  const entries = Object.entries(moves as Record<string, unknown>);
  if (!entries.length || entries.length > SLOT_ORDER.length) return { ok: false, error: `moves must name 1 to ${SLOT_ORDER.length} positions` };
  const bySlot = new Map(Object.entries(layout.slots).map(([sn, p]) => [posId(p), sn]));
  const next: Record<string, Pos> = { ...layout.slots };
  for (const [from, to] of entries) {
    const a = parsePos(from), b = parsePos(to);
    if (!a || !b) return { ok: false, error: `positions look like r1c1 … r3c10 (got ${String(from).slice(0, 12)} → ${String(to).slice(0, 12)})` };
    const sn = bySlot.get(posId(a));
    if (!sn) return { ok: false, error: `no panel is mapped to ${posId(a)}` };
    next[sn] = b;
  }
  const seen = new Set<string>();
  for (const p of Object.values(next)) { const id = posId(p); if (seen.has(id)) return { ok: false, error: `two panels would sit on ${id}; move both sides of a swap` }; seen.add(id); }
  return { ok: true, layout: { ...layout, slots: next, updatedAt: now } };
}
/** What GET/POST /api/pvs/layout answer: positions only. */
export function layoutView(layout: Layout | null) {
  const ps = layout ? Object.values(layout.slots).sort((a, b) => a.row - b.row || a.col - b.col) : [];
  return { learned: !!layout, mapped: ps.length, expected: SLOT_ORDER.length, learnedAt: layout ? new Date(layout.learnedAt).toISOString() : null,
    updatedAt: layout ? new Date(layout.updatedAt).toISOString() : null, positions: ps.map(p => ({ id: posId(p), row: p.row, col: p.col, name: posName(p) })) };
}

/* ---------------------------------------------------------------- daylight ---------------------------------------------------------------- */
/** Sun elevation in degrees (NOAA's short form), for the relay-silence push. */
export function sunElevation(ms: number, lat: number, lon: number) {
  const d = new Date(ms), RAD = Math.PI / 180, doy = Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
  const hr = d.getUTCHours() + d.getUTCMinutes() / 60, g = 2 * Math.PI / 365 * (doy - 1 + (hr - 12) / 24);
  const eqt = 229.18 * (.000075 + .001868 * Math.cos(g) - .032077 * Math.sin(g) - .014615 * Math.cos(2 * g) - .040849 * Math.sin(2 * g));
  const dec = .006918 - .399912 * Math.cos(g) + .070257 * Math.sin(g) - .006758 * Math.cos(2 * g) + .000907 * Math.sin(2 * g) - .002697 * Math.cos(3 * g) + .00148 * Math.sin(3 * g);
  const ha = ((hr * 60 + eqt + 4 * lon) / 4 - 180) * RAD, la = lat * RAD;
  return 90 - Math.acos(Math.max(-1, Math.min(1, Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)))) / RAD;
}
/** Is the sun up? From SITE_LAT/SITE_LON when set, else 08:00–18:00 Chicago. */
export function sunUp(ms: number, loc = siteLocation()) {
  if (loc) return sunElevation(ms, loc.lat, loc.lon) > 3;
  const h = +new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  return h >= 8 && h < 18;
}

/* ---------------------------------------------------------------- the roll-up ---------------------------------------------------------------- */
type Anom = { kind: string; day: string; opened_at: number; detail: Record<string, any> };
/**
 * GET /api/pvs/panels: everything the Live roof's Per panel chip and the Panel health card draw, by position. `now` values come from
 * the newest reading of each inverter (today only). The median panel is the median of the panels reporting; a panel that is not
 * reporting is left out of the median and the lowest three. The relay is "silent" when its newest poll is over 15 minutes old.
 */
export async function panelsDay(date: string, now = Date.now()) {
  const today = localDay(new Date(now)), isToday = date === today;
  const [layout, day, latest, first, anoms] = await Promise.all([
    getLayout(), pvsDay(date), pvsLatest(now),
    one<{ ms: number | null }>(`SELECT (extract(epoch FROM min(ts)) * 1000)::float8 AS ms FROM pvs_readings`),
    q<Anom>(`SELECT kind, day, opened_at::float8 opened_at, detail FROM anomalies WHERE kind LIKE 'panel.low@%' AND resolved_at IS NULL ORDER BY opened_at`),
  ]);
  const slots = layout?.slots ?? {};
  const newest = latest.at ? Date.parse(latest.at) : null, relayAgeMs = newest == null ? null : now - newest;
  const lat = new Map(latest.inverters.map(i => [i.sn, i]));
  const atNewest = latest.inverters.filter(i => newest != null && Date.parse(i.ts) === newest).map(i => Math.max(0, i.kw ?? 0));
  const daylight = (median(atNewest) ?? 0) >= PANELS.sunDownKw;
  const dayBy = new Map(day.inverters.map(i => [i.sn, i]));
  const unmapped = new Set([...dayBy.keys(), ...lat.keys()].filter(sn => !slots[sn])).size;

  const rows = Object.entries(slots).map(([sn, p]) => {
    const l = lat.get(sn), d = dayBy.get(sn), ts = l ? Date.parse(l.ts) : null;
    const lagMs = ts != null && newest != null ? newest - ts : null;
    const reporting = !isToday ? !!d : newest == null ? false : !daylight ? true : lagMs != null && lagMs <= PANELS.staleMs;
    return { sn, p, l: isToday ? l : undefined, d, ts, reporting };
  }).sort((a, b) => a.p.row - b.p.row || a.p.col - b.p.col);

  const live = rows.filter(r => r.reporting);
  const medKwNow = isToday ? median(live.map(r => r.l?.kw).filter((v): v is number => v != null)) : null;
  const medKwDcNow = isToday ? median(live.map(r => r.l?.kwDc).filter((v): v is number => v != null)) : null;
  const medConvNow = isToday ? median(live.filter(r => (r.l?.kwDc ?? 0) > .01 && r.l?.kw != null).map(r => r.l!.kw! / r.l!.kwDc!)) : null;
  const medKwh = median(live.map(r => r.d?.kwh).filter((v): v is number => v != null));
  const arrayKwh = rows.reduce((a, r) => a + (r.d?.kwh ?? 0), 0);
  const pct = (v: number | null | undefined, m: number | null) => v == null || !m ? null : round(v / m * 100, 1);
  const sunDown = !isToday || medKwNow == null || medKwNow < PANELS.sunDownKw;

  const openBy = new Map(anoms.map(a => [a.kind.slice('panel.low@'.length), a]));
  const panels = rows.map(r => {
    const id = posId(r.p), ageS = r.ts == null ? null : Math.max(0, Math.round((now - r.ts) / 1000));
    return {
      id, row: r.p.row, col: r.p.col, name: posName(r.p), reporting: r.reporting,
      at: r.l?.ts ?? null, ageS: r.l ? ageS : null,
      kw: r.l?.kw ?? null, kwDc: r.l?.kwDc ?? null, tempC: r.l?.tempC ?? null,
      kwh: r.d ? r.d.kwh : null, kwhSource: r.d?.kwhSource ?? null, maxTempC: r.d?.maxTempC ?? null,
      sharePct: r.d && arrayKwh > 0 ? round(r.d.kwh / arrayKwh * 100, 2) : null,
      pctNow: r.reporting && !sunDown ? pct(r.l?.kw, medKwNow) : null,
      pctToday: r.reporting ? pct(r.d?.kwh, medKwh) : null,
      flagged: openBy.has(id),
      spark: day.times.map((_, i) => { const v = r.d?.kw[i]; return v == null ? null : round(Math.max(0, v), 3); }),
    };
  });
  const byId = new Map(panels.map(p => [p.id, p]));
  const medianSeries = day.times.map((_, i) => { const m = median(rows.filter(r => r.reporting).map(r => r.d?.kw[i]).filter((v): v is number => v != null)); return m == null ? null : round(Math.max(0, m), 3); });
  const got = panels.filter(p => p.pctToday != null), hot = panels.filter(p => p.maxTempC != null).sort((a, b) => b.maxTempC! - a.maxTempC!)[0];
  const weakest = panels.filter(p => p.pctNow != null).sort((a, b) => a.pctNow! - b.pctNow!)[0];
  const relaySilent = relayAgeMs != null && relayAgeMs > PANELS.staleMs && isToday;
  const firstDay = first?.ms != null ? localDay(new Date(Number(first.ms))) : null;

  return {
    date, today: isToday, timeZone: day.timeZone, at: new Date(now).toISOString(), bucketMinutes: day.bucketMinutes, times: day.times,
    layout: { learned: !!layout, mapped: rows.length, expected: SLOT_ORDER.length, unmapped },
    relay: { lastPoll: latest.at, ageS: relayAgeMs == null ? null : Math.round(relayAgeMs / 1000), silent: relaySilent, daylight: isToday && daylight },
    since: firstDay, days: firstDay ? Math.round((Date.parse(today) - Date.parse(firstDay)) / 864e5) + 1 : 0,
    sunDown, reporting: panels.filter(p => p.reporting).length,
    now: { medianKw: medKwNow == null ? null : round(medKwNow, 4), medianKwDc: medKwDcNow == null ? null : round(medKwDcNow, 4),
      medianConvPct: medConvNow == null ? null : round(medConvNow * 100, 1), arrayKw: isToday ? round(rows.reduce((a, r) => a + (r.reporting ? r.l?.kw ?? 0 : 0), 0), 3) : null,
      weakest: weakest ? { id: weakest.id, name: weakest.name, pct: weakest.pctNow } : null },
    totals: { kwh: round(arrayKwh, 3), medianKwh: medKwh == null ? null : round(medKwh, 3),
      spread: got.length ? { loPct: Math.min(...got.map(p => p.pctToday!)), hiPct: Math.max(...got.map(p => p.pctToday!)) } : null,
      hottest: hot ? { id: hot.id, name: hot.name, tempC: hot.maxTempC } : null },
    lowest: got.sort((a, b) => a.pctToday! - b.pctToday!).slice(0, 3).map(p => ({ id: p.id, name: p.name, kwh: p.kwh, pct: p.pctToday })),
    notReporting: relaySilent ? [] : panels.filter(p => !p.reporting).map(p => ({ id: p.id, name: p.name, at: p.at, lastKw: p.kw, kwh: p.kwh,
      silentMin: p.at ? Math.round((now - Date.parse(p.at)) / 60_000) : null, pushAt: p.at ? new Date(Date.parse(p.at) + PANELS.silentPolls * 5 * 60_000).toISOString() : null })),
    panels, medianSeries,
    anomalies: anoms.map(a => {
      const id = a.kind.slice('panel.low@'.length), p = byId.get(id), d = a.detail ?? {};
      const liveDiag = isToday && !sunDown && p?.kwDc != null && medKwDcNow ? panelDiagnosis(p.kwDc / medKwDcNow, p.kw != null && p.kwDc > .01 ? p.kw / p.kwDc : null) : null;
      return { kind: a.kind, id, name: p?.name ?? String(d.title ?? id).replace(/ is running low$/, ''), day: a.day, openedAt: a.opened_at,
        title: d.title ?? null, body: d.body ?? null, nLow: d.nLow ?? null, window: d.window ?? null, days: Array.isArray(d.days) ? d.days : [],
        diag: liveDiag ?? d.diag ?? null };
    }),
  };
}

/** The anomalies' alert state (owner only; the route adds it, the guest view drops it). */
export async function panelAlerts(kinds: string[]) {
  if (!kinds.length) return {};
  const rows = await q<{ anomaly: string; pushed: number; at: string }>(`SELECT data->>'anomaly' anomaly, MAX(pushed)::int pushed, MIN(created_at)::text at FROM alerts
     WHERE kind = 'panel' AND data->>'anomaly' = ANY($1::text[]) GROUP BY 1`, [kinds]);
  return Object.fromEntries(rows.map(r => [r.anomaly, { pushed: r.pushed > 0, at: new Date(r.at).toISOString() }]));
}

/* ---------------------------------------------------------------- nightly metrics ---------------------------------------------------------------- */
/**
 * Per local day (from ≤ day < to) and panel: kWh (lifetime-counter difference, else the 5-minute sum), the share of the day's daylight
 * polls it reported in, and its mean daylight DC in and AC out; plus the array's kWh and the medians. A daylight poll is a relay poll whose
 * median panel made at least 20 W. One query. Rows are [day, metric, value] for daily_metrics:
 *   pvs.array_kwh, pvs.polls, pvs.median_kwh, pvs.median_dc, pvs.median_conv, pvs.<r1c1>.kwh / .cov / .ratio / .dc / .ac
 */
export async function panelMetrics(from: string, to: string, layout: Layout | null): Promise<Array<[string, string, number]>> {
  if (!layout) return [];
  const rows = await q<{ sn: string; day: string; n: number; polls: number | null; ac: number | null; dc: number | null; first: number | null; last: number | null; nlife: number; kwsum: number }>(
    `WITH r AS (SELECT to_char(ts AT TIME ZONE '${config.timeZone}', 'YYYY-MM-DD') d, ts, sn, kw::float8 kw, kw_dc::float8 dc, kwh_lifetime::float8 life
                FROM pvs_readings WHERE ts >= $1::timestamptz AND ts < $2::timestamptz),
          p AS (SELECT d, ts, COUNT(*) OVER (PARTITION BY d)::int polls FROM r GROUP BY d, ts HAVING percentile_cont(.5) WITHIN GROUP (ORDER BY kw) >= $3)
     SELECT r.sn, r.d AS day, COUNT(p.ts)::int n, MAX(p.polls) AS polls,
            AVG(r.kw) FILTER (WHERE p.ts IS NOT NULL) ac, AVG(r.dc) FILTER (WHERE p.ts IS NOT NULL) dc,
            (array_agg(r.life ORDER BY r.ts) FILTER (WHERE r.life IS NOT NULL))[1] AS first,
            (array_agg(r.life ORDER BY r.ts DESC) FILTER (WHERE r.life IS NOT NULL))[1] AS last,
            COUNT(r.life)::int nlife, COALESCE(SUM(GREATEST(r.kw, 0)), 0)::float8 kwsum
       FROM r LEFT JOIN p ON p.d = r.d AND p.ts = r.ts GROUP BY r.sn, r.d`,
    [localMidnight(from).toISOString(), localMidnight(to).toISOString(), PANELS.sunDownKw]);
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
  const out: Array<[string, string, number]> = [];
  for (const [day, rs] of byDay) {
    const polls = Math.max(0, ...rs.map(r => Number(r.polls ?? 0)));
    const per = rs.map(r => {
      const life = Number(r.nlife) >= 2 && r.first != null && r.last != null && r.last >= r.first ? r.last - r.first : null;
      return { sn: r.sn, pos: layout.slots[r.sn], kwh: life ?? Number(r.kwsum) * 5 / 60, cov: polls ? Number(r.n) / polls : 0, ac: r.ac, dc: r.dc };
    });
    out.push([day, 'pvs.array_kwh', round(per.reduce((a, x) => a + x.kwh, 0), 3)], [day, 'pvs.polls', polls]);
    const covered = per.filter(x => x.pos && x.cov >= .9);
    const medKwh = median(covered.map(x => x.kwh)), medDc = median(covered.map(x => x.dc).filter((v): v is number => v != null));
    const medConv = median(covered.filter(x => (x.dc ?? 0) > .01 && x.ac != null).map(x => x.ac! / x.dc!));
    if (medKwh != null) out.push([day, 'pvs.median_kwh', round(medKwh, 4)]);
    if (medDc != null) out.push([day, 'pvs.median_dc', round(medDc, 4)]);
    if (medConv != null) out.push([day, 'pvs.median_conv', round(medConv, 4)]);
    for (const x of per) {
      if (!x.pos) continue;
      const k = `pvs.${posId(x.pos)}`;
      out.push([day, `${k}.kwh`, round(x.kwh, 4)], [day, `${k}.cov`, round(x.cov, 4)]);
      if (medKwh) out.push([day, `${k}.ratio`, round(x.kwh / medKwh, 4)]);
      if (x.dc != null) out.push([day, `${k}.dc`, round(x.dc, 4)]);
      if (x.ac != null) out.push([day, `${k}.ac`, round(x.ac, 4)]);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 5-minute watch ---------------------------------------------------------------- */
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: config.timeZone });
/**
 * Every 5 minutes: a `panel` push for each panel with no reading through 60 minutes of daylight polls (once per panel per day), or,
 * when the relay itself has been silent for an hour of daylight, one push about the relay and none about panels.
 */
export async function panelWatch(siteId: string, now = Date.now()) {
  const latest = await pvsLatest(now);
  if (!latest.at) return { skipped: 'no per-panel readings' };
  const newest = Date.parse(latest.at), day = localDay(new Date(now));
  if (now - newest > PANELS.relaySilentMs) {
    if (!sunUp(now) || !sunUp(newest + PANELS.relaySilentMs)) return { relay: 'silent', pushed: false, why: 'not daylight' };
    const r = await notify(siteId, 'panel', 'The PVS relay has gone quiet', `No per-panel readings since ${clock(newest)}. The Mac running the relay may be asleep or off the network; the panels themselves may be fine.`,
      { relay: true }, { key: `pvs:relay:${day}`, windowH: 24, now, url: '/?go=v-roof' });
    return { relay: 'silent', pushed: r.stored };
  }
  if (now - newest > PANELS.staleMs) return { relay: 'late' };
  const layout = await getLayout(); if (!layout) return { skipped: 'no layout yet' };
  const last = new Map(latest.inverters.map(i => [i.sn, Date.parse(i.ts)]));
  const behind = Object.entries(layout.slots).map(([sn, p]) => ({ p, ts: last.get(sn) ?? newest - 864e5 })).filter(x => newest - x.ts >= PANELS.silentPolls * 5 * 60_000);
  if (!behind.length) return { silent: 0 };
  // daylight polls since the oldest silent panel's last reading (at most a day back): one query
  const since = Math.max(Math.min(...behind.map(b => b.ts)), newest - 864e5);
  const polls = (await q<{ ms: number }>(`SELECT (extract(epoch FROM ts) * 1000)::float8 ms FROM pvs_readings WHERE ts > $1::timestamptz GROUP BY ts
     HAVING percentile_cont(.5) WITHIN GROUP (ORDER BY kw) >= $2`, [new Date(since).toISOString(), PANELS.sunDownKw])).map(r => Number(r.ms));
  const out: string[] = [];
  for (const b of behind) {
    if (polls.filter(t => t > b.ts).length < PANELS.silentPolls) continue;
    const r = await notify(siteId, 'panel', `Panel ${posName(b.p)} has stopped reporting`,
      `No reading since ${clock(b.ts)} while the rest of the array kept producing. Its microinverter or its link to the PVS has dropped out. Tap to see it on the roof.`,
      { panel: posId(b.p) }, { key: `panel:silent:${posId(b.p)}:${day}`, windowH: 24, now, url: '/?go=v-roof' });
    if (r.stored) out.push(posId(b.p));
  }
  return { silent: behind.length, notified: out };
}
