// One-time Tesla Fleet API partner registration.
// Reads .env, gets a partner token (client_credentials), registers the domain whose
// public key is hosted at /.well-known/appspecific/com.tesla.3p.public-key.pem,
// then reads the registration back. Never prints the secret.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

const { TESLA_CLIENT_ID: id, TESLA_CLIENT_SECRET: secret, TESLA_PARTNER_DOMAIN: domain, TESLA_AUDIENCE: aud } = env;
if (!secret) { console.error('TESLA_CLIENT_SECRET is empty in .env'); process.exit(1); }

const tok = await fetch('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret,
    scope: 'openid energy_device_data', audience: aud }),
}).then(r => r.json());
if (!tok.access_token) { console.error('Partner token failed:', tok.error, tok.error_description ?? ''); process.exit(1); }
console.log('✓ partner token issued');

const auth = { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' };
const reg = await fetch(`${aud}/api/1/partner_accounts`, { method: 'POST', headers: auth, body: JSON.stringify({ domain }) });
console.log(`register ${domain}: HTTP ${reg.status}`, JSON.stringify(await reg.json()).slice(0, 300));

const check = await fetch(`${aud}/api/1/partner_accounts/public_key?domain=${domain}`, { headers: auth });
console.log(`public_key lookup: HTTP ${check.status}`, JSON.stringify(await check.json()).slice(0, 300));
