// Public quasi-identifiers (audit 10b, S-09 / M-6): the installer's name and the exact install dates are not in the public repo, and a
// guest never sees the installer, the install date or Tesla's install timestamp.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { GUEST_GET } from '../../server/src/redact.js';
import { SOLAR, INSTALL_YEAR, systemYear, yearsSinceInstall } from '../../server/src/system.js';

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('installer and install dates', () => {
  afterEach(() => { delete process.env.SOLAR_INSTALLER; delete process.env.SOLAR_INSTALLED_ON; });

  it('QI-1 system.ts holds no YYYY-MM-DD date and no installer name, only the install year', () => {
    const s = src('server/src/system.ts');
    expect(s.match(/\d{4}-\d\d-\d\d/g) ?? []).toEqual([]);
    expect(s).not.toMatch(/installer:\s*['"`]/);
    expect(INSTALL_YEAR).toBeGreaterThan(2000);
  });
  it('QI-2 docs/system-specs.md names no installer and no exact install or contract date', () => {
    const d = src('docs/system-specs.md');
    expect(d.match(/\b\d{4}-\d\d-\d\d\b/g)?.filter(x => !x.startsWith('2026')) ?? []).toEqual([]);   // 2026: the app's own change log
    expect(d).toMatch(/^- \*\*Installer\*\*:/m);                       // the labour-warranty line no longer names the company
    expect(d).toMatch(/installer's contract \(\d{4}\)/);
  });
  it('QI-3 unset, installer is null and installedOn is the year; the env fills both at call time', () => {
    expect(SOLAR.installer).toBeNull();
    expect(SOLAR.installedOn).toBe(String(INSTALL_YEAR));
    process.env.SOLAR_INSTALLER = 'Example Solar Co'; process.env.SOLAR_INSTALLED_ON = `${INSTALL_YEAR}-06-01`;
    expect({ ...SOLAR }).toMatchObject({ installer: 'Example Solar Co', installedOn: `${INSTALL_YEAR}-06-01` });
    process.env.SOLAR_INSTALLED_ON = 'not a date';
    expect(SOLAR.installedOn).toBe(String(INSTALL_YEAR));
  });
  it('QI-4 with the year alone the system year counts from the end of the install year (never ahead of the real one)', () => {
    expect(systemYear(new Date(Date.UTC(INSTALL_YEAR + 1, 11, 30)))).toBe(1);
    expect(systemYear(new Date(Date.UTC(INSTALL_YEAR + 2, 0, 2)))).toBe(2);
    process.env.SOLAR_INSTALLED_ON = `${INSTALL_YEAR}-01-01`;
    expect(systemYear(new Date(Date.UTC(INSTALL_YEAR + 1, 11, 30)))).toBe(2);
    expect(yearsSinceInstall(new Date(Date.UTC(INSTALL_YEAR + 1, 0, 1)))).toBe(1);
  });
  it('QI-5 the guest /api/now view has no installer, installedOn or site.installed', () => {
    process.env.SOLAR_INSTALLER = 'Example Solar Co'; process.env.SOLAR_INSTALLED_ON = `${INSTALL_YEAR}-06-01`;
    const owner = { reading: { ts: 't', solarKw: 1 }, site: { name: 'Owner Family Home', installed: `${INSTALL_YEAR}-06-01T10:00:00-05:00`, batteryCount: 2,
      solar: { ...SOLAR, year: 6, warrantedDcPct: 96.75 } } };
    const g = GUEST_GET.get('/api/now')!(owner) as any;
    expect(g.site).not.toHaveProperty('installed');
    expect(g.site.solar).not.toHaveProperty('installer');
    expect(g.site.solar).not.toHaveProperty('installedOn');
    expect(g.site.solar).toMatchObject({ year: 6, panels: 30, module: SOLAR.module });
    expect(JSON.stringify(g)).not.toMatch(/Example Solar|-06-01/);
  });
});
