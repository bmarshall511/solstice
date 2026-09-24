// Big loads get the same treatment: what it's doing now, what its schedule costs, a smarter schedule for the season.
// Each appliance is a small plugin; the pool pump is first, AC (Nest) is next.
import { poolAppliance } from './pool.js';

export type ApplianceSummary = { id: string; name: string; status: 'linked' | 'estimated' | 'coming'; watts: number | null; kwhPerDay: number | null; savesPerMonth: number | null; source?: string };
export type Appliance = {
  id: string; name: string; source: string;
  available: () => boolean;
  summary: (siteId: string, settings: Record<string, any>, rate: number) => Promise<ApplianceSummary>;
};

export const appliances: Appliance[] = [poolAppliance];
export const comingSoon: ApplianceSummary[] = [{ id: 'ac', name: 'AC', status: 'coming', watts: null, kwhPerDay: null, savesPerMonth: null, source: 'Nest' }];
