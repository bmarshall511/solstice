// Every repeating request goes through here. A task runs at once, then every `ms` while the tab is visible; nothing runs while it
// is hidden (a forgotten desktop tab used to keep Neon and Tesla busy all day), and coming back runs whatever is overdue straight
// away. A task never overlaps itself: a slow call isn't started again until it has finished.
const tasks = new Set();
async function run(t) {
  if (t.busy) return;
  t.busy = true; t.last = Date.now();
  try { await t.fn(); } catch (e) { console.warn(e?.message ?? e); } finally { t.busy = false; }
}
const due = () => { if (document.hidden) return; const n = Date.now(); for (const t of tasks) if (n - t.last >= t.ms) run(t); };
setInterval(due, 1000);
document.addEventListener('visibilitychange', due);
/** Run `fn` now and every `ms` while visible. Returns a handle for `stop`. */
export function every(ms, fn) { const t = { ms, fn, last: 0, busy: false }; tasks.add(t); if (!document.hidden) run(t); return t; }
export const stop = t => { if (t) tasks.delete(t); };
