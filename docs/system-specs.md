# As-built system specs

From the installer contract (Freedom Solar, October 2020), the SunPower E-Series AC module datasheet (531948 RevA) and the SunPower AC module warranty (526082 RevD). The code copy lives in `server/src/system.ts` and reaches the web app as `site.solar` on `/api/now`. Price, incentives and loan terms are **not** here: they sit in the owner's settings row in the database (`system` key), so nothing personal is in the repo.

## Solar array

| Item | Value |
|---|---|
| Modules | 30 × SunPower SPR-E19-320-AC (E-Series AC module, 96 Maxeon Gen III cells, 19.9% efficient) |
| DC rating | 320 W per module (+5/−0%) → **9.6 kW DC** (up to 10.08 kW at the top of tolerance) |
| Microinverters | Enphase IQ 7XS, factory-integrated, one per module. Module-level MPPT: **there are no strings.** |
| AC rating | 315 VA continuous per module, 320 VA peak → **9.45 kW AC continuous, 9.6 kVA peak**. The array cannot deliver more than this. |
| Temperature coefficient | −0.35 %/°C (power) |
| Module size | 1558 × 1046 × 46 mm, 19.5 kg, recommended spacing 33 mm |
| Racking / monitoring | SunPower InvisiMount; SunPower monitoring system (PVS). Per-module data would come from the PVS, not from Tesla. |
| Installed | Tesla reports 2020-12-15. Contract signed 2020-10-01. Permission-to-operate date unknown. |
| Orientation | Still a satellite estimate: tilt 27°, azimuth 244°, all 30 modules on one roof face in 3 rows × 10. No permit drawing yet. |

## Storage

2 × Tesla Powerwall 2 with a Backup Gateway (from the contract: "Tesla Powerwall & Gateway" plus "Additional Tesla Powerwall"), matching what the Fleet API reports (27 kWh, 10 kW).

## Warranties

- **SunPower 25-year limited product and power warranty** (AC modules, starts at interconnection): DC power ≥ 98% of minimum peak power in year 1, then declining no more than 0.25%/yr, so ≥ 92% at year 25. AC system power ≥ 90% of peak system power (sum of the module AC ratings) for all 25 years.
- **Freedom Solar**: 25-year labour warranty; equipment carries the manufacturers' warranties.

The Panels tab compares the learned full-sun output (kWh per kWh/m² of plane-of-array sunlight, roughly kW at 1000 W/m²) with these floors. The measured figure is a system-level AC number that also includes soiling, temperature and shading, so it is context for the warranty, not a formal test.

## What this corrected in the app (2026-09-24)

- Panel wattage was assumed to be 400 W; it is 320 W. The planner's baseline is now the 9.6 kW DC nameplate instead of an estimate from the largest 5-minute Tesla bucket (which read ~10.6 kW, above what 30 IQ7XS microinverters can output, so at least one bucket is inflated).
- The learned yield of ~9.5 kW matches the 9.45 kW AC rating, which confirms the array is healthy.
- Live peak output shown in the app is capped at the AC rating.
- Degradation tracking uses SunPower's 0.25%/yr warranted curve, not the generic 0.5%/yr.
- Added panels in the planner still assume a modern module wattage (400 W by default), because E19-320s are discontinued.
