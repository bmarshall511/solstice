# scripts/

## PVS relay: per-panel production from the SunPower PVS6

Tesla only sees the whole array. The SunPower PVS6 sees each of the 30 panels through its microinverter, but it is only reachable on the home LAN. `pvs-relay.mjs` runs on the Mac, reads the PVS every 5 minutes and pushes the readings to Solstice:

```
PVS6 (LAN, self-signed TLS) --GET--> scripts/pvs-relay.mjs (Mac, launchd) --POST + owner cookie--> Solstice /api/pvs/readings
```

- **PVS side, read-only.** The relay logs in with `GET /auth?login` (HTTP Basic `ssm_owner` : last 5 characters of the PVS serial). The PVS6 answers `200 {"session": "<64 characters>"}` in the body (on firmware 2025.10.20.61846 it also sends the same value as a `Set-Cookie`), and the relay sends `Cookie: session=<value>` itself on the next request. It then reads `GET /vars?match=inverter&fmt=obj&cache=1`; `cache=1` is required, and the older `match=inverter/data` query answers `400 {"description": "Bad request", "errorcode": "0x0040"}`. It never calls `vars?set=` or anything else that writes. This is SunStrong's LocalAPI, which needs PVS6 firmware build 61840 or later.
- **Sessions.** The login answer carries no expiry (the body holds only `session`; the cookie has no `Max-Age`), so the relay logs in again once its session is an hour old. Without a valid session the PVS answers the inverter query with `400 {"errorcode": "0x0040"}`, not 401, so on **any** non-200 the relay logs in once more and retries; if that fails too it logs the error and tries again at the next 5-minute bucket. After a failed retry it reads `GET /vars?match=/sys/info/uptime&fmt=obj`: when the PVS answers, it is up but lists no inverters. That happened on 2026-09-28: the PVS restarted at 02:40 CDT and four hours later still listed only its 2 meters.
- **The PVS answer.** One flat JSON object keyed by path, every value a string: `/sys/devices/inverter/<n>/<field>` for n = 0–29, with the fields `freqHz`, `i3phsumA`, `iMppt1A`, `ltea3phsumKwh` (lifetime kWh), `msmtEps` (measurement time, ISO UTC), `p3phsumKw` (AC kW), `pMppt1Kw` (DC kW), `prodMdlNm`, `sn`, `tHtsnkDegc`, `vMppt1V` and `vln3phavgV`. The relay parses the numbers, reads a tiny negative power as 0, skips a record with no serial or no power or energy value, and uses the newest `msmtEps` as the reading time (the current time if there is none, or if it is more than 5 minutes ahead of the Mac's clock). When the PVS has not measured again since the last poll, the repeated `msmtEps` is stored once. (`match=livedata&fmt=obj&cache=1` also works and returns the site totals under `/sys/livedata/`; the relay does not read it.)
- **TLS.** The PVS's self-signed certificate is accepted only on the relay's own connection to `PVS_HOST`. Nothing changes the global TLS settings, so the call to Solstice keeps full certificate checks. The relay refuses to start if `NODE_TLS_REJECT_UNAUTHORIZED=0` is set. Set `PVS_CERT_SHA256` to pin the PVS certificate, so a different certificate at that address is refused before the password is sent.
- **Solstice side.** The relay posts the owner key to `POST /api/auth/owner` once, keeps the `solstice_owner` cookie in memory, and sends each poll to `POST /api/pvs/readings` with that cookie. On a 401 it unlocks once more and retries. A poll that fails on the PVS side posts `POST /api/pvs/heartbeat` instead, so the Panel health card can say "the relay is running, but the PVS …" rather than blaming the Mac. The relay shows up as one "Device" row in the owner devices list. Rotating `OWNER_KEY` stops the relay until the env file is updated.
- **What is stored.** For each inverter at each reading: time (`msmtEps`), serial, AC kW (`p3phsumKw`), DC kW (`pMppt1Kw`), volts (`vMppt1V`), heat-sink °C (`tHtsnkDegc`) and lifetime kWh (`ltea3phsumKwh`). Nothing else. Serials live only in the database.
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

- `--dry-run` should list 30 inverters with plausible `kw` and `kwDc` values (about 0 to 0.33) and a `kwhLifetime` for each. Stderr shows the certificate fingerprint; copy it into `PVS_CERT_SHA256` to pin it.
- `--once` prints one line, for example `2026-09-25T18:00:00.000Z 30 inverters, 6.912 kW AC total: 30 stored, 0 already stored`.
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
- Transient failures are logged and retried at the next bucket: the PVS or the internet unreachable, the PVS refusing the read after a fresh login, or a Solstice 5xx or 429. PVS-side failures also post a heartbeat.
- A fatal failure (refused login, refused key, certificate mismatch) exits 1. `StartInterval` starts the relay again 5 minutes later, so a wrong password shows up as one log line every 5 minutes until it is fixed.
- launchd does not run while the Mac sleeps. Those buckets have no reading, and the day roll-up counts only buckets with data (its `buckets` field shows the coverage).
- **macOS Local Network permission.** If `--once` works in Terminal but the launchd log shows `EHOSTUNREACH` or "No route to host" for the PVS, allow `node` under System Settings → Privacy & Security → Local Network.

### API

All four routes are owner-only, like every `/api` route (the `solstice_owner` cookie). They do not need a connected Tesla site.

| Method and path | Request | Answer |
|---|---|---|
| `POST /api/pvs/readings` | `{ ts, inverters: [{ sn, kw, kwDc, v, tempC, kwhLifetime }] }`. `ts` is ISO 8601 with a zone, or epoch ms, from 7 days old to 5 minutes ahead. 1–60 inverters with unique `sn`. Only `sn` is required; each other field is a number, null or left out: `kw` (AC) and `kwDc` from 0 to 2, `kwhLifetime` 0 or more. Other fields are dropped. | `{ ok, inserted, duplicates }`. The same `(ts, sn)` posted again is ignored (the first write wins). `400 { error }` names the bad field. `413` if the body is over 64 kB. |
| `POST /api/pvs/heartbeat` | `{ pvs, http, error, uptimeS }`: `pvs` is one of `ok`, `unreachable`, `login-refused`, `certificate`, `refused`, `no-inverters`, `error`; `http` the PVS's last HTTP status or null; `error` the relay's message (up to 300 characters; it may name the PVS's LAN address, so only the owner sees it); `uptimeS` the PVS's uptime or null. | `{ ok }`. Stored in kv `pvs:heartbeat` with the server's time. A stored `/readings` poll writes `{ pvs: "ok" }` there too. `GET /api/pvs/panels` turns it into `relay.cause` (`offline`: no word from the relay for 15 minutes; `pvs`: it runs but the PVS failed; `stale`: the PVS keeps sending an old measurement) and `relay.note`. |
| `GET /api/pvs/day?date=YYYY-MM-DD` | A Chicago calendar day (default today). The fall-back day is 25 hours. | `{ date, timeZone, start, end, bucketMinutes: 5, times: [bucket start, epoch ms], inverters: [{ sn, kwh, kwhSource, peakKw, maxTempC, buckets, kw: [], v: [], tempC: [] }], total: { kwh, inverters, medianKwh } }`. Series line up with `times`, with `null` where an inverter has no reading. `kwh` is the lifetime counter's last reading of the day minus its first (`kwhSource: "lifetime"`), exact across gaps; with fewer than two lifetime readings, or a counter that went backwards, it is the sum of 5-minute bucket-average AC kW × 5 min (`kwhSource: "integrated"`). |
| `GET /api/pvs/latest` | – | `{ at, ageS, count, inverters: [{ sn, ts, ageS, kw, kwDc, v, tempC, kwhLifetime }] }`: each inverter's newest reading within 7 days of the newest reading overall. |

Storage: one row per inverter per PVS measurement, at most about 8,600 rows a day for 30 inverters (about 4,300 in practice, since the PVS measures only while the panels produce). The nightly sync cron deletes readings older than 90 days (`PVS_KEEP_DAYS` in `server/src/pvs.ts`) after the learning layer has written each day's per-panel figures to `daily_metrics`, which are kept for good. kv `pvs:since` keeps the relay's first reading, so the Panel health card's "since" line survives the prune.
