// Synthetic Tesla Fleet API responses, shaped like calendar_history / live_status / site_info. Hand-written: six
// 5-minute buckets (not 288), a made-up site name, round nameplate numbers, no ids, serials or tokens.
import type { EnergyBucket, LiveStatus } from '../../server/src/tesla/client.js';

const EMPTY = {
  solar_energy_exported: 0, consumer_energy_imported_from_solar: 0, consumer_energy_imported_from_battery: 0, consumer_energy_imported_from_grid: 0,
  consumer_energy_imported_from_generator: 0, battery_energy_imported_from_solar: 0, battery_energy_imported_from_grid: 0,
  battery_energy_imported_from_generator: 0, grid_energy_exported_from_solar: 0, grid_energy_exported_from_battery: 0,
  grid_energy_exported_from_generator: 0, battery_energy_exported: 0,
};
const FROM_BATTERY = [100, 95, 110, 105, 90, 100];

/** Six overnight buckets for `day` (00:00–00:25 local, `offset` = the day's UTC offset): the house runs on the Powerwalls. */
export const energyBuckets = (day = '2026-09-25', offset = '-05:00'): EnergyBucket[] => FROM_BATTERY.map((wh, i) => ({
  ...EMPTY, timestamp: `${day}T00:${String(i * 5).padStart(2, '0')}:00${offset}`,
  consumer_energy_imported_from_battery: wh, battery_energy_exported: wh, consumer_energy_imported_from_grid: i === 3 ? 5 : 0,
}));

export const soePoints = (day = '2026-09-25', offset = '-05:00') => [0, 15].map((m, i) => ({ timestamp: `${day}T00:${String(m).padStart(2, '0')}:00${offset}`, soe: 64 - i }));

export const liveStatus = (timestamp: string): LiveStatus => ({
  solar_power: 0, battery_power: 1200, grid_power: 0, load_power: 1200, percentage_charged: 64,
  grid_status: 'Active', island_status: 'on_grid', storm_mode_active: false, timestamp,
});

export const siteInfo = (installationDate: string) => ({
  site_name: 'Test Site', installation_date: `${installationDate}T00:00:00-05:00`, battery_count: 2, nameplate_energy: 27000, nameplate_power: 10000,
  backup_reserve_percent: 20, default_real_mode: 'self_consumption', user_settings: { storm_mode_enabled: true }, version: '26.0.0',
  components: { batteries: [{ part_name: 'Powerwall 2', nameplate_energy: 13500, nameplate_max_discharge_power: 5000 }] },
});
