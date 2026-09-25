// Site location from the environment (server/src/site.ts): env parsing, the startup warning, and coarseLocation rounding.
// Every coordinate and ZIP here is synthetic. The real ones live only in .env and Vercel env (rule 5).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSiteEnv, siteLocation, exactLocation, coarseLocation, type SiteLocation } from '../../server/src/site.js';

// Importing site.ts runs its startup check; hide that one warning when the test env has no SITE_* (afterEach restores console.warn).
vi.hoisted(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const KEYS = ['SITE_LAT', 'SITE_LON', 'SITE_ZIP'] as const;
type SiteEnv = Partial<Record<(typeof KEYS)[number], string>>;
const FULL: SiteEnv = { SITE_LAT: '12.34', SITE_LON: '-56.78', SITE_ZIP: '12345' };

let saved: SiteEnv;
beforeEach(() => { saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]])); });
afterEach(() => { setEnv(saved); vi.restoreAllMocks(); });
function setEnv(env: SiteEnv) { for (const k of KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } }

/** A fresh copy of the module, so its import-time check (and its warn-once flag) runs again. */
async function freshSite() { vi.resetModules(); return import('../../server/src/site.js'); }

describe('parseSiteEnv', () => {
  it.each([
    ['1 all three set', FULL, { lat: 12.34, lon: -56.78, zip: '12345' }],
    ['2 whitespace is trimmed', { SITE_LAT: ' 12.34 ', SITE_LON: '\t-56.78\n', SITE_ZIP: ' 12345 ' }, { lat: 12.34, lon: -56.78, zip: '12345' }],
    ['3 ZIP+4 keeps the 5-digit ZIP', { ...FULL, SITE_ZIP: '12345-6789' }, { lat: 12.34, lon: -56.78, zip: '12345' }],
    ['4 a leading zero stays (the ZIP is a string)', { ...FULL, SITE_ZIP: '01234' }, { lat: 12.34, lon: -56.78, zip: '01234' }],
    ['5 integers and a leading +', { SITE_LAT: '+12', SITE_LON: '56', SITE_ZIP: '12345' }, { lat: 12, lon: 56, zip: '12345' }],
    ['6 the range limits are allowed', { SITE_LAT: '-90', SITE_LON: '180.0', SITE_ZIP: '12345' }, { lat: -90, lon: 180, zip: '12345' }],
  ])('case %s', (_name, env, location) => {
    expect(parseSiteEnv(env)).toEqual({ location, problems: [] });
  });

  it.each([
    ['7 nothing set', {}, ['SITE_LAT is not set', 'SITE_LON is not set', 'SITE_ZIP is not set']],
    ['8 latitude missing', { SITE_LON: '-56.78', SITE_ZIP: '12345' }, ['SITE_LAT is not set']],
    ['9 longitude empty', { SITE_LAT: '12.34', SITE_LON: '  ', SITE_ZIP: '12345' }, ['SITE_LON is not set']],
    ['10 not a number', { ...FULL, SITE_LAT: 'abc' }, ['SITE_LAT must be decimal degrees between -90 and 90']],
    ['11 comma decimal', { ...FULL, SITE_LAT: '12,34' }, ['SITE_LAT must be decimal degrees between -90 and 90']],
    ['12 exponent', { ...FULL, SITE_LON: '1e2' }, ['SITE_LON must be decimal degrees between -180 and 180']],
    ['13 hex', { ...FULL, SITE_LON: '0x1F' }, ['SITE_LON must be decimal degrees between -180 and 180']],
    ['14 latitude past the pole', { ...FULL, SITE_LAT: '90.01' }, ['SITE_LAT must be decimal degrees between -90 and 90']],
    ['15 longitude past the antimeridian', { ...FULL, SITE_LON: '-180.5' }, ['SITE_LON must be decimal degrees between -180 and 180']],
  ])('case %s: no location', (_name, env, problems) => {
    expect(parseSiteEnv(env)).toEqual({ location: null, problems });
  });

  it.each([
    ['16 ZIP missing', { SITE_LAT: '12.34', SITE_LON: '-56.78' }, 'SITE_ZIP is not set'],
    ['17 ZIP too short', { ...FULL, SITE_ZIP: '1234' }, 'SITE_ZIP must be a 5-digit ZIP code'],
    ['18 ZIP not digits', { ...FULL, SITE_ZIP: 'ABCDE' }, 'SITE_ZIP must be a 5-digit ZIP code'],
  ])('case %s: coordinates still work, ZIP is null', (_name, env, problem) => {
    expect(parseSiteEnv(env)).toEqual({ location: { lat: 12.34, lon: -56.78, zip: null }, problems: [problem] });
  });

  it('19 reads process.env at call time, not at import', () => {
    setEnv({});
    expect(siteLocation()).toBeNull();
    setEnv(FULL);
    expect(siteLocation()).toEqual({ lat: 12.34, lon: -56.78, zip: '12345' });
  });
});

describe('startup warning', () => {
  it('20 warns once at import when nothing is set, naming all three variables', async () => {
    setEnv({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const site = await freshSite();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SITE_LAT is not set; SITE_LON is not set; SITE_ZIP is not set');
    expect(warn.mock.calls[0][0]).toContain('Weather, sun position, NWS alerts');
    expect(site.checkSiteEnv()).toHaveLength(3);   // still reports the problems…
    expect(warn).toHaveBeenCalledTimes(1);          // …but warns only once per process
  });

  it('21 is silent at import when all three are set', async () => {
    setEnv(FULL);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const site = await freshSite();
    expect(warn).not.toHaveBeenCalled();
    expect(site.checkSiteEnv()).toEqual([]);
  });

  it('22 a missing ZIP alone warns about the ZIP, not the weather', async () => {
    setEnv({ SITE_LAT: '12.34', SITE_LON: '-56.78' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await freshSite();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('SITE_ZIP is not set');
    expect(warn.mock.calls[0][0]).not.toContain('SITE_LAT');
  });

  it('23 checkSiteEnv takes an env and a logger, and still warns only once', async () => {
    setEnv(FULL);
    const site = await freshSite(), warn = vi.fn();
    expect(site.checkSiteEnv({ SITE_LAT: 'north' }, warn)).toEqual(['SITE_LAT must be decimal degrees between -90 and 90', 'SITE_LON is not set', 'SITE_ZIP is not set']);
    expect(site.checkSiteEnv({}, warn)).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('exactLocation', () => {
  it('24 adds precision "exact" and keeps the values as set', () => {
    expect(exactLocation({ lat: 12.34, lon: -56.78, zip: '12345' })).toEqual({ lat: 12.34, lon: -56.78, zip: '12345', precision: 'exact' });
  });
  it('25 defaults to the env, and is null when the coordinates are unset', () => {
    setEnv(FULL);
    expect(exactLocation()).toEqual({ lat: 12.34, lon: -56.78, zip: '12345', precision: 'exact' });
    setEnv({ SITE_ZIP: '12345' });
    expect(exactLocation()).toBeNull();
  });
});

describe('coarseLocation', () => {
  const at = (lat: number, lon: number, zip: string | null = '12345'): SiteLocation => ({ lat, lon, zip });

  it.each([
    ['26 ordinary values', 12.34, -56.78, 12.3, -56.8],
    ['27 exact halves round away from zero', 12.25, -12.25, 12.3, -12.3],
    ['28 exact halves, the other side', -56.75, 56.75, -56.8, 56.8],
    ['29 just under a half rounds down', 12.2499, -12.2499, 12.2, -12.2],
    ['30 just over a half rounds up', 12.2501, -12.2501, 12.3, -12.3],
    ['31 already on the grid', 12.3, -56.8, 12.3, -56.8],
    ['32 whole degrees', 45, -90, 45, -90],
    ['33 near zero', 0.05, -0.05, 0.1, -0.1],
    ['34 the poles and the antimeridian', 89.96, -179.96, 90, -180],
    ['35 the other pole', -89.96, 179.96, -90, 180],
  ])('case %s', (_name, lat, lon, cLat, cLon) => {
    expect(coarseLocation(at(lat, lon))).toEqual({ lat: cLat, lon: cLon, zip: '123xx', precision: 'coarse' });
  });

  it('36 tiny values round to 0, never -0', () => {
    const c = coarseLocation(at(-0.04, -0.0001))!;
    expect(Object.is(c.lat, 0)).toBe(true);
    expect(Object.is(c.lon, 0)).toBe(true);
  });

  it('37 never more precise than 0.1° and never more than 0.05° from the truth', () => {
    for (let i = 0; i <= 2000; i++) {                  // 2001 points pole to pole and across all longitudes, mostly off the 0.1° grid
      const lat = Math.min(90, -90 + i * 0.0901), lon = Math.min(180, -180 + i * 0.1801), c = coarseLocation(at(lat, lon))!;
      for (const [r, x] of [[c.lat, lat], [c.lon, lon]]) {
        expect(Math.abs(r * 10 - Math.round(r * 10))).toBeLessThan(1e-9);
        expect(Math.abs(r - x)).toBeLessThanOrEqual(0.05 + 1e-9);
      }
    }
  });

  it.each([
    ['38 five digits', '12345', '123xx'],
    ['39 a leading zero stays', '01234', '012xx'],
    ['40 no ZIP stays null', null, null],
  ])('case %s', (_name, zip, coarse) => {
    expect(coarseLocation(at(12.34, -56.78, zip))?.zip).toBe(coarse);
  });

  it('41 does not change its input', () => {
    const loc = at(12.34, -56.78);
    coarseLocation(loc);
    expect(loc).toEqual({ lat: 12.34, lon: -56.78, zip: '12345' });
  });

  it('42 defaults to the env, and is null when the coordinates are unset', () => {
    setEnv({ SITE_LAT: '12.34', SITE_LON: '-56.78', SITE_ZIP: '01234' });
    expect(coarseLocation()).toEqual({ lat: 12.3, lon: -56.8, zip: '012xx', precision: 'coarse' });
    setEnv({});
    expect(coarseLocation()).toBeNull();
  });
});
