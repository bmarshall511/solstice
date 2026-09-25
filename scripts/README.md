# scripts/

## PVS relay: per-panel production from the SunPower PVS6

Tesla only sees the whole array. The SunPower PVS6 sees each of the 30 panels through its microinverter, but it is only reachable on the home LAN. `pvs-relay.mjs` runs on the Mac, reads the PVS every 5 minutes and pushes the readings to Solstice:

```
PVS6 (LAN, self-signed TLS) --GET--> scripts/pvs-relay.mjs (Mac, launchd) --POST + owner cookie--> Solstice /api/pvs/readings
```

- **PVS side, read-only.** The relay logs in (`GET /auth?login`, HTTP Basic `ssm_owner` : last 5 characters of the PVS serial) and reads `GET /vars?match=inverter/data&fmt=obj`. It never calls `vars?set=` or anything else that writes. This is SunStrong's LocalAPI, which needs PVS6 firmware build 61840 or later.
- **TLS.** The PVS's self-signed certificate is accepted only on the relay's own connection to `PVS_HOST`. Nothing changes the global TLS settings, so the call to Solstice keeps full certificate checks. The relay refuses to start if `NODE_TLS_REJECT_UNAUTHORIZED=0` is set. Set `PVS_CERT_SHA256` to pin the PVS certificate, so a different certificate at that address is refused before the password is sent.
- **Solstice side.** The relay posts the owner key to `POST /api/auth/owner` once, keeps the `solstice_owner` cookie in memory, and sends each poll to `POST /api/pvs/readings` with that cookie. On a 401 it unlocks once more and retries. The relay shows up as one "Device" row in the owner devices list. Rotating `OWNER_KEY` stops the relay until the env file is updated.
- **What is stored.** For each inverter at each poll: time, serial, kW (`pMppt1Kw`), volts (`vMppt1V`) and heat-sink °C (`tHtsnkDegc`). Nothing else. Serials live only in the database.
- **Dependencies.** Node 22 built-ins only.

### 1. Deploy the server part first

The routes ship with the app, so `/api/pvs/*` must be live before `--once` can post. Point `SOLSTICE_URL` at the production origin. A preview URL behind Vercel's deployment protection answers 401 with its own page, and the relay says so.

### 2. The env file (outside the repo)

```sh
mkdir -p ~/.solstice && chmod 700 ~/.solstice
cat > ~/.solstice/pvs.env <<'EOF'
# Solstice PVS relay. Never commit this file; the relay refuses an env file inside the repo.
PVS_HOST=<PVS LAN IP, for example 192.168.1.x>
PVS_PASSWORD=<last 5 characters of the serial number on the PVS6 label>
SOLSTICE_URL=https://<your-app>
SOLSTICE_OWNER_KEY=<the app's OWNER_KEY>
# Optional: pin the PVS certificate. The first run prints its fingerprint.
# PVS_CERT_SHA256=<AB:CD:...:EF>
EOF
chmod 600 ~/.solstice/pvs.env
```

The relay warns if the file is readable by other users. `PVS_HOST` may carry a port (`host:port`). `SOLSTICE_URL` must be `https://` (plain `http://` only for localhost).

### 3. First run, by hand

```sh
nvm use 22
node scripts/pvs-relay.mjs ~/.solstice/pvs.env --dry-run   # reads the PVS and prints the payload; never contacts Solstice
node scripts/pvs-relay.mjs ~/.solstice/pvs.env --once      # reads the PVS, posts one batch, exits 0 on success
```

- `--dry-run` should list 30 inverters with plausible `kw` values (about 0 to 0.33). Stderr shows the certificate fingerprint; copy it into `PVS_CERT_SHA256` to pin it.
- `--once` prints one line, for example `2026-09-25T18:00:03.120Z 30 inverters, 6.912 kW total: 30 stored, 0 already stored`.
- Then `GET /api/pvs/latest` from a signed-in browser should report `count: 30`.

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | The poll failed. The message names the cause: PVS login refused (wrong `PVS_PASSWORD`), owner key refused, certificate mismatch, PVS or Solstice unreachable. |
| 2 | Bad command line or env file. |

### 4. Run it every 5 minutes with launchd

```sh
mkdir -p ~/Library/Logs/solstice
cp scripts/com.solstice.pvs-relay.plist.example ~/Library/LaunchAgents/com.solstice.pvs-relay.plist
# edit the /Users/YOUR_USER/... paths in it (`nvm which 22` prints the node path), then:
plutil -lint ~/Library/LaunchAgents/com.solstice.pvs-relay.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.solstice.pvs-relay.plist
launchctl print gui/$UID/com.solstice.pvs-relay | grep -E 'state|last exit'
tail -f ~/Library/Logs/solstice/pvs-relay.log
```

Restart after editing the env file with `launchctl kickstart -k gui/$UID/com.solstice.pvs-relay`. Stop with `launchctl bootout gui/$UID/com.solstice.pvs-relay`. After editing the plist, run `bootout` and then `bootstrap` again.

**How it behaves under launchd:**
- Without `--once` the relay keeps running and polls once per 5-minute clock bucket. After the Mac wakes, it polls within 15 seconds.
- Transient failures are logged and retried at the next bucket: the PVS or the internet unreachable, or a Solstice 5xx or 429.
- A fatal failure (refused login, refused key, certificate mismatch) exits 1. `StartInterval` starts the relay again 5 minutes later, so a wrong password shows up as one log line every 5 minutes until it is fixed.
- launchd does not run while the Mac sleeps. Those buckets have no reading, and the day roll-up counts only buckets with data (its `buckets` field shows the coverage).
- **macOS Local Network permission.** If `--once` works in Terminal but the launchd log shows `EHOSTUNREACH` or "No route to host" for the PVS, allow `node` under System Settings → Privacy & Security → Local Network.

### API

All three routes are owner-only, like every `/api` route (the `solstice_owner` cookie). They do not need a connected Tesla site.

| Method and path | Request | Answer |
|---|---|---|
| `POST /api/pvs/readings` | `{ ts, inverters: [{ sn, kw, v, tempC }] }`. `ts` is ISO 8601 with a zone, or epoch ms, from 7 days old to 5 minutes ahead. 1–60 inverters with unique `sn`. `kw` is a number from -1 to 1. `v` and `tempC` are numbers or null. Other fields are dropped. | `{ ok, inserted, duplicates }`. The same `(ts, sn)` posted again is ignored (the first write wins). `400 { error }` names the bad field. `413` if the body is over 64 kB. |
| `GET /api/pvs/day?date=YYYY-MM-DD` | A Chicago calendar day (default today). The fall-back day is 25 hours. | `{ date, timeZone, start, end, bucketMinutes: 5, times: [bucket start, epoch ms], inverters: [{ sn, kwh, peakKw, maxTempC, buckets, kw: [], v: [], tempC: [] }], total: { kwh, inverters, medianKwh } }`. Series line up with `times`, with `null` where an inverter has no reading. `kwh` is the sum of 5-minute bucket-average kW × 5 min. |
| `GET /api/pvs/latest` | – | `{ at, ageS, count, inverters: [{ sn, ts, ageS, kw, v, tempC }] }`: each inverter's newest reading within 7 days of the newest reading overall. |

Storage: one row per inverter per poll, about 8,600 rows a day for 30 inverters.
