// Web push on this device (approved mockup mockups/t-enhancements.html, frames 1–3). The server side is server/src/notify.ts and
// push.ts: GET /api/push/key (VAPID public key), POST/DELETE /api/push/subscribe. The service worker (web/public/sw.js) shows each
// push and remembers when the last one arrived.
import { api } from './api.js';

/** The four states the "Push to this device" line shows (plus 'unsupported' for a browser without the Push API at all). */
export function pushState({ permission, standalone, supported, subscribed, ios = false }) {
  if (permission === 'denied') return 'denied';
  // iOS only offers push to a Home-Screen web app; Safari in a tab has no PushManager
  if (!standalone && (ios || !supported)) return 'nohome';
  if (!supported) return 'unsupported';
  return subscribed && permission === 'granted' ? 'on' : 'off';
}

/** "this iPhone", "this iPad", "this Mac"… from the user agent. */
export function deviceName(ua = '') {
  if (/iPhone/.test(ua)) return 'this iPhone';
  if (/iPad/.test(ua)) return 'this iPad';
  if (/Android/.test(ua)) return 'this phone';
  if (/Macintosh/.test(ua)) return 'this Mac';
  return 'this device';
}

/** "Mon 7:02 AM" in the site's time zone. */
export const pushTime = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit' }).replace(',', '');

/** [line text, line class, switch on, switch disabled] for a state (mockup frame 3). */
export function pushLine(state, { device = 'this device', lastPush = null } = {}) {
  switch (state) {
    case 'on': return [`On · ${device}${lastPush ? ` · last push ${pushTime(lastPush)}` : ''}`, 'st-on', true, false];
    case 'denied': return ['Blocked in iOS Settings › Notifications › Solstice', 'st-warn', false, true];
    case 'nohome': return ['Add Solstice to your Home Screen first (Share › Add to Home Screen)', 'st-warn', false, true];
    case 'unsupported': return ['This browser can’t receive push', 'st-warn', false, true];
    default: return ['Off · alerts stay in the app', 'st-off', false, false];
  }
}

/** A base64url VAPID key as the Uint8Array pushManager.subscribe wants. */
export function keyBytes(b64u) {
  const s = (b64u + '='.repeat((4 - b64u.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

/* ---------- browser side ---------- */
const hasSw = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
const supported = () => hasSw() && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPhone|iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
/** The service worker registration, or null when none is active within a moment (dev builds register none). */
async function registration() {
  if (!hasSw()) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 3000))]);
}
async function currentSub() { const reg = await registration(); return reg ? reg.pushManager.getSubscription() : null; }

/** When the last push reached this device (the service worker writes it), or null. */
export async function lastPushAt() {
  try { const r = await caches.match('/__solstice/last-push'); return r ? (await r.json()).at ?? null : null; } catch { return null; }
}

/** This device's push state and the line to show for it. */
export async function detectPush() {
  const ok = supported();
  const sub = ok ? await currentSub().catch(() => null) : null;
  const state = pushState({ permission: 'Notification' in window ? Notification.permission : 'default', standalone: standalone(), supported: ok, subscribed: !!sub, ios: isIos() });
  return { state, line: pushLine(state, { device: deviceName(navigator.userAgent), lastPush: state === 'on' ? await lastPushAt() : null }) };
}

/** Ask for permission, subscribe with the server's VAPID key and store the subscription. Throws with a readable message. */
export async function subscribePush() {
  if (!supported()) throw new Error('Push isn’t available here. Add Solstice to your Home Screen first.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked in Settings › Notifications › Solstice.' : 'Notifications were not allowed.');
  const { key } = await api.pushKey();
  if (!key) throw new Error('Push isn’t configured on the server yet (VAPID keys).');
  const reg = await registration(); if (!reg) throw new Error('The offline worker isn’t running yet. Reopen Solstice and try again.');
  const sub = await reg.pushManager.getSubscription() ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await api.pushSubscribe(sub.toJSON());
  return sub;
}

/** Forget this device's subscription on the server and in the browser. */
export async function unsubscribePush() {
  const sub = await currentSub(); if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/**
 * On an owner device that already has push on, post its existing subscription again (no prompt, no new subscription), so the server
 * ties it to this device's owner session and signing the device out stops its pushes (audit 10b, S-04). Subscriptions stored before
 * that link existed have none until this runs. Quiet: any failure is ignored. Returns whether it posted.
 */
export async function rebindPush() {
  try {
    if (!supported() || Notification.permission !== 'granted') return false;
    const sub = await currentSub(); if (!sub) return false;
    await api.pushSubscribe(sub.toJSON()); return true;
  } catch { return false; }
}
