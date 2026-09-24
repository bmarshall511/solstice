const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};

export const config = {
  get clientId() { return required('TESLA_CLIENT_ID'); },
  get clientSecret() { return required('TESLA_CLIENT_SECRET'); },
  get redirectUri() { return required('TESLA_REDIRECT_URI'); },
  audience: process.env.TESLA_AUDIENCE ?? 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  authorizeUrl: 'https://auth.tesla.com/oauth2/v3/authorize',
  tokenUrl: 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
  scopes: 'openid offline_access energy_device_data',
  timeZone: 'America/Chicago',
  liveMaxAgeMs: 25_000,        // serve cached live_status younger than this
  historyEveryMs: 4 * 60_000,  // re-pull today's 5-minute history at most this often
  backfillDays: 400,           // how far back a new site is backfilled
};
