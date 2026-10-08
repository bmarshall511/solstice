/**
 * As-built solar specs, from the installer contract and the SunPower datasheet (docs/system-specs.md).
 * Nothing personal lives here: price, incentives and loan terms are stored in the owner's settings in the database. The repo is
 * public, so the installer's name and the exact install date are not here either (audit 10b, S-09/M-6): only the install year.
 * The owner may set SOLAR_INSTALLER and SOLAR_INSTALLED_ON (YYYY-MM-DD) in the env; unset, `installer` is null and `installedOn`
 * is the year alone. Both are read at call time (getters), and neither reaches a guest (redact.ts SOLAR rule).
 */
export const INSTALL_YEAR = 2020;
const envInstalledOn = () => { const v = process.env.SOLAR_INSTALLED_ON?.trim() ?? ''; return /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null; };
export const SOLAR = {
  get installer(): string | null { return process.env.SOLAR_INSTALLER?.trim() || null; },
  module: 'SunPower SPR-E19-320-AC',
  panels: 30,
  panelWdc: 320,            // W DC nominal per module at STC, tolerance +5/−0%
  panelVaAc: 315,           // VA continuous per microinverter (320 VA peak) at 240 V
  microinverter: 'Enphase IQ 7XS (factory-integrated, one per module: module-level MPPT, no strings)',
  efficiencyPct: 19.9,
  tempCoefPctPerC: -0.35,
  moduleM: { w: 1.046, h: 1.558 }, // portrait: 1558 × 1046 mm
  dcKw: 9.6,                // 30 × 320 W
  acKw: 9.45,               // 30 × 315 VA continuous; AC output cannot exceed this
  /** The env's exact date, or the install year alone ("2020"; Date.parse reads it as 1 January). */
  get installedOn(): string { return envInstalledOn() ?? String(INSTALL_YEAR); },
  warranty: {               // SunPower Limited Product and Power Warranty for AC modules (25 years)
    years: 25,
    dcYear1Pct: 98,         // DC power ≥ 98% of minimum peak power in year 1 …
    dcDeclinePctPerYear: 0.25, // … then declining no more than 0.25%/yr → ≥ 92% at year 25
    acFloorPct: 90,         // AC system power ≥ 90% of peak system power for the full term
    labourYears: 25,        // installer's labour warranty
  },
};

/** Warranted minimum DC output (% of nameplate) for the system's Nth year of operation. */
export const warrantedDcPct = (year: number) => {
  const w = SOLAR.warranty;
  return w.dcYear1Pct - w.dcDeclinePctPerYear * (Math.min(w.years, Math.max(1, year)) - 1);
};
/** When the system went in (ms): SOLAR_INSTALLED_ON when set, else the last day of the install year, so the system's year is never
 *  counted ahead of the real one (the warranty floor never reads lower than it is). */
export const installedAtMs = () => { const d = envInstalledOn(); return d ? Date.parse(d) : Date.UTC(INSTALL_YEAR, 11, 31); };
/** Years since the install, to a tenth (for the owner's payback text). */
export const yearsSinceInstall = (on = new Date()) => Math.round((on.getTime() - installedAtMs()) / (365.25 * 864e5) * 10) / 10;
export const systemYear = (on = new Date()) => Math.floor((on.getTime() - installedAtMs()) / (365.25 * 864e5)) + 1;
