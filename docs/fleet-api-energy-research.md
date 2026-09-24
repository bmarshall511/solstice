# Tesla Fleet API: Energy (Powerwall + Solar) Research

Researched 2026-09-24. Primary source is https://developer.tesla.com/docs/fleet-api. I read the energy endpoint "Details / Response" panels in a live browser, because they are rendered client-side and WebFetch misses them.
Community sources: Home Assistant `tesla_fleet` (core, dev branch) and Teslemetry `python-tesla-fleet-api`. Some facts come only from community sources, and some I could not verify at all. Those are tagged **[community]** or **[unverified]**.

---

## 1. Registration flow

### 1.1 Prerequisites
- You need a Tesla account with a verified email and MFA enabled.
- The account that owns the Powerwall must have logged into the Tesla mobile app at least once. Otherwise requests return "unknown user" (FAQ).
- There is no staging environment or simulator. You test against real hardware (FAQ).

### 1.2 App creation form (developer.tesla.com → "Create Application")
Official docs say only this: "Provide legal business details, application name, description, and purpose of usage" and select scopes. The app name must be unique, or the request can be auto-rejected.

Fields as described by community guides (HA docs, TeslaSync) **[community]**:

| Field | Value for this app |
|---|---|
| Application name | Shown on the OAuth consent screen. Must be unique. |
| Description / Purpose of usage | Free text, e.g. "Personal Powerwall/solar efficiency monitoring". |
| OAuth grant type | "Authorization Code and Machine-to-Machine". You need both: auth code for user tokens, client_credentials for the partner token used by `register`. |
| Allowed Origin URL(s) | e.g. `https://yourdomain.com`. The **root domain here must match the domain you register** via `POST /api/1/partner_accounts`. Subdomains of the same root are OK. Official: "`123.abc.com` can be used for an allowed_origin of `www.abc.com`". |
| Allowed Redirect URI(s) | Exact match required (the `invalid_redirect_url` error means the authorize and token redirect_uri differ). |
| Scopes | Tick `Energy Product Information` (`energy_device_data`). Add `Energy Product Settings` (`energy_cmds`) only if you will send commands. `openid` and `offline_access` are requested at authorize time. |

**Is `http://localhost` allowed as a redirect URI?** Community sources say yes. TeslaSync documents `http://localhost:8080/...` and a production https URI coexisting on one app, and quotes the form hint "Only local hosts are supported for http:// protocol". **[community, not verified on the form itself]** Allowed *origin* must still be a real public HTTPS domain, because the public key is hosted there (see 1.4).

Scope changes: you can edit scopes later under "API & Scopes → Manage". Changes take up to 10 minutes to apply (announcement 2024-05-20).

### 1.3 Scopes (official table)
| Scope | Meaning |
|---|---|
| `openid` | Sign in with Tesla |
| `offline_access` | Returns a refresh token. **Required** if you want to refresh without re-login. |
| `user_data` | Profile, contact info, home address. Not needed for energy. Needed only if you want `/users/me`. |
| `energy_device_data` | live_status, site_info, backup history, energy history, charge history |
| `energy_cmds` | backup reserve, operation mode, storm mode, grid import/export, off-grid EV reserve, TOU tariff |

The docs say to request only scopes that are "immediately necessary". Minimal set for a monitoring app: `openid offline_access energy_device_data`.

### 1.4 Public key: required even for energy-only apps
- Official "What is Fleet API", Step 3: "A public key must be hosted on the application's domain **before making calls to Fleet API**."
- The `register` endpoint says: "A PEM-encoded EC public key using the secp256r1 curve (prime256v1) **must be and remain hosted** at `https://<app domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`."
- None of this is waived for energy-only apps, and HA's docs call the key "mandatory for all setups". Treat it as **required**. It is only *used* for vehicle virtual keys and telemetry. For energy it simply proves domain ownership. Keep it hosted permanently.

Generate the key pair:
```bash
openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
openssl ec -in private-key.pem -pubout -out public-key.pem
# host public-key.pem at https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem (no auth)
```
Cheap hosting options include GitHub Pages or Cloudflare Pages on a domain you own. The domain must match the Allowed Origin. **[unverified]** whether a `*.github.io` root is accepted. People do use it, but the "root domain" matching rule is ambiguous for shared hosts.

### 1.5 Partner token + register (once per region)
```bash
# 1) Partner token (client_credentials)
curl -X POST https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode client_id=$CLIENT_ID \
  --data-urlencode client_secret=$CLIENT_SECRET \
  --data-urlencode 'scope=openid energy_device_data energy_cmds' \
  --data-urlencode audience=https://fleet-api.prd.na.vn.cloud.tesla.com

# 2) Register the domain (partner token as Bearer)
curl -X POST https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts \
  -H "Authorization: Bearer $PARTNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"domain":"yourdomain.com"}'

# 3) Verify
curl "https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts/public_key?domain=yourdomain.com" \
  -H "Authorization: Bearer $PARTNER_TOKEN"
```
- Register **in every region** where you will have users. Calls fail with `412 Unregistered account` until you do.
- The `audience` must be that region's base URL.
- The body key `domain` is **[community]**. It matches every library, but the docs page only describes the requirement.

### 1.6 Regional base URLs (official)
| Region | Base URL |
|---|---|
| North America, Asia-Pacific (excl. China) | `https://fleet-api.prd.na.vn.cloud.tesla.com` |
| Europe, Middle East, Africa | `https://fleet-api.prd.eu.vn.cloud.tesla.com` |
| China | `https://fleet-api.prd.cn.vn.cloud.tesla.cn` (separate app on developer.tesla.cn, +86 phone required) |

- A `421 Incorrect region` response means the user lives in another region.
- `GET /api/1/users/region` returns the user's correct base URL. Its required scope is **[unverified]**, possibly `user_data`.
- Health check: `GET {base}/status` returns `ok` and needs no auth.

### 1.7 User OAuth (authorization code)
- Authorize URL: `https://auth.tesla.com/oauth2/v3/authorize?response_type=code&client_id=…&redirect_uri=…&scope=openid%20offline_access%20energy_device_data&state=…` (optional `nonce`, `prompt_missing_scopes`, `require_requested_scopes`, `locale`, `prompt=login`).
- Token exchange **must** go to `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token`, not `auth.tesla.com` (mandatory since Aug 2025).
  - Params: `grant_type=authorization_code`, `client_id`, `client_secret`, `code`, `audience` (region base URL), `redirect_uri`.
  - PKCE is not documented. **[unverified]**
- Refresh: `grant_type=refresh_token`, `client_id`, `refresh_token`, sent to the same fleet-auth host.

### 1.8 Token lifetimes and refresh
| Token | Lifetime |
|---|---|
| Access token (JWT) | Commonly `expires_in: 28800` = **8 h** **[community/unverified]**. Official guidance: renew when within 1 minute of expiry. Granted scopes are in the JWT `scp` claim. |
| Refresh token | **Single-use, expires after 3 months** (official). Each refresh returns a new refresh token; **persist it atomically**. The previously used one stays valid for 24 h as a grace period. |

- Getting a new refresh token invalidates older refresh tokens and their access tokens (announcement 2024-02-01).
- `401 login_required` means one of: the token expired or was cycled out, the password was reset, or the user revoked access. In every case the user must re-authorize.
- Auth request rate limit: ≤ 20 req/s. Auth endpoints are not billed.
- Users can revoke consent at `https://auth.tesla.com/user/revoke/consent?revoke_client_id=$CLIENT_ID&back_url=…`.

---

## 2. Energy endpoints (official)

Common rules:
- Header `Authorization: Bearer <user access token>`.
- POST bodies are JSON with `Content-Type: application/json`.
- Everything is wrapped as `{"response": …}`.
- **Every energy endpoint's "Pricing Category" = "This endpoint is not charged."**
- `energy_site_id` is the numeric `energy_site_id` from `/api/1/products`. It is *not* the string `id`.

### 2.1 `GET /api/1/products` — scopes `vehicle_device_data` or `energy_device_data`
Official example energy entry:
```json
{ "energy_site_id": 429124, "device_type": "energy", "resource_type": "battery",
  "site_name": "My Home", "id": "STE12345678-12345",
  "gateway_id": "1112345-00-E--TG0123456789",
  "energy_left": 35425, "total_pack_energy": 39362,
  "percentage_charged": 90, "battery_power": 1000 }
```
Additional fields seen in real responses **[community: HA fixture]**:
- `asset_site_id`, `warp_site_number`, `battery_type` (`ac_powerwall`), `backup_capable`, `storm_mode_enabled`
- `components{battery, battery_type, solar, solar_type, grid, load_meter, market_type, wall_connectors[]}`
- `features{…}`

Sites with no battery or solar also appear, e.g. a Wall-Connector-only site with all `components` false. Filter on `components.battery || components.solar`.

### 2.2 `GET /api/1/energy_sites/{id}/live_status` — `energy_device_data`
Units: power in **W**, energy in **Wh**. Sign conventions below are **[community]** and confirmed against HA.

| Field | Unit / meaning |
|---|---|
| `solar_power` | W, PV output (≥0) |
| `battery_power` | W. **+ = discharging**, − = charging |
| `grid_power` | W. **+ = importing**, − = exporting |
| `load_power` | W, home consumption |
| `grid_services_power` | W (VPP) **[community]** |
| `generator_power` | W **[community]** |
| `percentage_charged` | % state of energy (float) |
| `energy_left` | Wh remaining |
| `total_pack_energy` | Wh usable capacity *as currently estimated by the system* |
| `grid_status` | e.g. `"Active"` (others such as `"Inactive"` during an outage **[unverified]**) |
| `island_status` | e.g. `"on_grid"`; off-grid values such as `off_grid`/`off_grid_intentional` **[unverified]** |
| `backup_capable`, `storm_mode_active` | bool |
| `grid_services_active` | bool **[community]** |
| `timestamp` | ISO-8601 with offset |
| `wall_connectors[]` | `{din, wall_connector_state, wall_connector_fault_state, wall_connector_power}` **[community]** |

Official example:
```json
{"solar_power":3102,"energy_left":18020.89,"total_pack_energy":39343,"percentage_charged":45.80,
 "backup_capable":true,"battery_power":-3090,"load_power":2581,"grid_status":"Active",
 "grid_power":2569,"island_status":"on_grid","storm_mode_active":false,
 "timestamp":"2023-01-01T00:00:00-08:00"}
```

### 2.3 `GET /api/1/energy_sites/{id}/site_info` — `energy_device_data`
Official example fields:

| Field | Notes |
|---|---|
| `id` | String, e.g. `"0000000-00-A--TEST0000000DIN"` |
| `site_name` | |
| `backup_reserve_percent` | |
| `default_real_mode` | `autonomous` = time-based control, `self_consumption` = self-powered |
| `installation_date` | ISO-8601 |
| `installation_time_zone` | IANA name, e.g. `"America/Los_Angeles"`. HA fixture shows it can be `""`. |
| `user_settings{storm_mode_enabled}` | |
| `components{…}` | `solar, solar_type ("pv_panel"), battery, grid, backup, load_meter, storm_mode_capable, off_grid_vehicle_charging_reserve_supported, solar_value_enabled, set_islanding_mode_enabled, battery_type ("ac_powerwall"), configurable` |
| `version` | Gateway firmware, e.g. `"23.12.11 452c76cb"` |
| `battery_count` | |
| `nameplate_power` | W, e.g. 15000 for 3× PW2 at 5 kW |
| `nameplate_energy` | Wh, e.g. 40500 for 3× 13.5 kWh |
| `max_site_meter_power_ac`, `min_site_meter_power_ac` | |

Additional fields in real responses **[community: HA fixture]**:
- `components.gateway` (`"teg"`), `tou_capable`, `grid_services_enabled`, `backup_time_remaining_enabled`
- `components.customer_preferred_export_rule` (`pv_only` | `battery_ok` | `never`), `disallow_charge_from_grid_with_solar_installed`, `net_meter_mode`
- `components.gateways[]` `{device_id, din, serial_number, part_number, part_type, part_name, is_active, firmware_version, updated_datetime}`
- **`components.batteries[]`** `{device_id, din, serial_number, part_number, part_type, part_name ("Powerwall 2"), nameplate_max_charge_power, nameplate_max_discharge_power, nameplate_energy (Wh)}`. This is useful for per-unit nameplate.
- `components.wall_connectors[]`
- `tou_settings{optimization_strategy, schedule[{target, week_days, start_seconds, end_seconds}]}`
- `vpp_backup_reserve_percent`
- `tariff_content` / `tariff_content_v2`: the utility rate plan. Present on many sites per community reports; not in the official example. **[unverified]**
- **Solar array nameplate (kWp) is not exposed.** No PV array size, tilt or azimuth. The user must enter these.

**Site location:** **not exposed.** No lat/lon/address appears in the official `site_info`, `live_status` or `products` examples, or in the HA fixture. Use `installation_time_zone` for the timezone and ask the user for location or postcode. `user_data` covers "home address" in the scope description, but `/users/me` response fields are **[unverified]** and would be the account address, not necessarily the site.

### 2.4 `GET …/calendar_history?kind=energy` (energy_history) — `energy_device_data`
Params, all marked required in the docs:

| Param | Values |
|---|---|
| `kind` | `energy` \| `backup` (docs list only these two) |
| `start_date`, `end_date` | RFC3339, e.g. `2023-01-01T00:00:00-08:00` |
| `period` | `day` \| `week` \| `month` \| `year` \| `lifetime`. Must "align with the window requested". |
| `time_zone` | IANA, e.g. `America/Los_Angeles` |

Response: `{"period":"day","time_series":[{…}]}`. All values are **Wh per bucket**:
```
timestamp
solar_energy_exported                      # total PV generation
generator_energy_exported
grid_energy_imported
grid_services_energy_imported / grid_services_energy_exported
grid_energy_exported_from_solar / _from_generator / _from_battery
battery_energy_exported                    # total battery discharge
battery_energy_imported_from_grid / _from_solar / _from_generator
consumer_energy_imported_from_grid / _from_solar / _from_battery / _from_generator
```
- Bucket size for `period=day` is not documented. Community reports suggest hourly or daily buckets depending on window. HA sums all buckets for "today" and polls every 5 min. **[unverified]**
- Derived totals:
  - grid import = `battery_energy_imported_from_grid + consumer_energy_imported_from_grid` (+ `grid_energy_imported` in some payloads)
  - grid export = sum of `grid_energy_exported_from_*`
  - home = sum of `consumer_energy_imported_from_*`
  - battery charge = sum of `battery_energy_imported_from_*`
- **Known bug:** multi-Powerwall sites have reported inflated import/export values (vehicle-command issue #184, closed "not planned"). Sanity-check against the energy balance.

**Other kinds** (`power` = 5/15-min power time series with `solar_power, battery_power, grid_power, grid_services_power, generator_power`; `soe`; `self_consumption`; `savings`) existed on the legacy owner-API. They are **not documented for Fleet API [unverified]**. Probe `kind=power` and `kind=soe` since energy calls are free. If they work, `kind=power` gives an intraday curve without constant polling. The legacy `interval=15m` param is also **[unverified]**.

### 2.5 `GET …/calendar_history?kind=backup` (backup_history)
Same params as 2.4. Response: `{"events":[{"timestamp":"…","duration":3600}],"total_events":2}`. `duration` is in seconds off-grid.

### 2.6 `GET …/telemetry_history?kind=charge` (charge_history) — Wall Connector only
- Params: `kind=charge` (the only kind), `start_date`, `end_date`, `time_zone`. No `period`.
- Response: `{"charge_history":[{"charge_start_time":{"seconds":…},"charge_duration":{"seconds":…},"energy_added_wh":25000}]}`.
- Not useful for Powerwall/solar.

### 2.7 Commands — scope `energy_cmds`, all POST, all "not charged"
| Endpoint | Body | Response |
|---|---|---|
| `…/backup` | `{"backup_reserve_percent": 20}` | `{code:201,message:"Updated"}` |
| `…/operation` | `{"default_real_mode": "self_consumption" \| "autonomous"}` | 201 |
| `…/storm_mode` | `{"enabled": true}` | 201 |
| `…/grid_import_export` | `{"customer_preferred_export_rule": "battery_ok"\|"pv_only"\|"never", "disallow_charge_from_grid_with_solar_installed": bool}` (both optional) | 204 |
| `…/off_grid_vehicle_charging_reserve` | `{"off_grid_vehicle_charging_reserve_percent": N}` | 201 |
| `…/time_of_use_settings` | `{"tou_settings":{"tariff_content_v2":{…}}}` | 201 |

Notes on `time_of_use_settings`:
- Example tariff: https://digitalassets-energy.tesla.com/raw/upload/app/fleet-api/example-tariff/PGE-EV2-A.json
- Currencies: USD/EUR/GBP.
- Validation: no gaps or overlaps, no negative prices, buy ≥ sell.

Undocumented: Teslemetry's library also POSTs `…/energy_sites/{id}/command` with `command_type: "grpc_command"` (gateway system info, island mode, etc.). **Not in the official docs. Do not rely on it.**

---

## 3. Pricing, billing and rate limits

Official pricing (developer.tesla.com home page):

| Category | Price |
|---|---|
| Streaming signals | 150,000 / $1 |
| Commands | 1,000 / $1 |
| Data | 500 / $1 |
| Wakes | 50 / $1 |

- **$10 monthly discount per account**, described as "no costs for personal use".
- **All energy endpoints are "not charged"**, including live_status, site_info, calendar_history, products and every energy command. Auth endpoints are also not billed. So an energy-only app should cost $0.
- Billing gotchas:
  - Default billing limit is **0**. You must add a payment method to raise it.
  - Applications with no payment method or that exceed the limit are **automatically disabled**.
  - Payments are available only in listed countries (US, CA, MX, PR, GB, most of the EU, NO, CH, JP, KR, AU, NZ, TW, HK, MO, MY, TH, PH). Apps from other countries have "limited usage".
  - It is **[unverified]** whether an energy-only app with no payment method, and so a $0 limit, keeps working. Uncharged endpoints should not count against the limit, but add a card with a low limit (e.g. $1–5) to be safe.
- Requests with status < 500 count as billable usage. That is irrelevant for uncharged endpoints.
- **Rate limits** are per device, per account, and shared across all your apps:
  - Realtime data: 60 req/min
  - Device commands: 30 req/min
  - Wakes: 3 req/min
  - 429 responses carry `Retry-After` / `RateLimit-*` headers.
- **Recommended `live_status` polling:** 30–60 s.
  - HA polls live_status every **60 s** and energy_history every **5 min**, aligned to 5-min boundaries plus jitter, and honours `Retry-After`.
  - Use 60 s by default and 30 s while the UI is open. Never go below ~10 s. Tesla's own backend data typically refreshes at roughly 30 s cadence **[unverified]**.
  - Fetch `site_info` hourly or daily.
  - Fetch `calendar_history` every 5–15 min for today, and once for closed days.

---

## 4. Streaming (Fleet Telemetry)
Fleet Telemetry is **vehicle-only**:
- It needs vehicle firmware, a virtual key paired to the car, and a configure call through the vehicle-command proxy.
- The Available Data field list is vehicle signals only.

**Energy sites are not supported; use polling.** HA's `tesla_fleet` polls energy for this reason.

---

## 5. Efficiency metrics you can derive

All inputs come from `calendar_history kind=energy` (Wh), `live_status` and `site_info`.

- **Battery round-trip efficiency (RTE)** over a long window (≥7–30 days, so the SoE start/end difference is negligible):
  `RTE = battery_energy_exported / (battery_energy_imported_from_solar + _from_grid + _from_generator)`.
  - Correct for the SoE change: `+ (E_left_end − E_left_start)` added to the numerator side, using `energy_left` snapshots from live_status at window boundaries.
  - Expect ~85–90% for PW2 and ~90% for PW3 (Tesla spec 90% for PW2 AC and 97.5% solar-to-battery-to-home for PW3 DC). The measured value also includes standby/self-consumption losses of ~50–100 W. **[typical values, unverified]**
- **Capacity fade:** log `total_pack_energy` (Wh) daily, taking the median of samples near 100% SoE if possible. Compare against `nameplate_energy` from `site_info` (13,500 Wh per PW2/PW3). Health = `total_pack_energy / nameplate_energy`.
  - The value is the BMS estimate. It moves with temperature and recalibration, so use a 30-day rolling median and a linear trend (%/year).
  - Official examples show 39,343 vs 40,500 Wh, about 97%.
- **Solar performance ratio (PR):**
  - `PR = E_actual / (kWp × H_poa / 1 kW/m²)`, where `H_poa` is plane-of-array irradiation in kWh/m², and `E_actual = solar_energy_exported` converted to kWh.
  - Compute daily from Open-Meteo `global_tilted_irradiance` summed over hours (W/m² × 1 h → Wh/m²).
  - Healthy PR is ~0.75–0.85. A drop of more than 10% vs a 30-day baseline on sunny days points to soiling, shading, or string/inverter faults.
  - Temperature-corrected variant:
    - `T_cell ≈ T_air + GTI × (NOCT−20)/800` (NOCT ≈ 45 °C)
    - `P_exp = kWp × GTI/1000 × (1 + γ(T_cell − 25)) × (1 − losses)` (γ ≈ −0.0035/°C, losses ≈ 0.10–0.14)
  - kWp, tilt, azimuth and lat/lon must be **user-entered**. Tesla does not expose them.
- **Other derived metrics:** self-consumption %, self-sufficiency %, and battery cycles/day ≈ `battery_energy_exported / nameplate_energy`.
  - self-consumption = `(consumer_from_solar + battery_from_solar) / solar_energy_exported`
  - self-sufficiency = `1 − consumer_from_grid / total_consumer`

---

## 6. Weather and irradiance sources (all verified with live calls on 2026-09-24)

### 6.1 Open-Meteo: free, no key
- Terms: free for **non-commercial** use (personal home automation qualifies). Limits: 600/min, 5,000/h, 10,000/day, 300,000/month.
- Radiation variables are the **mean over the preceding hour**. Use the `_instant` variants for point values. Units are W/m².
- Variables: `shortwave_radiation` (GHI), `direct_radiation`, `diffuse_radiation` (DHI), `direct_normal_irradiance` (DNI), `global_tilted_irradiance` (GTI/POA), `terrestrial_radiation`, `cloud_cover` (%), `temperature_2m` (°C), `wind_speed_10m`.
- **`tilt`** is 0–90° (0 = horizontal).
- **`azimuth`** follows Open-Meteo's convention: **0 = south, −90 = east, 90 = west, ±180 = north**. This differs from PVWatts. `minutely_15=` is also supported.

Forecast (≤16 days ahead, `past_days` up to 92):
```
https://api.open-meteo.com/v1/forecast?latitude=37.77&longitude=-122.42
  &hourly=shortwave_radiation,direct_normal_irradiance,diffuse_radiation,global_tilted_irradiance,cloud_cover,temperature_2m,wind_speed_10m
  &tilt=25&azimuth=0&timezone=auto&forecast_days=2&past_days=1
```

Historical archive (reanalysis, 1940 onward):
- ERA5 has a ~5-day delay. ECMWF IFS is 9 km with no delay.
```
https://archive-api.open-meteo.com/v1/archive?latitude=..&longitude=..&start_date=2026-09-01&end_date=2026-09-07
  &hourly=shortwave_radiation,global_tilted_irradiance,cloud_cover,temperature_2m&tilt=25&azimuth=0&timezone=auto
```

Historical *forecast* (archived model runs). Best for recent days with no gap and higher resolution:
```
https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=..&longitude=..&start_date=..&end_date=..
  &hourly=global_tilted_irradiance,temperature_2m,cloud_cover&tilt=25&azimuth=0&timezone=auto
```

### 6.2 NREL PVWatts v8: expected output for a *typical* year (TMY), needs a free key
- **Gotcha:** NREL has been renamed (National Laboratory of the Rockies). `developer.nrel.gov` **did not resolve** during testing. `developer.nlr.gov` works.
- Get a key at the same portal. `DEMO_KEY` works for testing but is rate-limited (limit 10 observed).
```
https://developer.nlr.gov/api/pvwatts/v8.json?api_key=KEY&lat=37.77&lon=-122.42
  &system_capacity=5&module_type=0&losses=14&array_type=1&tilt=25&azimuth=180&timeframe=hourly
```
- `system_capacity` is kW DC.
- `module_type`: 0 = standard, 1 = premium, 2 = thin film.
- `array_type`: 0 = open rack, 1 = roof mount, 2–4 = trackers.
- **`azimuth` uses compass degrees: 180 = south**.
- Outputs: `ac_monthly`, `ac_annual` (kWh), `poa_monthly`, `solrad_monthly`, `dc_monthly`, `capacity_factor`. With `timeframe=hourly` you also get `ac`, `poa`, `tamb`, etc.
- Coverage uses NSRDB (Americas and parts of Asia). Use it for monthly expected-yield baselines, not day-by-day.

### 6.3 PVGIS 5.3 (EU JRC): free, no key, global except polar regions; best in Europe, Africa and Asia
```
https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=45&lon=8&peakpower=5&loss=14&angle=30&aspect=0&outputformat=json
```
- `angle` = tilt.
- **`aspect`: 0 = south, 90 = west, −90 = east**. `optimalangles=1` finds the optimum.
- Output: `outputs.monthly.fixed[]` with `E_d`, `E_m` (kWh) and `H(i)_d`, `H(i)_m` (kWh/m²), plus `totals`.
- Hourly historical PV via `seriescalc`:
  `https://re.jrc.ec.europa.eu/api/v5_3/seriescalc?lat=..&lon=..&peakpower=5&loss=14&angle=30&aspect=0&pvcalculation=1&startyear=2020&endyear=2023&outputformat=json`
  - SARAH3/ERA5 data currently runs to 2023, so it cannot compare against *this* week.

**Recommendation:**
- Live and daily PR: Open-Meteo GTI plus temperature (forecast `past_days`, or historical-forecast for backfill).
- Annual and monthly expectation: PVGIS in the EU, PVWatts in the Americas.
- Normalise azimuth per API. Store the user's azimuth in compass degrees (180 = S) and convert: Open-Meteo / PVGIS = compass − 180.

---

## Sources
- Tesla Fleet API docs: [Energy Endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/energy), [What is Fleet API](https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api), [Regions](https://developer.tesla.com/docs/fleet-api/getting-started/regions-countries), [Best Practices](https://developer.tesla.com/docs/fleet-api/getting-started/best-practices), [Conventions](https://developer.tesla.com/docs/fleet-api/getting-started/conventions), [Billing and Limits](https://developer.tesla.com/docs/fleet-api/billing-and-limits), [Auth overview](https://developer.tesla.com/docs/fleet-api/authentication/overview), [Third-party tokens](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens), [Partner tokens](https://developer.tesla.com/docs/fleet-api/authentication/partner-tokens), [Partner endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints), [FAQ](https://developer.tesla.com/docs/fleet-api/support/faq), [Announcements](https://developer.tesla.com/docs/fleet-api/announcements), [Fleet Telemetry](https://developer.tesla.com/docs/fleet-api/fleet-telemetry), [Pricing (home)](https://developer.tesla.com/)
- Home Assistant `tesla_fleet`: [docs](https://www.home-assistant.io/integrations/tesla_fleet/), `homeassistant/components/tesla_fleet/coordinator.py`, `tests/components/tesla_fleet/fixtures/*.json`
- [Teslemetry python-tesla-fleet-api](https://github.com/Teslemetry/python-tesla-fleet-api) (`tesla_fleet_api/tesla/energysite.py`, `const.py`)
- [vehicle-command issue #184](https://github.com/teslamotors/vehicle-command/issues/184), [timdorr legacy energy history](https://tesla-api.timdorr.com/energy-products/energy/history), [TeslaSync setup guide](https://teslasync.dev/guide/tesla-fleet-api), [batpred #3965 (owner-api energy dead May 2026)](https://github.com/springfall2008/batpred/issues/3965)
- [Open-Meteo docs](https://open-meteo.com/en/docs), [historical API](https://open-meteo.com/en/docs/historical-weather-api), [terms](https://open-meteo.com/en/terms), PVWatts v8 (developer.nlr.gov), [PVGIS API](https://re.jrc.ec.europa.eu/api/v5_3/)
