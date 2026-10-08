// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// Systems › Powerwall's Outage readiness card (views/outage.js). Its numbers come from /api/outage, which is owner-only (no guest view
// in server/src/redact.ts), so the card is owner-only too: hidden by the guest CSS (data-owner) and never asking for the route as a
// guest, where it used to get a 401 (and an /api/auth/me recheck) every minute. The owner's card loads and fills its summary.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { stubBrowser, router, flush, runFrames, badText, NOW } from './harness.js';
import { coreFixtures } from './fixtures-core.js';

vi.mock('three', async importOriginal => ({ ...(await importOriginal()), WebGLRenderer: (await import('./fakegl.js')).FakeRenderer }));

let mountOutageCard, f;
beforeAll(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  stubBrowser();
  document.body.innerHTML = '<div id="screen"></div>';
  f = router({ outage: coreFixtures(NOW).outage });
  vi.stubGlobal('fetch', f);
  ({ mountOutageCard } = await import('../../../web/src/views/outage.js'));
});
afterAll(() => vi.useRealTimers());
const slot = () => { const s = document.createElement('div'); document.getElementById('screen').appendChild(s); return s; };

describe('Outage readiness card', () => {
  it('is marked owner-only, so the guest stylesheet hides it', () => {
    const card = mountOutageCard({ guest: false, calm: false }, slot());
    expect(document.getElementById('sysOutage').hasAttribute('data-owner')).toBe(true);
    expect(card).toBeTruthy();
  });
  it('a guest’s card never asks for /api/outage, on screen or on the frame loop', async () => {
    const n = f.calls.length, c = mountOutageCard({ guest: true, calm: false }, slot());
    await flush(4);
    c.frame(.016, performance.now() + 120_000); runFrames(2); await flush(4);
    expect(f.calls.slice(n).filter(x => x.path === 'outage')).toEqual([]);
  });
  it('the owner’s card loads /api/outage and fills its summary', async () => {
    const n = f.calls.length, s = slot(), c = mountOutageCard({ guest: false, calm: false }, s);
    await flush(6);
    c.frame(.016, performance.now() + 120_000); await flush(6);
    expect(f.calls.slice(n).filter(x => x.path === 'outage').length).toBeGreaterThan(0);
    expect(s.querySelector('[data-sum]').textContent).not.toBe('—');
    expect(badText(s)).toEqual([]);
  });
});
