// ScreenLogic session time limits and the evening pool cron's budget. Kept apart from screenlogic.ts so tests that mock the
// controller module still get the real numbers.

/** The whole session (dispatcher, unit, `fn`) must finish within this: a read 20 s, a write 40 s (code review C-01). */
export const READ_DEADLINE_MS = 20_000;
export const WRITE_DEADLINE_MS = 40_000;
/** The evening pool cron's budget: Vercel stops the function at 60 s, so its read and write must both end well inside it (a read of
 *  20 s plus a write of 40 s did not, 2026-10-11). The read leaves WRITE_RESERVE_MS for the write; a write is not started with less
 *  than MIN_WRITE_MS left, since one cut off part-way leaves old and new programs on the controller. */
export const CRON_BUDGET_MS = 50_000, WRITE_RESERVE_MS = 25_000, MIN_WRITE_MS = 15_000;
/** A session deadline that ends by `by` (epoch ms; none = no budget) and never exceeds `capMs`. */
export const deadlineWithin = (capMs: number, by?: number | null, now = Date.now()) => by == null ? capMs : Math.max(0, Math.min(capMs, by - now));
