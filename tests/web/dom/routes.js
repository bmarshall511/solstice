// The full owner (and guest) route tables the booted-app tests serve: tests/web/dom/fixtures-core.js and fixtures-appl.js, plus the
// per-date answers (/api/day and /api/changed take a date) built from them.
import { coreFixtures, weatherFixtures, guestFixtures, changedClean } from './fixtures-core.js';
import { applFixtures } from './fixtures-appl.js';
import { NOW, TODAY } from './harness.js';

/** /api/day for any date: today's payload as generated; another date gets the same shape with its own date (a full day). */
export const dayFor = (base, date) => (date && date !== base.date ? { ...structuredClone(base), date } : base);

/** Every owner route, keyed as harness.router() wants. `over` replaces entries (a value, or a (req) => payload function). */
export function ownerRoutes(over = {}) {
  const C = coreFixtures(NOW), A = applFixtures(NOW);
  return {
    ...C, ...A,
    day: req => dayFor(C.day, req.query.date),
    changed: req => ({ ...changedClean(NOW), scope: req.query.scope ?? 'day', date: req.query.date ?? C.changed?.date, to: req.query.date ?? C.changed?.date }),
    'POST sync': C.sync,
    site: { raw: { site_name: 'Home', components: { battery: true, solar: true } } },
    'auth/me': { mode: 'single', owner: true, site: { id: 'site-test' }, ownerName: 'Test Owner' },
    ...over,
  };
}
/** What a share-link guest can read; every other GET answers 401 as the server's guest gate does. */
export function guestRoutes(over = {}) {
  const G = guestFixtures(NOW);
  return { ...G, day: req => dayFor(G.day, req.query.date), ...over };
}
export const external = () => weatherFixtures(NOW);
export { NOW, TODAY };
