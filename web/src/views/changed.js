// I-18 "What changed" on Now (approved mockup mockups/am-ideas.html frame 3): yesterday's change in kWh bought, as the lowest banner
// in Now's banner slot (views/nowhub.js) from 06:00 to 11:00. Why opens History › Day for yesterday; Dismiss hides it until tomorrow
// (this device only, localStorage). No push. Owner-only: a guest never loads it.
import { api } from '../lib/api.js';
import { localDate, localHour, addDays } from '../lib/util.js';
import { morningBanner, DISMISS_KEY, MORNING_FROM, MORNING_TO } from '../lib/changed.js';
import { showDay } from './history.js';

let yday = null;
const dismissed = () => { try { return localStorage.getItem(DISMISS_KEY); } catch { return null; } };

/** Every few minutes from main.js: in the morning window, yesterday's answer once it is complete (the nightly runs before 06:00). */
export async function loadChanged(S) {
  if (S.guest) return;
  const h = localHour(), y = addDays(localDate(), -1);
  if (h < MORNING_FROM || h >= MORNING_TO) { if (yday) { yday = null; S.redrawNow?.(); } return; }
  if (yday?.date === y) return;
  const c = await api.changed('day', y).catch(() => null);
  if (c?.home) { yday = c; S.redrawNow?.(); }
}
/** The banner candidate, or null (lib/changed.js morningBanner: the window, the 2 kWh threshold, Dismiss). */
export const changedBanner = () => morningBanner(yday, { hour: localHour(), today: localDate(), dismissed: dismissed() });
/** Dismiss: hidden on this device until tomorrow. */
export function dismissChanged(S) { try { localStorage.setItem(DISMISS_KEY, localDate()); } catch { /* private mode: it shows again next load */ } S.redrawNow?.(); }
/** Why: History › Day for yesterday. */
export function whyChanged(S) { showDay(S, addDays(localDate(), -1)); S.nav?.go('v-hist'); }
