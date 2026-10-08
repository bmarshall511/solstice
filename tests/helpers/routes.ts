// The routes the Express app serves, read from its router at runtime (no hand-written list), including routers mounted with
// app.use (learn/api.ts's learnRouter on /api, pvs.ts's pvsRouter on /api/pvs).
//
// Express 5's router (the `router` package) keeps no mount path on a `use` layer: path-to-regexp v8 compiles it into a matcher and
// throws the string away. So this module wraps Router.prototype.use, before the app is imported, to note each mounted function's
// path. Import it BEFORE server/src/app.js (a static import placed above the app's import, or awaited before a dynamic import).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// the same CommonJS instance express itself requires (node_modules/router), so the wrapper sees every app.use
const Router = require('router') as { prototype: { use: (...a: unknown[]) => unknown; __mountNoted?: boolean } };
const MOUNT = Symbol.for('solstice.test.mountpath');

if (!Router.prototype.__mountNoted) {
  const use = Router.prototype.use;
  Router.prototype.use = function (this: unknown, ...args: unknown[]) {
    let path: unknown = '/', fns = args;
    if (typeof args[0] !== 'function') { path = args[0]; fns = args.slice(1); }
    for (const fn of fns.flat(Infinity)) if (typeof fn === 'function' && typeof path === 'string') (fn as any)[MOUNT] ??= path;
    return use.apply(this, args);
  };
  Router.prototype.__mountNoted = true;
}

export type RouteEntry = { method: string; path: string; layer: any };
const join = (a: string, b: string) => (a.replace(/\/+$/, '') + (b === '/' ? '' : b)) || '/';

/** Every [METHOD, path] the app serves, sub-routers included, in stack order. Throws on a mounted router whose path was not noted
 *  (this module was imported after the app) or a route given as a regular expression (no path to report). */
export function mountedRoutes(app: any): RouteEntry[] {
  const out: RouteEntry[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const l of stack) {
      if (l.route) {
        if (typeof l.route.path !== 'string') throw new Error(`a route with a non-string path under ${prefix}`);
        for (const m of Object.keys(l.route.methods)) if (m !== '_all') out.push({ method: m.toUpperCase(), path: join(prefix, l.route.path), layer: l });
      } else if (Array.isArray(l.handle?.stack)) {
        const p = l.handle[MOUNT];
        if (typeof p !== 'string') throw new Error('a mounted router without a noted path: import tests/helpers/routes.ts before the app');
        walk(l.handle.stack, join(prefix, p));
      }
    }
  };
  walk((app.router ?? app._router).stack, '');
  return out;
}

/** A concrete URL for a route path: each :param gets a harmless placeholder. */
export const concrete = (path: string) => path.replace(/:date\b/g, '2026-09-15').replace(/:id\b/g, 'x').replace(/:(\w+)/g, 'x');
