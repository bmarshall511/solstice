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
    // the writes that answer with the fresh payload (server: the pool and AC command routes return poolDetail / acDetail; loads/label the list)
    'POST appliances/pool/command': A['appliances/pool'], 'POST appliances/pool/clearup': A['appliances/pool'],
    'POST appliances/ac/command': A['appliances/ac'], 'POST appliances/ac/hold': A['appliances/ac'], 'POST appliances/ac/suggestion': A['appliances/ac'], 'POST appliances/ac/nudge': A['appliances/ac'],
    'POST loads/label': C.loads,
    site: { raw: { site_name: 'Home', components: { battery: true, solar: true } } },
    'auth/me': { mode: 'single', owner: true, site: { id: 'site-test' }, ownerName: 'Test Owner' },
    ...over,
  };
}
/**
 * What a share-link guest can read, made by passing each owner payload through the server's own guest views (server/src/redact.ts
 * GUEST_GET, the allow-lists access.ts serves guests through); every other route answers 401, as the guest gate does. The coarse
 * location is the server's coarseLocation() of the fixtures' fake site.
 */
export async function guestRoutes(over = {}) {
  const { GUEST_GET } = await import('../../../server/src/redact.ts'), { coarseLocation } = await import('../../../server/src/site.ts');
  const O = ownerRoutes(), out = { __fallback: 401 };
  for (const [path, view] of GUEST_GET) {
    const key = path.slice(5), src = O[key];
    out[key] = typeof src === 'function' ? req => view(src(req)) : view(src);
  }
  out.settings = { location: coarseLocation({ lat: 30, lon: -97, zip: '00000' }) };
  const G = guestFixtures(NOW);
  out['auth/me'] = G['auth/me'];
  // the route folds AC, always-on and unexplained into "other" for a guest before the view picks the parts (changedFor guest)
  out.changed = req => ({ ...G.changed, scope: req.query.scope, date: req.query.date ?? '2026-09-28', to: req.query.date ?? '2026-10-04' });
  return { ...out, ...over };
}
export const external = () => weatherFixtures(NOW);
export { NOW, TODAY };
