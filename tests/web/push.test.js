// Web push state on this device (web/src/lib/push.js, approved mockup mockups/t-enhancements.html frame 3).
import { describe, it, expect } from 'vitest';
import { pushState, pushLine, deviceName, keyBytes, pushTime } from '../../web/src/lib/push.js';

const base = { permission: 'default', standalone: true, supported: true, subscribed: false, ios: true };

describe('push state detection', () => {
  it('is On only with a subscription and granted permission', () => {
    expect(pushState({ ...base, permission: 'granted', subscribed: true })).toBe('on');
    expect(pushState({ ...base, permission: 'granted', subscribed: false })).toBe('off');
    expect(pushState({ ...base, permission: 'default', subscribed: true })).toBe('off');
  });
  it('is Blocked when the permission was denied, wherever the app runs', () => {
    expect(pushState({ ...base, permission: 'denied' })).toBe('denied');
    expect(pushState({ ...base, permission: 'denied', standalone: false, supported: false })).toBe('denied');
  });
  it('is Not on Home Screen for iOS in a Safari tab (no PushManager, not standalone)', () => {
    expect(pushState({ ...base, standalone: false, supported: false })).toBe('nohome');
    expect(pushState({ ...base, standalone: false, supported: true, ios: true })).toBe('nohome');
  });
  it('lets a desktop browser tab subscribe without a Home-Screen install', () => {
    expect(pushState({ ...base, standalone: false, supported: true, ios: false })).toBe('off');
    expect(pushState({ ...base, standalone: false, supported: true, ios: false, permission: 'granted', subscribed: true })).toBe('on');
  });
  it('falls back to unsupported for an installed app without the Push API', () => {
    expect(pushState({ ...base, supported: false })).toBe('unsupported');
  });
});

describe('the switch line', () => {
  it('reads as the mockup for each state', () => {
    const at = Date.parse('2026-09-28T12:02:00Z');   // Mon 7:02 AM in Chicago
    expect(pushLine('on', { device: 'this iPhone', lastPush: at })).toEqual(['On · this iPhone · last push Mon 7:02 AM', 'st-on', true, false]);
    expect(pushLine('on', { device: 'this iPhone' })[0]).toBe('On · this iPhone');
    expect(pushLine('off')).toEqual(['Off · alerts stay in the app', 'st-off', false, false]);
    expect(pushLine('denied')).toEqual(['Blocked in iOS Settings › Notifications › Solstice', 'st-warn', false, true]);
    expect(pushLine('nohome')).toEqual(['Add Solstice to your Home Screen first (Share › Add to Home Screen)', 'st-warn', false, true]);
    expect(pushLine('unsupported')[3]).toBe(true);
    expect(pushTime(at)).toBe('Mon 7:02 AM');
  });
  it('names the device from the user agent', () => {
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('this iPhone');
    expect(deviceName('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('this iPad');
    expect(deviceName('Mozilla/5.0 (Linux; Android 15)')).toBe('this phone');
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('this Mac');
    expect(deviceName('')).toBe('this device');
  });
});

describe('VAPID key', () => {
  it('decodes base64url without padding into the 65-byte P-256 point', () => {
    const raw = new Uint8Array(65).map((_, i) => (i * 37 + 4) & 255); raw[0] = 4;
    const b64u = Buffer.from(raw).toString('base64url');
    expect(b64u.includes('=')).toBe(false);
    expect([...keyBytes(b64u)]).toEqual([...raw]);
  });
});
