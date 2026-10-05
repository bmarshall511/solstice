// How long the tables that grow forever are kept (October audit, Low). Each window outlasts its longest reader:
//   nest_readings, pool_readings  400 days: the AC draw reads 14 days, the breakdown and overnight split 60, the pump's clean-filter
//                                 baseline the first 60 days of readings when no cleaning is logged
//   powerwall_log                 400 days: the rules card shows the last 30 entries, the digest one week
//   alerts                        365 days: dedupe looks back 45 days at most, the app shows the last week
//   owner_sessions                400 days unseen: requireOwner already refuses a device not seen for 400 days
// Runs nightly after the sync; a failure is logged, never thrown.
import { q } from './db.js';
import { localDay, addDays } from './tesla/client.js';

export const KEEP_DAYS = { readings: 400, powerwallLog: 400, alerts: 365, ownerSessions: 400 } as const;
export async function pruneOld(now = Date.now()) {
  const today = localDay(new Date(now)), out: Record<string, number> = {};
  out.nest = (await q(`DELETE FROM nest_readings WHERE day < $1 RETURNING 1`, [addDays(today, -KEEP_DAYS.readings)])).length;
  out.pool = (await q(`DELETE FROM pool_readings WHERE day < $1 RETURNING 1`, [addDays(today, -KEEP_DAYS.readings)])).length;
  out.powerwallLog = (await q(`DELETE FROM powerwall_log WHERE at < $1 RETURNING 1`, [now - KEEP_DAYS.powerwallLog * 864e5])).length;
  out.alerts = (await q(`DELETE FROM alerts WHERE created_at < $1 RETURNING 1`, [new Date(now - KEEP_DAYS.alerts * 864e5).toISOString()])).length;
  out.ownerSessions = (await q(`DELETE FROM owner_sessions WHERE last_seen < $1 RETURNING 1`, [new Date(now - KEEP_DAYS.ownerSessions * 864e5).toISOString()])).length;
  return out;
}
