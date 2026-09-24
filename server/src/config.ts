const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key} in .env`);
  return value;
};

const dataDir = new URL('../../data/', import.meta.url).pathname;

export const config = {
  port: Number(process.env.PORT ?? 8787),
  clientId: required('TESLA_CLIENT_ID'),
  clientSecret: required('TESLA_CLIENT_SECRET'),
  redirectUri: required('TESLA_REDIRECT_URI'),
  audience: process.env.TESLA_AUDIENCE ?? 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  authorizeUrl: 'https://auth.tesla.com/oauth2/v3/authorize',
  tokenUrl: 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
  scopes: 'openid offline_access energy_device_data',
  timeZone: 'America/Chicago',
  lat: Number(process.env.SITE_LAT ?? LAT),
  lon: Number(process.env.SITE_LON ?? LON),
  dataDir,
  dbPath: `${dataDir}solstice.db`,
  billsDir: `${dataDir}bills/`,
  livePollMs: 30_000,
  historyPollMs: 5 * 60_000,
};
