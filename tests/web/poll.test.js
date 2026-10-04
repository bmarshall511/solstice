// web/src/lib/poll.js: nothing runs while the tab is hidden, coming back runs what is overdue, and a task never overlaps itself.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const listeners = {};
const doc = { hidden: false, addEventListener: (k, f) => { listeners[k] = f; } };
let P;
beforeAll(async () => { vi.useFakeTimers(); vi.stubGlobal('document', doc); P = await import('../../web/src/lib/poll.js'); });

describe('poll scheduler', () => {
  it('POLL-1 runs at once, then on its interval while visible; not while hidden; overdue work runs on return', async () => {
    const fn = vi.fn(async () => {}), t = P.every(60_000, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(fn).toHaveBeenCalledTimes(2);
    doc.hidden = true; await vi.advanceTimersByTimeAsync(10 * 60_000); expect(fn).toHaveBeenCalledTimes(2);   // a hidden tab asks for nothing
    doc.hidden = false; listeners.visibilitychange(); await Promise.resolve(); expect(fn).toHaveBeenCalledTimes(3);   // back: at once
    P.stop(t); await vi.advanceTimersByTimeAsync(5 * 60_000); expect(fn).toHaveBeenCalledTimes(3);
  });
  it('POLL-2 a slow task is not started again until it finishes, and a failure does not stop it', async () => {
    let release; const fn = vi.fn(() => new Promise(r => { release = r; }));
    const t = P.every(1_000, fn);
    await vi.advanceTimersByTimeAsync(5_000); expect(fn).toHaveBeenCalledTimes(1);                    // still running: no overlap
    release(); await vi.advanceTimersByTimeAsync(1_000); expect(fn).toHaveBeenCalledTimes(2);
    P.stop(t);
    const bad = vi.fn(async () => { throw new Error('offline'); }), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t2 = P.every(1_000, bad); await vi.advanceTimersByTimeAsync(2_000);
    expect(bad.mock.calls.length).toBeGreaterThanOrEqual(2); expect(warn).toHaveBeenCalledWith('offline');
    P.stop(t2); warn.mockRestore();
  });
});
