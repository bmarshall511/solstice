/**
 * As-built solar specs, from the installer contract and the SunPower datasheet (docs/system-specs.md).
 * Nothing personal lives here: price, incentives and loan terms are stored in the owner's settings in the database.
 */
export const SOLAR = {
  installer: 'Freedom Solar',
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
  installedOn: '2020-12-15',
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
export const systemYear = (on = new Date()) => Math.floor((on.getTime() - Date.parse(SOLAR.installedOn)) / (365.25 * 864e5)) + 1;
