# Solstice

A personal, local-first dashboard for a Tesla Powerwall + solar system, built on the Tesla Fleet API.

- **Live power flow** (polls `live_status` every 30–60 s)
- **History** from `calendar_history`
- **Efficiency alerts**: actual solar vs. an Open-Meteo irradiance model, battery round-trip efficiency, capacity fade, baseline load drift
- **three.js** visuals, installable as a PWA

## Layout

| Path | Purpose |
| --- | --- |
| `site/` | Static site deployed to Vercel. Hosts the Fleet API public key at `/.well-known/appspecific/com.tesla.3p.public-key.pem` |
| `mockups/` | Interactive design directions (simulated Tesla data, live Open-Meteo weather) |
| `docs/` | Fleet API energy research |

The app itself runs locally (`http://localhost:8787`). Secrets (`.env`, `secrets/`) are git-ignored.
