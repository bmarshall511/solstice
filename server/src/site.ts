// Where the site is. The repo and the web bundle are public, so the coordinates and ZIP are never literals in the code:
// they come from the environment (SITE_LAT, SITE_LON, SITE_ZIP in .env locally and in Vercel env). The owner's app gets
// the exact values with /api/settings; coarseLocation() is the rounded form for anything a guest may see.

export type SiteLocation = { lat: number; lon: number; zip: string | null };
export type ServedLocation = SiteLocation & { precision: 'exact' | 'coarse' };
type Env = Record<string, string | undefined>;

const DECIMAL = /^[+-]?\d{1,3}(\.\d+)?$/;
const ZIP = /^(\d{5})(-\d{4})?$/;

/** Parse SITE_LAT / SITE_LON (decimal degrees) and SITE_ZIP (5 digits or ZIP+4). The coordinates are needed together; the ZIP is optional. */
export function parseSiteEnv(env: Env = process.env): { location: SiteLocation | null; problems: string[] } {
  const problems: string[] = [];
  const coord = (key: 'SITE_LAT' | 'SITE_LON', max: number) => {
    const raw = env[key]?.trim();
    if (!raw) { problems.push(`${key} is not set`); return null; }
    const v = Number(raw);
    if (!DECIMAL.test(raw) || Math.abs(v) > max) { problems.push(`${key} must be decimal degrees between -${max} and ${max}`); return null; }
    return v;
  };
  const lat = coord('SITE_LAT', 90), lon = coord('SITE_LON', 180);
  const rawZip = env.SITE_ZIP?.trim(), zipMatch = rawZip ? ZIP.exec(rawZip) : null;
  if (!rawZip) problems.push('SITE_ZIP is not set');
  else if (!zipMatch) problems.push('SITE_ZIP must be a 5-digit ZIP code');
  return { location: lat == null || lon == null ? null : { lat, lon, zip: zipMatch?.[1] ?? null }, problems };
}

/** The site's exact location from the environment, or null when SITE_LAT/SITE_LON are missing or malformed. */
export const siteLocation = (env: Env = process.env): SiteLocation | null => parseSiteEnv(env).location;

/** What the owner's app receives (the /api/settings `location` field). */
export function exactLocation(loc: SiteLocation | null = siteLocation()): ServedLocation | null {
  return loc && { ...loc, precision: 'exact' };
}

/** 0.1° steps, about 11 km: halves round away from zero, and -0 becomes 0. */
const tenth = (v: number) => { const r = Number(v.toFixed(1)); return r === 0 ? 0 : r; };

/** The location as a guest may see it: coordinates rounded to 0.1° and the ZIP cut to its first three digits ("123xx"). */
export function coarseLocation(loc: SiteLocation | null = siteLocation()): ServedLocation | null {
  if (!loc) return null;
  return { lat: tenth(loc.lat), lon: tenth(loc.lon), zip: loc.zip ? `${loc.zip.slice(0, 3)}xx` : null, precision: 'coarse' };
}

let warned = false;
/** Logs one clear warning per process when the location env is missing or malformed. Returns the problems found. */
export function checkSiteEnv(env: Env = process.env, warn: (message: string) => void = console.warn): string[] {
  const { location, problems } = parseSiteEnv(env);
  if (problems.length && !warned) {
    warned = true;
    warn(`[solstice] Site location: ${problems.join('; ')}. ` + (location
      ? 'The Settings row shows no ZIP until SITE_ZIP is set.'
      : 'Weather, sun position, NWS alerts, the AC heat model and the pool forecast stay off until SITE_LAT and SITE_LON are set (.env locally, Vercel env in production).'));
  }
  return problems;
}

checkSiteEnv(); // runs when the server or the Vercel function starts (app.ts imports this module)
