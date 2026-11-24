// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// Boot while the database is down (2026-11-24: Neon's spent quota). /api/auth/me answers 503 with the server's sentence, and the
// sign-in card shows that sentence. It used to set "Can't reach the Solstice server." and then wipe it before showing the card,
// leaving only the bare "internal error" a click on Sign in brought back.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { bootApp, $, until } from './harness.js';

vi.mock('three', async importOriginal => ({ ...(await importOriginal()), WebGLRenderer: (await import('./fakegl.js')).FakeRenderer }));
vi.mock('../../../web/src/views/nowhub.js', async importOriginal => { const m = await importOriginal(); return { ...m, initNowTop: S => { globalThis.__S = S; return m.initNowTop(S); } }; });

const SENTENCE = 'Database unavailable: its monthly usage limit is reached.';
const down = { __status: 503, body: { error: SENTENCE, reason: 'db_quota', id: 'x' } };

beforeAll(async () => {
  globalThis.__S = {};   // bootApp wants S captured; this boot never reaches the Now screen
  await bootApp({ 'auth/me': down, 'POST auth/login': down, __fallback: 503 }, {}, { wait: false });
  await until(() => !$('auth').hidden, 10_000, 'the sign-in card');
});
afterAll(async () => { await new Promise(r => setTimeout(r, 150)); vi.useRealTimers(); });

describe('boot during a database outage', () => {
  it('the sign-in card names the outage in the server’s words', () => {
    expect($('authErr').textContent).toBe(SENTENCE);
    expect($('authErr').textContent).not.toMatch(/internal error/i);
  });
});
