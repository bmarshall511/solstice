// Sharing (share view, mockups/q-share.html frames 5–7; docs/audit-designs/share-view.md §2.7, §4.4, §4.5):
//  - the owner's Settings › Sharing group and its sheets: Share (create a link, copy / share / QR it, revoke), Name shown on
//    invites, Owner devices;
//  - the guest role on the page (html[data-role=guest], or html[data-as=guest] while the owner previews), which hides every
//    owner-only control through CSS, so the owner's own view comes back untouched when the preview ends;
//  - the three cards on the .auth overlay when a link is opened: Welcome, Solstice is private, Turned off / expired;
//  - the Frost wipe that carries the owner into and out of "Preview as a guest".
import { $, niceDate, localDate, toast } from '../lib/util.js';
import { api } from '../lib/api.js';
import { esc, nameStart, nameMid, nameMidText, holdVeils, unlockCards } from '../lib/frost.js';
import { qrSvg } from '../lib/qr.js';

const day = iso => niceDate(localDate(new Date(iso)));
const wait = ms => new Promise(r => setTimeout(r, ms));
const store = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage off: fine */ } };
const stored = k => { try { return localStorage.getItem(k); } catch { return null; } };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
let S, hooks;

/** hooks.reload(): every view's data again (as the role now stands), resolved when the main reads are in. */
export function initShare(state, h) {
  S = state; hooks = h;
  $('shareRow').onclick = () => openShareSheet();
  $('nameRow').onclick = openNameSheet;
  $('devRow').onclick = openDevicesSheet;
  $('leaveRow').onclick = leave;
  const sw = $('guestSw');
  sw.onclick = () => (S.asGuest ? exitPreview() : enterPreview());
  [sw, $('shareRow'), $('nameRow'), $('devRow'), $('leaveRow')].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } }));
}

/* ======================= the role on the page ======================= */
/** Guest (a share link), the owner previewing as one, or the owner. Owner-only UI hides through CSS on the root attributes. */
export function applyRole({ guest, preview = false, ownerName, expiresAt = null }) {
  const root = document.documentElement;
  S.guest = !!guest; S.asGuest = !!(guest && preview); S.shareExpiresAt = expiresAt;
  if (ownerName !== undefined) S.ownerName = ownerName || 'The owner';
  if (S.guest && !S.asGuest) { root.dataset.role = 'guest'; store('solstice:ownerName', S.ownerName); } else delete root.dataset.role;
  if (S.asGuest) root.dataset.as = 'guest'; else delete root.dataset.as;
  if (!S.guest) unlockCards();
  $('guestSw').classList.toggle('on', S.asGuest); $('guestSw').setAttribute('aria-checked', String(S.asGuest));
  const by = `Shared by ${nameMidText(S.ownerName)}`, exp = expiresAt ? `link expires ${day(expiresAt)}` : 'link never expires';
  $('chipGuest').innerHTML = `<i></i>${esc(by)} · live`;   // no span: .chips span is the Autopilot chip style
  $('setGuestSub').textContent = `${by} · ${S.asGuest ? 'preview' : exp}`;
  $('sharedBy').textContent = by;
  $('sharedExp').textContent = S.asGuest ? 'guests see their link’s expiry here' : exp;
  pill()?.classList.toggle('show', S.asGuest && !busy);
}

/* ======================= Settings › Sharing (owner) ======================= */
/** The counts on the Sharing rows: active links, owner devices, the name shown on invites. */
export async function refreshSharing() {
  if (!S || S.guest) return;
  $('nameVal').textContent = S.ownerName;
  const [links, devices] = await Promise.all([api.shares().catch(() => null), api.devices().catch(() => null)]);
  if (links) { const n = links.filter(l => l.state === 'active').length; $('shareCount').textContent = n ? `${plural(n, 'active link')}` : 'No active links'; }
  if (devices) $('devN').textContent = `Owner on ${plural(devices.length, 'device')}`;
}

const sheet = html => { $('sheetBody').innerHTML = html; $('phone').classList.add('open'); $('sheetX').onclick = () => $('phone').classList.remove('open'); };
const head = title => `<div class="shead"><h4>${title}</h4><button class="x" id="sheetX" aria-label="Close">×</button></div>`;

/* ---------- Share sheet ---------- */
const EXPIRY = [['24h', '24h'], ['7d', '7d'], ['30d', '30d'], ['1yr', '1 yr'], ['never', 'Never']];
let expiresIn = '30d';
const shortUrl = url => { try { const u = new URL(url), t = u.hash.replace(/^#s=/, ''); return `${u.host}/#s=${t.slice(0, 3)}…${t.slice(-2)}`; } catch { return url; } };
const opened = l => (l.openedCount ? `opened ${l.openedCount}× · last ${day(l.lastOpenedAt)}${l.lastUa ? ` · ${esc(l.lastUa)}` : ''}` : 'never opened');
function linkRow(l) {
  const live = l.state === 'active';
  const when = live ? (l.expiresAt ? `expires ${day(l.expiresAt)}` : 'never expires') : l.state === 'revoked' ? `revoked ${day(l.revokedAt)}` : `expired ${day(l.expiresAt)}`;
  return `<div class="lrow${live ? '' : ' off'}"><div class="lm"><b>${esc(l.label)}</b>created ${day(l.createdAt)} · ${when} · ${opened(l)}</div>${live ? `<button class="link rvk" data-rvk="${esc(l.id)}">Revoke</button>` : ''}</div>`;
}

/** The Share sheet. `created` is the link just made: its URL is shown this once and never stored. */
export async function openShareSheet(created = null) {
  const links = await api.shares().catch(() => []), active = links.filter(l => l.state === 'active'), old = links.filter(l => l.state !== 'active');
  const top = created
    ? `<p class="sub">Link for <b style="color:var(--text)">${esc(created.label)}</b> · ${created.expiresAt ? `expires ${day(created.expiresAt)}` : 'never expires'}.</p>
      <div class="lnk"><code>${esc(shortUrl(created.url))}</code>
        <div class="lb"><button class="link" id="lnkCopy">Copy</button><button class="link" id="lnkShare">Share…</button><button class="link" id="lnkQr" aria-expanded="false">QR</button></div>
        <div id="lnkQrBox" hidden>${qrSvg(created.url)}</div>
        <p class="fine" style="margin-top:10px">Shown once. Solstice keeps only a fingerprint.</p></div>`
    : `<p class="sub">Anyone with a link sees live energy. Never dollars, never controls.</p>
      <div class="fields" style="grid-template-columns:1fr"><label>Label · private, the guest never sees it<input id="shareLabel" maxlength="40" autocomplete="off" placeholder="e.g. Dad"></label></div>
      <span class="lbl">Expires</span>
      <div class="seg2 exp" id="expSeg">${EXPIRY.map(([v, l]) => `<button data-e="${v}" class="${v === expiresIn ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="primary" id="shareCreate">Create link</button><p class="err" id="shareErr" hidden></p>
      <p class="fine" style="margin-top:10px;line-height:1.5">Links can be opened again until they expire or you revoke them. Each one opens the guest view: live kWh, no dollars, no controls.</p>`;
  sheet(`${head('Share Solstice')}${top}
    ${active.length ? `<div class="sect" style="margin-top:20px">Active links</div><div>${active.map(linkRow).join('')}</div>` : ''}
    ${old.length ? `<div class="sect">Revoked · 30 days</div><div>${old.map(linkRow).join('')}</div>` : ''}
    ${active.length ? '<button class="danger" id="revokeAll">Revoke all links</button>' : ''}`);
  if (created) {
    $('lnkCopy').onclick = () => copy(created.url, created.label);
    $('lnkShare').onclick = () => (navigator.share ? navigator.share({ title: 'Solstice', url: created.url }).catch(() => {}) : copy(created.url, created.label));
    $('lnkQr').onclick = () => { const box = $('lnkQrBox'); box.hidden = !box.hidden; $('lnkQr').setAttribute('aria-expanded', String(!box.hidden)); };
  } else {
    $('expSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; expiresIn = b.dataset.e; $('expSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
    const say = t => { $('shareErr').textContent = t; $('shareErr').hidden = !t; };
    $('shareCreate').onclick = async () => {
      const label = $('shareLabel').value.trim();
      if (!label) { say('Give the link a label, so you know whose it is.'); $('shareLabel').focus(); return; }
      $('shareCreate').textContent = 'Creating…';
      const c = await api.createShare(label, expiresIn).catch(e => { say(e.message); $('shareCreate').textContent = 'Create link'; return null; });
      if (c) { openShareSheet(c); refreshSharing(); }
    };
  }
  document.querySelectorAll('#sheetBody [data-rvk]').forEach(b => b.onclick = async () => {
    const l = links.find(x => x.id === b.dataset.rvk);
    if (!l || !confirm(`Turn off the link for ${l.label}? Anyone using it loses access on their next refresh.`)) return;
    await api.revokeShare(l.id).then(() => toast('✓', 'rgba(255,255,255,.12)', 'Link turned off', l.label), e => toast('!', 'rgba(255,90,78,.25)', 'Couldn’t turn it off', e.message));
    openShareSheet(created); refreshSharing();
  });
  const all = $('revokeAll');
  if (all) all.onclick = async () => {
    if (!confirm(`Turn off all ${plural(active.length, 'link')}?`)) return;
    await api.revokeAllShares().then(r => toast('✓', 'rgba(255,255,255,.12)', 'All links turned off', plural(r.revoked, 'link')), e => toast('!', 'rgba(255,90,78,.25)', 'Couldn’t turn them off', e.message));
    openShareSheet(created); refreshSharing();
  };
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = Object.assign(document.createElement('textarea'), { value: text }); t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;opacity:0'; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
  toast('✓', 'rgba(255,255,255,.12)', 'Link copied', label);
}

/* ---------- Name shown on invites ---------- */
function openNameSheet() {
  sheet(`${head('Name shown on invites')}<p class="sub">Guests see it on the welcome card, the Now tab and in Settings: “Shared by ${nameMid(S.ownerName)}”.</p>
    <div class="fields" style="grid-template-columns:1fr"><label>Name<input id="nameIn" maxlength="40" autocomplete="off" value="${esc(S.ownerName)}"></label></div>
    <button class="primary" id="nameSave">Save</button>`);
  $('nameSave').onclick = async () => {
    const v = $('nameIn').value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'The owner';
    await api.saveSettings({ ownerName: v }).then(() => { S.ownerName = v; $('nameVal').textContent = v; $('phone').classList.remove('open'); toast('✓', 'rgba(255,255,255,.12)', 'Saved', `Guests see “${v}”`); },
      e => toast('!', 'rgba(255,90,78,.25)', 'Couldn’t save', e.message));
  };
}

/* ---------- Owner devices ---------- */
const since = iso => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : day(iso); };
async function openDevicesSheet() {
  const list = (await api.devices().catch(() => null)) ?? [], others = list.filter(d => !d.current);
  const parts = d => { const [dev, br] = String(d.label ?? 'Device').split(' · '); return [esc(dev), br ? esc(br) + ' · ' : '']; };
  const rows = [...list.filter(d => d.current), ...others].map(d => { const [dev, br] = parts(d);
    return d.current ? `<div class="lrow"><div class="lm"><b>This ${dev}</b>${br}now</div><span class="badge g" style="flex:none">this device</span></div>`
      : `<div class="lrow" data-d="${esc(d.id)}"><div class="lm"><b>${dev}</b>${br}${since(d.lastSeen)}</div><button class="link rvk" data-dev="${esc(d.id)}">Sign out</button></div>`; });
  sheet(`${head('Owner devices')}<p class="sub">Each device unlocked with the owner key stays signed in for 400 days after it was last used.</p>
    <div style="margin-top:10px">${rows.join('') || '<div class="empty">Couldn’t load the devices.</div>'}</div>
    ${others.length ? '<button class="danger" id="devOthers">Sign out other devices</button>' : ''}
    <p class="fine" style="margin-top:10px;line-height:1.5">The key lives in your password manager. Rotating it signs every device out; this list signs them out one at a time.</p>`);
  document.querySelectorAll('#sheetBody [data-dev]').forEach(b => b.onclick = async () => {
    const r = b.closest('.lrow'), name = r.querySelector('b').textContent;
    await api.signOutDevice(b.dataset.dev).then(() => { r.classList.add('off'); toast('✓', 'rgba(255,255,255,.12)', 'Signed out', name); refreshSharing(); },
      e => toast('!', 'rgba(255,90,78,.25)', 'Couldn’t sign it out', e.message));
  });
  const all = $('devOthers');
  if (all) all.onclick = async () => {
    if (!confirm(`Sign out ${plural(others.length, 'other device')}? ${others.length === 1 ? 'It needs' : 'They need'} the owner key to get back in.`)) return;
    await api.signOutOthers().then(r => { toast('✓', 'rgba(255,255,255,.12)', 'Signed out', plural(r.signedOut, 'other device')); openDevicesSheet(); refreshSharing(); },
      e => toast('!', 'rgba(255,90,78,.25)', 'Couldn’t sign them out', e.message));
  };
}

/* ======================= a guest leaving ======================= */
async function leave() {
  if (S.asGuest) return exitPreview();
  if (!confirm('Forget this link on this device? You can open it again later.')) return;
  await api.leave().catch(() => {});
  location.reload();
}

/* ======================= the link-open cards (.auth overlay) ======================= */
/** A pasted share link, a bare token, or the owner link: { token } | { owner } | null. */
export function parseLink(text) {
  const t = String(text ?? '').trim(); if (!t) return null;
  const owner = /#owner=([^&\s]+)/.exec(t); if (owner) { try { return { owner: decodeURIComponent(owner[1]) }; } catch { return { owner: owner[1] }; } }
  const s = /[#&?]s=([\w-]+)/.exec(t); if (s) return { token: s[1] };
  return /^[\w-]{16,}$/.test(t) ? { token: t } : null;
}
/** The welcome card shows once per device per link: the key is a fingerprint of the token, never the token. */
async function linkKey(token) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(d)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}
/** After a link opens on this device (and before the reload), ask for the welcome card unless this device has seen it. */
export async function markWelcome(token) {
  try { const k = await linkKey(token); if (!stored(`solstice:welcomed:${k}`)) sessionStorage.setItem('solstice:welcome', k); } catch { /* no crypto or storage: no welcome */ }
}
/** The welcome card's key if one was asked for on this load (it is asked once). */
export function pendingWelcome() { try { const k = sessionStorage.getItem('solstice:welcome'); sessionStorage.removeItem('solstice:welcome'); return k; } catch { return null; } }

/** kind: 'welcome' (the Now view already behind it), 'private' (no link) or 'off' (reason 'revoked' | 'expired'). */
export function showGate(kind, { reason = 'revoked', error = '', welcomeKey = null } = {}) {
  const g = $('gate'), c = $('gateCard'), root = document.documentElement;
  root.dataset.gate = kind; g.hidden = false; g.classList.remove('gone');
  if (kind === 'welcome') {
    c.innerHTML = `<div class="authlogo"></div><h2>${nameStart(S.ownerName)} shared their home’s energy with you</h2>
      <p>Live solar, Powerwalls, pool and AC, as it happens. Dollar amounts, bills and controls stay private.</p>
      <div class="ln">${S.shareExpiresAt ? `This link works until ${day(S.shareExpiresAt)}` : 'This link has no expiry'}</div>
      <button class="primary" id="haveLook" style="width:100%;box-sizing:border-box;margin-top:16px">Have a look</button>
      <p class="fine">Add to Home Screen after opening, then paste the link once more if asked.</p>`;
    $('haveLook').onclick = () => {
      if (welcomeKey) store(`solstice:welcomed:${welcomeKey}`, '1');
      g.classList.add('gone'); delete root.dataset.gate; setTimeout(() => { if (g.classList.contains('gone')) g.hidden = true; }, 420);
    };
    $('haveLook').focus();
    return;
  }
  if (kind === 'off') {
    c.innerHTML = `<div class="authlogo off"></div><h2>${reason === 'expired' ? 'This link has expired' : 'This link was turned off'}</h2><p>Ask ${nameMid(stored('solstice:ownerName'))} for a new one.</p>`;
    api.leave().catch(() => {});   // drop the dead link's cookie, so the next open offers the paste field and "I'm the owner"
    return;
  }
  c.innerHTML = `<div class="authlogo"></div><h2>Solstice is private</h2>
    <p>This is one home’s energy monitor. If someone sent you a link, open it, or paste it here.</p>
    <form id="gateLink"><label>Share link<input id="gateLinkIn" placeholder="Paste the link" autocomplete="off" autocapitalize="off" spellcheck="false"></label><button class="primary" type="submit">Open</button></form>
    <button class="olink" id="gateOwnerT" type="button" aria-expanded="false">I’m the owner</button>
    <form id="gateOwner" hidden><label>Owner key<input id="gateKey" type="password" placeholder="From your password manager" autocomplete="current-password"></label><button class="primary" type="submit">Unlock</button></form>
    <p class="err" id="gateErr">${esc(error)}</p>`;
  const say = t => { $('gateErr').textContent = t; };
  const busyBtn = (f, on) => { const b = f.querySelector('button'); b.disabled = on; b.style.opacity = on ? '.6' : ''; };
  $('gateOwnerT').onclick = () => { const f = $('gateOwner'); f.hidden = !f.hidden; $('gateOwnerT').setAttribute('aria-expanded', String(!f.hidden)); if (!f.hidden) $('gateKey').focus(); };
  const unlock = async (key, form) => {
    busyBtn(form, true);
    try { await api.owner(key); location.reload(); }
    catch (e) { busyBtn(form, false); say(e.status === 429 ? 'Too many tries. Wait a minute and try again.' : e.status === 503 ? 'The owner key isn’t set up on the server yet.' : 'That key didn’t work.'); }
  };
  $('gateOwner').onsubmit = e => { e.preventDefault(); say(''); unlock($('gateKey').value.trim(), e.target); };
  $('gateLink').onsubmit = async e => {
    e.preventDefault(); say('');
    const p = parseLink($('gateLinkIn').value);
    if (!p) return say('That doesn’t look like a Solstice link. Paste the whole link.');
    if (p.owner) return unlock(p.owner, e.target);
    busyBtn(e.target, true);
    try { await api.guest(p.token); await markWelcome(p.token); location.reload(); }
    catch (err) {
      busyBtn(e.target, false);
      if (err.reason === 'revoked' || err.reason === 'expired') return showGate('off', { reason: err.reason });
      say(err.status === 429 ? 'Too many tries. Wait a minute and try again.' : 'That link didn’t work. Check it and try again.');
    }
  };
}

/* ======================= Preview as a guest: the Frost wipe ======================= */
let busy = false, layer = null, pillEl = null;
const pill = () => pillEl;
/** The frost layer and the "Previewing as a guest · Exit" pill live inside the phone, above everything but the sheets' toasts. */
export function ensurePreviewChrome() {
  if (layer) return;
  layer = Object.assign(document.createElement('div'), { className: 'frostwipe' }); layer.setAttribute('aria-hidden', 'true');
  pillEl = Object.assign(document.createElement('div'), { className: 'gpill', id: 'gpill', innerHTML: '<i></i>Previewing as a guest<button class="link" id="gpillExit">Exit</button>' });
  pillEl.setAttribute('role', 'status');
  $('phone').append(layer, pillEl);
  $('gpillExit').onclick = exitPreview;
}
const calm = () => S.calm || matchMedia('(prefers-reduced-motion: reduce)').matches;
const blur = px => { layer.style.backdropFilter = layer.style.webkitBackdropFilter = `blur(${px}px)`; };
const snap = props => { layer.style.transition = 'none'; Object.assign(layer.style, props); void layer.offsetWidth; };
const settle = (p, ms) => Promise.race([p, wait(ms)]);
/** Each veil plays its fade-in as the top-down clear passes it. */
function reveal(dur) {
  const p = $('phone').getBoundingClientRect();
  document.querySelectorAll('.veil.wait').forEach(v => {
    const r = v.getBoundingClientRect(), f = r.height ? Math.min(1, Math.max(0, (r.top - p.top) / p.height)) : 0;
    setTimeout(() => v.classList.remove('wait'), f * dur);
  });
}
/** Flip the server's preview flag, then the page's role, then reload every view as that role. */
async function switchRole(toGuest) {
  await api.preview(toGuest);
  if (toGuest) { const me = await api.me(); applyRole({ guest: true, preview: true, ownerName: me.ownerName, expiresAt: null }); }
  else applyRole({ guest: false });
  await hooks.reload();
  if (!toGuest) refreshSharing();
}
async function crossfade(toGuest) {
  snap({ clipPath: 'none', opacity: '0' }); blur(24); layer.classList.add('run'); void layer.offsetWidth;
  layer.style.transition = 'opacity .15s linear'; layer.style.opacity = '1'; await wait(150);
  await settle(switchRole(toGuest), 5000);
  layer.style.opacity = '0'; await wait(150);
  layer.classList.remove('run'); layer.style.opacity = '';
}
const failed = e => { layer.classList.remove('run'); toast('!', 'rgba(255,90,78,.25)', 'Preview didn’t switch', e.message); };

/** Frost grows from the switch (0–450 ms); at 300 ms the role flips and guest data loads under it; from 750 ms (or once the
 *  data is in) it clears from the top down over 600 ms while each veil fades in. Calm mode or reduced motion: a 150 ms crossfade. */
export async function enterPreview() {
  if (busy || S.asGuest) return;
  busy = true; ensurePreviewChrome();
  try {
    if (calm()) await crossfade(true);
    else {
      const p = $('phone').getBoundingClientRect(), s = $('guestSw').getBoundingClientRect();
      layer.style.setProperty('--x', `${s.left + s.width / 2 - p.left}px`); layer.style.setProperty('--y', `${s.top + s.height / 2 - p.top}px`);
      snap({ clipPath: 'circle(0 at var(--x) var(--y))', opacity: '1' }); blur(0); layer.classList.add('run'); void layer.offsetWidth;
      layer.style.transition = 'clip-path .45s var(--ease), backdrop-filter .45s var(--ease), -webkit-backdrop-filter .45s var(--ease)';
      layer.style.clipPath = 'circle(150% at var(--x) var(--y))'; blur(24);
      await wait(300);
      holdVeils(true);
      await Promise.all([wait(450), settle(switchRole(true), 5000)]);
      holdVeils(false);
      snap({ clipPath: 'inset(0 0 0 0)' }); layer.style.transition = 'clip-path .6s var(--ease)'; layer.style.clipPath = 'inset(100% 0 0 0)';
      reveal(600);
      await wait(600); layer.classList.remove('run');
    }
  } catch (e) { failed(e); } finally { holdVeils(false); busy = false; pillEl.classList.toggle('show', S.asGuest); }
}
/** The same, backwards: frost rises from the bottom, the owner's data reloads under it, then it clears from the top. */
export async function exitPreview() {
  if (busy || !S.asGuest) return;
  busy = true; ensurePreviewChrome(); pillEl.classList.remove('show');
  try {
    if (calm()) await crossfade(false);
    else {
      snap({ clipPath: 'inset(100% 0 0 0)', opacity: '1' }); blur(24); layer.classList.add('run'); void layer.offsetWidth;
      layer.style.transition = 'clip-path .45s var(--ease)'; layer.style.clipPath = 'inset(0 0 0 0)';
      await wait(450);
      await Promise.all([wait(300), settle(switchRole(false), 5000)]);
      layer.style.transition = 'clip-path .6s var(--ease)'; layer.style.clipPath = 'inset(100% 0 0 0)';
      await wait(600); layer.classList.remove('run');
    }
  } catch (e) { failed(e); } finally { busy = false; pillEl.classList.toggle('show', S.asGuest); }
}
