// Grid alerts (mockup ab): a push when the grid goes down, one when the Powerwalls fall below 30% while it is still down, and one when it
// comes back. Runs in the 5-minute watch after the storm step, which has already refreshed Tesla's live status, so it adds no Tesla
// call. Read-only towards every device. State per outage in kv `<site>:grid:outage`; each push is deduped on the outage's start.
import { one, kv } from './db.js';
import { notify } from './notify.js';
import { outageDetail } from './outage.js';
import { tripAway } from './vacation/trip.js';

export const LOW_SOC_PCT = 30, FRESH_MS = 10 * 60_000;
type OutageState = { since: number; minSoc: number | null; warned: boolean };
type Reading = { ts: string; grid_status: string | null; island_status: string | null; soc: number | null; load_w: number | null };
/** How long the Powerwalls last now and with the AC off (the outage view's estimate), for the push text. Injectable for tests. */
export type Estimate = { hours: number | null; hoursNoAc: number | null; drawKw: number | null };
export async function outageEstimate(siteId: string): Promise<Estimate> {
  const settings = await kv.get<Record<string, any>>('settings:owner') ?? {}, d = await outageDetail(siteId, settings);
  return { hours: d.scenarios.asis?.backupH ?? null, hoursNoAc: d.scenarios.noac?.backupH ?? null, drawKw: d.drawKw ?? null };
}

/** Down: Tesla says a grid status other than Active, or an off-grid island. A missing or empty status ('' or null) is unknown, never down. */
export const isDown = (r: Pick<Reading, 'grid_status' | 'island_status'>) => (!!r.grid_status && r.grid_status !== 'Active') || /off_grid/.test(r.island_status ?? '');
/** Whether a reading says anything about the grid at all. */
const knowsGrid = (r: Pick<Reading, 'grid_status' | 'island_status'>) => !!r.grid_status || /off_grid/.test(r.island_status ?? '');
const clock = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
/** "3:42–9:52 PM" (one AM/PM when both share it), "11:40 AM–1:05 PM" otherwise. */
const range = (a: number, b: number) => { const x = clock(a), y = clock(b); return x.slice(-2) === y.slice(-2) ? `${x.slice(0, -3)}–${y}` : `${x}–${y}`; };
const span = (ms: number) => { const m = Math.max(1, Math.round(ms / 60_000)); return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ''}`; };
export const hoursText = (h: number | null) => h == null ? null : h < 1 ? 'under 1 h' : `${h < 10 ? Math.round(h * 2) / 2 : Math.round(h)} h`;

/** Every 5 minutes. Fresh readings only: a reading older than 10 minutes never starts or ends an outage. */
export async function gridWatch(siteId: string, now = Date.now(), estimate: (siteId: string) => Promise<Estimate> = outageEstimate) {
  const r = await one<Reading>('SELECT ts, grid_status, island_status, soc, load_w FROM readings WHERE site_id = $1 ORDER BY ts DESC LIMIT 1', [siteId]);
  if (!r || now - Number(r.ts) > FRESH_MS) return { skipped: 'no fresh reading' };
  if (!knowsGrid(r)) return { skipped: 'no grid status' };   // an unknown status neither starts nor ends an outage
  const key = `${siteId}:grid:outage`, st = await kv.get<OutageState | null>(key), down = isDown(r), soc = r.soc == null ? null : Math.round(r.soc);
  const at = Number(r.ts), url = '/?go=v-now';
  if (down && !st) {
    // the outage started at the first reading after the last one with the grid up (as /api/now works it out)
    const up = await one<{ ts: string }>(`SELECT ts FROM readings WHERE site_id = $1 AND grid_status = 'Active' AND island_status NOT LIKE '%off_grid%' AND ts < $2 ORDER BY ts DESC LIMIT 1`, [siteId, at]);
    const first = await one<{ ts: string }>('SELECT MIN(ts) ts FROM readings WHERE site_id = $1 AND ts > $2', [siteId, up?.ts ?? 0]);
    const since = Number(first?.ts ?? at);
    await kv.set(key, { since, minSoc: soc, warned: false } satisfies OutageState);
    const e = await estimate(siteId).catch(() => ({ hours: null, hoursNoAc: null, drawKw: null }));
    const kw = e.drawKw ?? (r.load_w != null ? r.load_w / 1000 : null), h = hoursText(e.hours), away = await tripAway(siteId, now);
    // mockup ak frame 4: during a trip nobody can switch the AC off, so the push says there is nothing to do
    const res = await notify(siteId, 'grid', away ? 'Grid down · house on Powerwalls' : 'Grid down · on Powerwalls',
      away ? `Since ${clock(since)}. Powerwalls ${soc ?? '?'}%${h ? `: about ${h} at the empty house's ${kw?.toFixed(1)} kW, longer with the sun` : ''}. Nothing to do; Solstice will tell you when the grid is back.`
        : `Since ${clock(since)}. Powerwalls ${soc ?? '?'}%${h ? `, about ${h} at ${kw?.toFixed(1)} kW now; longer with the AC off` : ''}. Tap for the outage view.`,
      { event: 'down', since, soc }, { key: `grid:down:${since}`, windowH: 72, now, url });
    return { event: 'down', since, notified: res.stored };
  }
  if (down && st) {
    const minSoc = soc == null ? st.minSoc : st.minSoc == null ? soc : Math.min(st.minSoc, soc);
    if (soc != null && soc < LOW_SOC_PCT && !st.warned) {
      await kv.set(key, { ...st, minSoc, warned: true });
      const e = await estimate(siteId).catch(() => ({ hours: null, hoursNoAc: null, drawKw: null }));
      const kw = e.drawKw ?? (r.load_w != null ? r.load_w / 1000 : null), h = hoursText(e.hours);
      const gain = e.hours != null && e.hoursNoAc != null && e.hoursNoAc - e.hours >= .5 && !(await tripAway(siteId, now)) ? hoursText(e.hoursNoAc - e.hours) : null;
      const res = await notify(siteId, 'gridLow', `Powerwalls at ${soc}% · grid still down`,
        `${h ? `About ${h} left at ${kw?.toFixed(1)} kW. ` : ''}${gain ? `AC off adds about ${gain}. ` : ''}Down since ${clock(st.since)}.`,
        { event: 'low', since: st.since, soc }, { key: `grid:low:${st.since}`, windowH: 72, now, url });
      return { event: 'low', soc, notified: res.stored };
    }
    if (minSoc !== st.minSoc) await kv.set(key, { ...st, minSoc });
    return { down: true, since: st.since };
  }
  if (!down && st) {
    await kv.set(key, null as any);
    // the grid came back at the first reading with it up after the outage started
    const back = await one<{ ts: string }>(`SELECT MIN(ts) ts FROM readings WHERE site_id = $1 AND ts > $2 AND grid_status = 'Active' AND island_status NOT LIKE '%off_grid%'`, [siteId, st.since]);
    const end = Number(back?.ts ?? at), low = st.minSoc;
    const res = await notify(siteId, 'grid', 'Grid is back',
      `Out ${span(end - st.since)} (${range(st.since, end)}).${low != null ? ` The Powerwalls carried the house down to ${low}%; they recharge from here.` : ''}`,
      { event: 'back', since: st.since, end, minSoc: low }, { key: `grid:back:${st.since}`, windowH: 72, now, url });
    return { event: 'back', since: st.since, end, notified: res.stored };
  }
  return { down: false };
}
