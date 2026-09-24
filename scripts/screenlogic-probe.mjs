// Read-only probe of the ScreenLogic system: version, state, circuits, pump status, schedules. Nothing is changed.
import { RemoteLogin, UnitConnection } from 'node-screenlogic';
const name = process.env.SCREENLOGIC_SYSTEM, pass = process.env.SCREENLOGIC_PASSWORD;
const gw = new RemoteLogin(name);
const g = await gw.connectAsync();
await gw.closeAsync();
if (!g?.gatewayFound || !g.ipAddr) { console.error('unit not found', g); process.exit(1); }
console.log('gateway', { ip: g.ipAddr, port: g.port });
const c = new UnitConnection(); c.init(name, g.ipAddr, g.port, pass);
await c.connectAsync();
console.log('version', (await c.getVersionAsync()).version);
const st = await c.equipment.getEquipmentStateAsync();
console.log('state', JSON.stringify(st, null, 1));
console.log('controller', JSON.stringify(await c.equipment.getControllerConfigAsync(), null, 1));
console.log('config', JSON.stringify(await c.equipment.getEquipmentConfigurationAsync(), null, 1).slice(0, 3000));
for (const p of [0, 1]) { try { console.log('pump', p, JSON.stringify(await c.pump.getPumpStatusAsync(p), null, 1)); } catch (e) { console.log('pump', p, 'err', e.message); } }
console.log('schedules', JSON.stringify(await c.schedule.getScheduleDataAsync(0), null, 1));
await c.closeAsync();
process.exit(0);
