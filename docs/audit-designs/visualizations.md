# Solstice three.js visualizations: final design

Phase 1, read-only. This is the judge's merge of Candidate A ("cinematic: one home twin, many framings") and Candidate B ("pragmatic: one house, one contract, existing endpoints"). **B wins and supplies the structure.** A's better ideas are grafted in, and each is tagged **[A]**. Ideas from B are tagged **[B]**. Anything dropped is listed in section 11 with the reason.

## 0. Scoring

I checked both designs against the code myself: `web/src/main.js`, `scenes/*.js`, `views/*.js`, `lib/*.js`, `server/src/app.ts`, `db.ts`, `sync.ts`, `appliances/{ac,pool,autopilot}.ts`, `style.css`, `index.html`, `public/sw.js`, `vite.config.js` and `mockups/`.

| Criterion | A (cinematic) | B (pragmatic) | Notes from verification |
|---|---|---|---|
| Fit to codebase | 6/10 | 8/10 | **A's errors:** it put the condenser at house-local z 2.5 m, but thermaltwin's `(−Wd/2−.75, .4, 2.4)` is in a 0.28-scaled frame, so it is really about z 8.6 m, on top of the gateway (B caught this). A extends `/api/day`, which `loadNow` polls every 30 s. It adds the `Line2` addon. **B's errors:** it says "nothing new server-side" for the 48 h view, but `acDetail().week[]` has only `{date, high, sunKwhM2, precool, depth, kwhSaved}`, with no window hours, so tomorrow's pre-cool window cannot be placed. **B verified correctly:** `home.js render()` already takes `now`/`dayStart`/`r`, so replay is just a synthetic frame. `hourlyIndex` is exported and unused. `S.preview` calls `go('v-now')` and shows a toast. `.ring3d/.land/.roof3d` use `touch-action:none`. **Both designs** name mockups `j-*`, but `mockups/j-ui-fixes.html` already exists. |
| Owner value | 9 | 8 | A's outage ladder, 48 h window fields, year-ring ghost and full-battery ticks, and flow money readout are real value adds. |
| Simplicity | 5 | 8 | A splits `buildHouse` into a big multi-layer model with 5 framings, a pool/AC cutaway inside the realistic house and auto framing switches. B adds an `extras` group and a replay mode. |
| Serverless cost | 6 | 8 | A adds 2 queries to every `/api/day` poll (30 s per open client, plus History day views). B uses a separate per-date cached endpoint. For `/api/flows`, **A's single SQL aggregate beats B's JS split over transferred rows**, so A's version is grafted in. |
| Privacy (public repo, no-auth single-owner API) | 7 | 7 | Both add public GETs of `nest_readings`. B's payload includes `eco`, which reveals Away, so it is dropped. Both keep mockup money synthetic. |
| Risk | 5 | 8 | A changes the approved Now card (height 370→400, new title, framing pills, auto-switch on outage), which conflicts with rule 3. B keeps the live framing pixel-identical. |

## 1. Rules this design obeys (from CLAUDE.md)

- **Visual-only, read-only.** No scene, card or new endpoint writes to ScreenLogic, Nest, Tesla or settings.
  - New endpoints are GET-only and read **only the database**. They never call `readPool()`/`readNest()`, so the design adds **zero** SDM queries and stays under Google's ~5 QPM limit.
  - The "Without AC / Without AC + pool" chips are simulations. POOL/AC labels link to Insights → Appliances and offer no actions.
  - Views reuse `S.pool` (loaded at boot by `initAppliances`) and `S.ac` (`initAc`, every 3 min). No new `api.ac()`/`api.pool()` calls.
- **Rule 3.** The Now "Energy flow" live framing, canvas height (370 px) and title stay as they are. The Panels roof stays house + panels + Powerwalls: the pool, pad and condenser `extras` group is hidden in `'sun'` mode. The approved AC comfort chart and pool twin (mockups h and i) are not touched.
- **Rule 5.** Mockups use synthetic numbers shaped like the facts (≈76 kWh/day, solar ≈49%, 27 kWh, pool 153 W @1500, AC 2.0 kW). No system price, loan, payback or bill figures. The Sankey `$` readout in mockups is sample data.
- **Rules 1 and 2.** Mockups come first (section 10). Phase 2 is built in batches of about 5 on a preview branch.

## 2. Shared scene lifecycle contract

The central host is from [A]. The per-scene factory/`dispose` shape, `sceneDpr`, palette, flowline module, scrub DPR drop and on-demand shadows are from [B].

**Why it is needed.** Every scene owns a `WebGLRenderer`, and none is ever disposed. At boot `main.js` creates aurora, orb, house (Now), roof (Panels) and dayRing. Landscape builds on first data, and pool/thermal twins build on first draw, so there are up to 8 contexts. Six more scenes without a host risk iOS context eviction.

```js
// web/src/scenes/host.js (new, ~90 lines)
export const isPhone = () => matchMedia('(pointer: coarse)').matches || innerWidth < 900;
export const sceneDpr = () => Math.min(devicePixelRatio, isPhone() ? 1.5 : 2);
export function createSceneHost({ root = $('screen'), maxMounted = 3, keepAliveMs = 45_000 } = {}) → {
  add(el, factory, { keep = false } = {}) → handle,  // factory: async (el, env) => scene; does `await import('./x.js')` so Vite splits the chunk
  frame(dt, ctx),   // main.js calls once per rAF; renders built + ≥10% visible scenes
  sync(),           // main.js go() calls after a tab switch
  resizeAll(),
  stats(),          // { built, contexts, frameMs, dpr } → one row in Insights → Home → Data health
}
// handle: { set(patch), pick(x, y), focus?(name) }  (the host caches the merged state and replays it into a rebuilt scene)

// every scene module
export function createXScene(el, { dpr, palette, phone }) → {
  set(patch),              // data only, no GL work; marks dirty
  render(dt, ctx),         // lerps toward targets; never fetches, never owns timers or rAF
  resize(),
  pick?(x, y) → hit | null,
  dispose(),               // geometries, materials, textures, CSS2D nodes, renderer.dispose() + forceContextLoss(), canvas removed
}
// ctx = { t, calm, out: S.outageActive, live: S.live, peakKw: S.peakKw ?? 9, now: Date, hour: number | null }
```

Host rules:

- **Build and sleep.**
  - An `IntersectionObserver` (root `#screen`, `rootMargin: '160px 0px'`) builds a scene on first approach. The scene renders only while ≥10% visible and `el.offsetParent` is set.
  - On a tab switch it pauses at once. It is disposed after `keepAliveMs` = 45 s off-screen, then rebuilt from cached state on return [B].
  - `keep: true` pins aurora, orb and the Now house. Cap: 3 unpinned built scenes, so ≤ 6 live contexts. Above the cap, the least-recently-visible scene is disposed first [A].
  - `document.hidden` pauses everything (as today).
- **DPR.**
  - `sceneDpr()`: 1.5 on phones, 2 on desktop.
  - Adaptive: after 60 consecutive frames over 24 ms, the heaviest built scene drops 0.25 (floor 1.0) [A].
  - During scrubber `pointerdown` DPR drops to 1.25 and is restored on `pointerup` [B].
- **Shadows.** Only on scenes that contain the house.
  - `renderer.shadowMap.autoUpdate = false`, with `needsUpdate = true` only when the sun moves ≥ 0.5° or the camera eases [B].
  - Map size 1024² on phone, 2048² on desktop.
  - Analytic scenes (48 h, Sankey, year ring, health) have no lights beyond hemi + key and no shadows.
- **Touch.** Canvases on scrolling tabs use `touch-action: pan-y`. OrbitControls run with `enableZoom = enablePan = false` and damping. Scenes with fixed cameras use pointer parallax and no OrbitControls.
- **Calm** (`S.calm`, which is also `prefers-reduced-motion`): no autoRotate, particles at the existing `T × .35` pace, camera tweens instant, lightning off. DPR is unchanged, because calm means reduced motion, not low power.
- **Colour.** `web/src/scenes/palette.js` reads the `:root` tokens once via `getComputedStyle`. Add two tokens to `:root` in `style.css`: `--ac:#ff9e66; --rest:#8d93a8;`. These are the Day Ring's existing constants, so nothing visible changes. New scenes contain no other hex [A+B].
- **Overlays.** DOM only, using the existing classes `.hlbl/.hlead`, `.lbl3d`, `.lax`, `.roofhud`, `.hud`, `.tlab`, `.landtip`, `.readout`, `.kv`, `.seg2`, `.chip`, `.circ`, `.scrub`, `.legend`. At most 5 overlays visible on a phone at once. Scenes remove their overlays on `dispose()`.
- **Camera tweens.** 600 ms, `--ease` (`cubic-bezier(.2,.8,.2,1)`). A `pointerdown` cancels the tween.
- **`main.js` changes.** Replace the per-scene `isOn(...) && x.render(...)` lines with `host.frame(dt, ctx)`, and call `host.sync()` from `go()`. New scenes ship through the host from day one. Existing scenes adopt it in item V9, with no visual change.
- **Shared modules** [B]:
  - `web/src/scenes/flowline.js`: the dash-flow `ShaderMaterial` (`uColor, uT, uOn, uDir, uLen, uSpeed`) and the tube builder, extracted from `home.js`.
  - `web/src/scenes/geo/house.js`: `buildHouse()` moved unchanged, plus an `extras` group.
  - `util.localDayStartMs(date)`: the Chicago-midnight code lifted out of `main.js frame()`.
  - `splitFlows()` moves from `views/now.js` to `lib/model.js`, re-exported from `now.js`.

## 3. Scene 1: whole-home energy twin with a day scrubber (Now → Energy flow card)

The base is [B]. The HUD, coverage honesty, idle-return, keyboard and label links come from [A].

**Decision it informs:** "What did the house do at 2 PM? Did the pool window and the pre-cool actually run on sunshine? When did the Powerwalls fill? When did PEC supply us?"

**Where.** The existing `#house` card on Now.
- The canvas stays 370 px and the live camera stays `(−38, 19, 12) → (−3, 2.2, 3.5)`, fov 32.
- Added **under the canvas** inside the card:
  - a 34 px `.scrub` row: `▶`, `<input type=range min=0 max=24 step=.0833>`, mono time label, `Live` pill;
  - a `.circ` chips row: `Pool 153 W`, `AC cooling 2.0 kW`, `PW 74% ▲`;
  - a `.landtip` readout.
- `flowNote` reads `live · 2:35 PM` or `replay · 9:10 AM`.
- Q1 asks whether this belongs on the approved card or in a new card.

**Data.**

| Element | Source |
|---|---|
| kW flows and SOC at hour h | `S.today.buckets[{t, solar, home, grid, battery}]` and `S.today.soe[{t, soc}]` (`/api/day`, already refreshed every 30 s), linearly interpolated. Panel glow clamps at `S.peakKw` (≤ 9.45) because 5-min buckets can read high. |
| Sun | `sunAt(new Date(dayStart + h*36e5))` |
| Cloud, weather code, temperature | `S.wx.hourly` via `hourlyIndex(w)` (radiation is for the hour ending at t) |
| Pool | **new** `GET /api/appliances/day` → `pool[]`. Nearest sample ≤ 20 min away, else the schedule model: `S.pool.current.hourly[floor(h)]` (rpm, frac) × `W(rpm)` from `S.pool.model.curve`, plus `S.pool.extras.hourlyToday[h]`. `source: 'measured' \| 'schedule'` [A thresholds]. |
| AC | same endpoint → `nest[]` (5-min cron, so dense). Nearest sample ≤ 10 min away, else `S.ac.plan.steps` + `simulateDay()` (moved from `views/ac.js` to `lib/replay.js`), `source: 'measured' \| 'plan'`. AC kW is `S.ac.learned.acKw` (2.016) while `hvac === 'COOLING'`. |
| Outage spans | `S.outages` (`ts`, `duration_s`). `out = true` inside a span turns the grid line red (existing branch). |
| Live (h ≥ now) | `S.live`, `S.pool.live`, `S.ac.state` |

```ts
// server/src/app.ts (new route beside /api/appliances/ac). DB only, never readPool()/readNest().
GET /api/appliances/day?date=YYYY-MM-DD
→ { date,
    pool: Array<{ t: number; running: boolean; watts: number; rpm: number; waterTemp: number|null; airTemp: number|null; circuits: number[] }>,
    nest: Array<{ t: number; indoorF: number|null; humidity: number|null; hvac: string; mode: string|null; coolF: number|null; heatF: number|null }> }
// t = Chicago local hour float from the bigint ts (same convention as /api/day).
// Two indexed queries on (site_id, day). `eco` is deliberately not served: on a public no-auth API it reveals Away.
// Cache-Control: private, max-age=86400 when date < today, else no-store.
```

```js
// web/src/lib/replay.js (new)
export function buildReplay(S, date, applDay) → {
  date, dayStart, span: [firstT, lastT],
  coverage: { tesla, pool, nest },   // 0–1 fraction of the day with data [A]
  at(h) → { h, now: Date, sun: {el, az}, cloud, code, tempF,
            r: { solarKw, homeKw, batteryKw, gridKw, soc },  // shaped exactly like S.live, so home.render() takes it unchanged
            out: boolean,
            pool: { running, rpm, watts, circuits, waterTemp, source },
            ac:   { hvac, indoorF, coolF, kw, phase: 'pre-cool'|'coast'|null, source },
            sentence }                                       // HUD line [A]
}
```

- `S.applDay[date]` caches the fetch. It is fetched on the first scrub and then every 5 min while replaying today, never on the 30 s loop.
- `S.replay = { date, h, playing }` lives in `main.js`.

**Geometry** (house-local metres, before the 154° yaw). Everything is added in `geo/house.js` `extras`, which is hidden in `'sun'` mode:

- **Pool.**
  - Outline from `pooltwin.js` `outline[]`, rescaled from `FT = .2` to `.3048` m/ft: 32'7" × 18'5" → 9.9 × 5.6 m.
  - Centre (−3, 0, −23), north of the patio (the patio spans z −17.5…−11.5). Long axis roughly east-west.
  - Water: `ShapeGeometry` with pooltwin's `waterMat()`. `uFlow = running ? .4 + rpm/3450 : 0`; `uGlow` from the light circuit.
  - Spa cylinder at the NW end, raised 0.3 m.
  - Equipment pad 0.76 × 2.4 m east of the pool, with the pump block and a rotor torus spinning ∝ rpm.
  - One additive stream (90 points) skimmer → pump → returns.
  - Spa, waterfall, jet and blower effects stay in the Insights pool twin.
  - The placement is a guess (Q2).
- **AC condenser.**
  - 0.9 × 0.8 × 0.9 m box on the west wall at (−W/2 − .8, .45, 6.2), between the last window (z 4.5) and the gateway (z 8.6). This is a placeholder (Q2).
  - Fan torus and blade from thermaltwin, spinning while cooling.
  - Exhaust cloud of 120 points while cooling.
  - Window emissive shifts `0xffc98a → 0xcfe6ff` while cooling.
- **Powerwall fill strips.**
  - A 0.02 × 1.0 × 0.6 emissive plane on each PW slab, geometry translated +.5 so `scale.y = soc/100`.
  - Colour `--batt` when charging, `--solar` when discharging, `--mute` when idle, as `.pwu` does.
  - A thin `--out` reserve tick at `S.now.site.reservePct` [A].
- **Two more feeds** in `FEED`, using `flowline.js`:
  - `pool: [X,1.6,5.3] → ground → pad`, colour `--home`;
  - `ac: [X,1.6,5.3] → [X,1.0,6.2] → condenser`, colour `--ac`;
  - speed ∝ kW.
- **Draw-call cleanup.** The 30 panel meshes and 30 `EdgesGeometry` lines become one `InstancedMesh(30)` plus one merged `LineSegments` (offsets by hand): ~60 draw calls → 2 [B, A agrees].

**Interactions.**

- **Scrubbing.** On scrub start the camera eases (600 ms) to the twin framing `(−46, 27, −2) → (−3, 1.2, −6)`, fov 34 (the mockup tunes this), which takes in the house, pool and pad.
  - While dragging, `home.render()` gets `replay.at(h)` at ≤ 30 Hz.
  - `▶` plays at 1 h/s up to now, then goes live.
- **Returning to live.** Any of these snaps back to live and the original framing: `Live`, 20 s idle (unless calm) [A], or releasing within 10 min of now.
- **Keyboard (desktop).** ←/→ moves 5 min; with Shift, 1 h [A].
- **Hours after `lastT`** are dimmed (no data) while the sun and sky keep moving [A].
- **Labels.** The four existing `.hlbl` (SOLAR, HOME, POWERWALL · 2×, PEC GRID) plus `POOL` (`1,500 rpm · 153 W`) and `AC` (`2.0 kW · cooling · 74°`), positioned by the existing anchor projection. Tapping POOL or AC goes to Insights → Appliances with that appliance selected (`data-go`). It is a link, not a control [A].
- **HUD** (`.roofhud`, top-left):
  - mono line: `2:35 PM · ☀ 6.1 kW → home 3.2 · PW +2.4 · PEC +0.5 · 64%`;
  - Manrope line: `Pump at 1,500 rpm on sunshine · AC pre-cooling to 74° · Powerwalls filling`;
  - `(schedule)` / `(plan)` tags on modelled values;
  - coverage chips `pool 62% · nest 100%` only when below 90% [A].

**Budget.** ≈ 9k triangles (≈ 7k after instancing); ≈ 48 → ≈ 20 draw calls; 90 + 120 points plus the existing 1,200 rain lines; DPR 1.5 on phone and 2 on desktop; shadows on demand. Pinned on Now. Target 3–4 ms/frame on an A15-class phone.

**Files.** `web/src/scenes/{host,palette,flowline}.js`, `scenes/geo/house.js`, `scenes/home.js` (`setMode('live'|'replay')`, `setFrame(frame)`, `dispose()`, POOL/AC labels), `web/src/lib/replay.js`, `lib/util.js`, `lib/api.js` (`applDay(date)`), `main.js`, `views/now.js`, `index.html`, `style.css` (`.twin-row`), `server/src/app.ts`.

## 4. Scene 2: next 48 hours as a "road" (Now → Next 48 hours card)

The geometry is [B]. The window fields, marker text parity and label cap are from [A].

**Decision it informs:** "Will the Powerwalls fill before the pre-cool? Is the pool window under the sun? How low do we go tonight?"

**Where.** It replaces the `#fc48` SVG inside the existing card with a 260 px canvas. `#fcTxt` and the legend are unchanged. The SVG stays as the fallback when `getContext('webgl2')` is null.

**Data.**
- `S.fc48 = fc` (one-line stash in `renderWeather`): `points[{k, t, s, h, soc, g}]`, `full`, `low`, `importKwh`.
- `S.now.site.reservePct`.
- `S.wx.hourly.cloud_cover / weather_code / precipitation_probability`.
- **Pool:** today applied from `S.pool.current.schedules` (solid); tomorrow from `S.pool.autopilot.tomorrow.plan.start/stop/boostAt` (outlined, because it is planned).
- **AC:** today from `S.ac.plan.precoolFrom/precoolTo/coastFrom/coastTo`; tomorrow from `S.ac.week[1].precoolFrom/precoolTo/coastFrom/coastTo`, which is **new** (item V2a) [A]. `planFor()` already returns these; `acDetail()` drops them when it builds `week[]`.

**Geometry** (x = hours, 1 unit/h, 0..48):
- **Solar lane** at z +1.2: `BufferGeometry` triangle strip (2 verts/hour, top = 0.25·kW) in `--solar`.
- **Home lane** at z 0: `--home` at .35 opacity with a 1 px `THREE.Line` top edge.
- **SOC wall** at z −1.2: `--batt` emissive-looking strip, height 2.5·soc.
- **Reserve:** `LineDashedMaterial` in `--out` at 2.5·reserve.
- **Floor:** `InstancedMesh(48)` of plane tiles, coloured per instance for night/day and darkened by cloud.
- **Schedule gutter** at z 1.8–2.2: `InstancedMesh` boxes for pool (`--home`), pre-cool (`--batt`) and coast (`--grid`). Planned windows get a second `LineSegments` outline.
- **Markers:**
  - `full by Tue 1:40 PM`: green sphere and `.lax` label;
  - `lowest 22% · Wed 6 AM`: `--warn` sphere;
  - `now`: white vertical line at x 0;
  - rain glyph `.lax` at hours with ≥ 50% precipitation probability.
  - Marker text must match `#fcTxt` exactly [A]. At most 4 labels at once: day-2 windows show only once the camera passes +24 h [A].
- ≈ 2k triangles, 8 draw calls, `MeshBasic` materials only, no lights, no addons (no `Line2`).

**Interactions.**
- Camera `(−4, 4, 6) → (18, .6, 0)`, fov 34.
- Horizontal drag slides `camera.position.x` over 0..34 (damped), so you "drive" into tomorrow. Vertical drag scrolls the page (`pan-y`). No autoRotate.
- Tap raycasts the floor tiles → `instanceId` = hour → `.landtip`: `Thu 2 PM · solar 6.1 kW · home 3.8 kW · Powerwalls 74% · PEC 0 · pool 1,500 rpm · pre-cool`.

**Budget.** DPR 1.5 on phone, no shadows, renders only while in view on Now.

**Files.** `web/src/scenes/forecast48.js`, `views/now.js`, `index.html`, `main.js`, `style.css`, `server/src/appliances/ac.ts`.

## 5. Scene 3: where every kWh went (2.5-D Sankey) (History, new card after `#hstats`)

The node layout, fixed parallax camera and card are [B]. The single-SQL endpoint, 7th edge, residual, appliance helpers and money readout are [A].

**Decision it informs:** "Of what we used, how much was sunshine, stored sunshine or PEC? What did the AC and the pool take? How much solar went to PEC?" This feeds the more-panels-vs-more-battery question.

**Where.** A new card `Where every kWh went · <range>` directly after `#hstats`. It follows the existing range and day navigator:
- Day → `from = to = day`
- Week → last 7 days
- Month → last 30 days
- Year → last 12 calendar months (as `drawBars` does)

Header readout: `112 kWh used · 58% sunshine`.

```ts
// server/src/app.ts
GET /api/flows?from=YYYY-MM-DD&to=YYYY-MM-DD      // to inclusive, ≤ 400 days
→ { from, to, days,
    kwh: { solarHome, solarBatt, solarGrid, battHome, gridHome, gridBatt, battGrid,
           solar, home, import, export, charge, discharge,
           residual: { home: number, export: number } },          // shown as "unaccounted"
    home: { pool: { kwh, source: 'readings'|'schedule', coverage }, ac: { kwh, source: 'readings'|'heat-model'|'none' }, rest },
    money: { importUsd, exportCreditUsd|null, rate },               // import × S.tariff.importRateAllIn; export credit only if the tariff has one
    method: 'split-estimate' | 'fleet-split' }
// Cache-Control: private, max-age=86400 when to < today, else no-store. Client caches per `${from}|${to}` in S.flowsCache.
```

```sql
-- one aggregate: per-row LEAST/GREATEST (the same arithmetic as splitFlows), then SUM; Wh → kWh in TS. COALESCE(col, 0) on every column.
SELECT SUM(LEAST(solar_wh, home_wh)) solar_home,
       SUM(LEAST(GREATEST(solar_wh - LEAST(solar_wh, home_wh), 0), charge_wh)) solar_batt,
       SUM(GREATEST(solar_wh - LEAST(solar_wh, home_wh) - LEAST(GREATEST(solar_wh - LEAST(solar_wh, home_wh), 0), charge_wh), 0)) solar_grid,
       SUM(LEAST(discharge_wh, GREATEST(home_wh - LEAST(solar_wh, home_wh), 0))) batt_home,
       SUM(GREATEST(home_wh - LEAST(solar_wh, home_wh) - LEAST(discharge_wh, GREATEST(home_wh - LEAST(solar_wh, home_wh), 0)), 0)) grid_home,
       SUM(GREATEST(charge_wh - LEAST(GREATEST(solar_wh - LEAST(solar_wh, home_wh), 0), charge_wh), 0)) grid_batt,
       SUM(GREATEST(discharge_wh - LEAST(discharge_wh, GREATEST(home_wh - LEAST(solar_wh, home_wh), 0)), 0)) batt_grid,
       SUM(solar_wh) solar, SUM(home_wh) home, SUM(import_wh) import, SUM(export_wh) export, SUM(charge_wh) charge, SUM(discharge_wh) discharge
FROM energy WHERE site_id = $1 AND day BETWEEN $2 AND $3;
```

```ts
// server/src/appliances/pool.ts: factor the extras integration already in poolDetail() into a helper
export async function poolKwhBetween(siteId: string, from: string, to: string, settings: PoolSettings, W: (rpm: number) => number)
  → { kwh: number; source: 'readings' | 'schedule'; coverage: number }  // readings (gaps ≤ 10 min) when ≥ 12 samples/day on ≥ 80% of days, else current.kwhPerDay × days
// server/src/appliances/ac.ts
export async function acKwhBetween(siteId: string, from: string, to: string, acKw: number, slope: number)
  → { kwh: number; source: 'readings' | 'heat-model' | 'none' }        // COOLING minutes × acKw (gap cap 10 min, as runtimeToday); else slope × Σ max(0, high − 80)
                                                                        // from kv 'wx:highs' (covers only the last 120 days → 'none' beyond, folded into rest)
```

**Geometry.**
- **Nodes:**
  - sources at x −4: Solar (y 3), PEC grid (y 0), Powerwalls-out (y −3);
  - sinks at x +4: Home (y 3), Powerwalls-in (y 0), PEC export (y −3).
- **Slabs:** `BoxGeometry(.5, h, .6)`, h ∝ kWh (largest column = 5 units, min .4), with pooltwin's `glass(c, .12)` and `edges`.
- **Ribbons:**
  - A cubic Bézier sampled 24× and built as flat strips, width ∝ kWh (min .08).
  - `uv.x` runs along the ribbon so the `flowline.js` dash shader animates each edge (`uSpeed` ∝ kWh/day).
  - Coloured in the source colour, blending to the sink colour over the last 30% [A].
  - 7 ribbons; a zero edge is hidden.
- **Home sink** is three stacked slabs: pool `--home`, AC `--ac`, rest `--rest`. Each gets a `.lbl3d` with provenance: `AC 21 kWh · measured`, `pool 4.1 kWh · from the schedule`.
- **Edge labels:** `.lbl3d` at ribbon midpoints. Below 400 px width they collapse to kWh only, with names in the `.legend` row.
- ≈ 3k triangles, ≈ 12–14 draw calls, no lights, no particles.

**Interactions.**
- Fixed camera `(0, .5, 13)`, fov 34. Pointer gives ±12° yaw parallax that springs back. No OrbitControls, so no touch conflicts.
- Tap a ribbon or slab: it brightens (`uOn` 1, others .45), and `.landtip` shows `Solar → Powerwalls · 12.4 kWh · 31% of solar · $1.32 at your rate`.
- Tapping Home cycles the slice highlight.

**Fine print** (on the card): battery→grid and grid→battery while solar is present are estimated from the stored totals, until V3c.

**Phone.** 300 px tall.

**Files.** `web/src/scenes/sankey.js`, `views/history.js`, `index.html`, `main.js`, `style.css`, `lib/api.js`, `server/src/app.ts`, `appliances/pool.ts`, `appliances/ac.ts`.

## 6. Scene 4: outage readiness (Insights → Home, new first card)

The placement, night mode, neighbourhood, toggles, `simulateIsland` and card-local preview are [B]. The ladder rungs, usable-kWh formula, 10 kW note and state/last-outage rows are [A].

**Decision it informs:** "If PEC dropped now, how long would we last? What should I switch off? Would tomorrow's sun carry us?"

**Where.** A new first card `Outage readiness` in `#ip-home`, above "Heat & your AC". The Now card is untouched: it already turns the grid red when islanded.

**Scene.** `createHomeView(el, 'night')` is a separate host-managed instance, built only while this card is in view.
- Sun forced to el = −10, using the existing moon + nightFill lighting. Windows lit. PW LEDs and fill strips on. Flow lines live.
- Grid tube red and static (the existing outage branch). Shadows off.
- **Neighbourhood:** six dark houses on a loose ±35 m grid, as `InstancedMesh` boxes plus an `InstancedMesh` of the 6-triangle hip roof, matte `0x14161c`, no windows.
- **PEC pole** (cylinder + dark lamp) at the grid tube's end (X−3, 0, 14).
- When `live.stormActive` or an NWS alert is active: `cloud = 1`, rain on, and a hemisphere-light flash every 6–12 s (off in calm).
- ≈ 9.5k triangles, ≈ 25 draw calls.

**Client-side model (no endpoint).**

```js
// web/src/lib/model.js: shares forecast48's step function (reserve 0, no grid)
export function simulateIsland({ soc0, capKwh, maxKw, hours = 48, solarKw /* number[] */, loadKw /* number[] */ })
  → { points: [{ k, soc, s, h }], emptyAt: string | null, sunAdds: number /* hours */, minSoc, unmetKwh }
```

- `loadKw` = `S.profile[h]` minus the toggled loads. `solarKw` comes from `S.fc48` (GTI × `yieldK`).

**Controls and content.**

- **`.seg2` toggles:** `As is · Without AC · Without AC + pool`.
  - Each re-runs `simulateIsland`. The fill strips animate down to the predicted empty point over 2 s.
  - The HUD reads `9 h 40 m at 2.4 kW · sun tomorrow adds ~6 h`.
  - The subtracted loads are AC = `S.ac.learned.acKw × S.ac.runtime.duty/100` (60% on a ≥ 90°F day when duty is null) and pool = `S.pool.live.watts`, or the schedule model × `S.pool.plan.hours/24`.
- **`Preview` chip:** drives a card-local `previewOutage` flag. It does **not** touch `S.preview`, which calls `go('v-now')` and shows a toast.
- **`.kv` ladder** [A]. `usableKwh = soc/100 × capacityKwh × .95` and `hoursAt(rung) = usableKwh / cumulativeKw`:

| Rung | kW |
|---|---|
| Always-on | min of `S.overnight` over the last 30 nights (1–5 AM mean) |
| + Pool pump | `W(filterRpm)` (≈ 0.153) × `S.pool.plan.hours / 24` |
| + AC | `acKw × duty` as above |
| + Lights/blower (only when on now) | `S.pool.extras.loads` |
| + Everything else | `S.profile[hour] − above`, floored at 0 |

- **Further `.kv` rows:** Powerwalls now, reserve %, backup at current draw, tonight (sim `emptyAt`), tomorrow's solar kWh, and "up to 10 kW at once (2 × PW2 at 5 kW continuous)". If `S.ac.learned.heatKw > 10`, add: "electric strip heat would exceed that in winter."
- **State chips:** Storm Watch (`S.now.site.stormWatch`, `live.stormActive`), NWS (`S.nws[0].event`), ERCOT (`S.ercot`), reserve %.
- **Last outage row:** `last outage: Aug 3 · 1 h 12 m · 7 in 12 months · longest 4 h 51 m` from `S.outages` and `S.records.longestOutage` (`duration_s`). Then the existing `outStrip`-style 12-month timeline.

**Phone.** 330 px canvas, HUD top-left, chips row, `.kv`.

**Files.** `web/src/scenes/home.js`, `scenes/geo/house.js`, `lib/model.js`, `views/insights.js`, `index.html`, `main.js`, `style.css`.

## 7. Scene 5: your year ring (History, new card after "Production landscape")

The rings, lazy build and tap-to-open are [B]. The last-year ghost, full-battery ticks, outage bead sizing, grow-in and `showDay` are [A].

**Decision it informs:** Seasonality, the summer AC hump, how self-sufficient each month was, and where the outages and full-battery days cluster. 437 stored days that nothing else shows at once.

**Data.**
- `S.daily` (already loaded, 400 days: `date, solar, home, import, export, charge, discharge, socMin, socMax`), `S.outages`, `S.highs`.
- **The ghost** needs 730 days: on first build the card fetches `api.daily(800)` once. It is **not** added to the 5-min `loadHistory` loop. With 437 days backfilled, the ghost exists only where prior-year days exist (about the last 72 days today), and the card says so.

**Geometry.** Camera from `dayring.js`: `(0, 9.6, 6.2)`.
- Three `InstancedMesh(365)` rings of `BoxGeometry(.05, 1, .11).translate(0, .5, 0)`:
  - solar outward at r 3.2 (`--solar`, height ∝ kWh, max 2.4 units);
  - home at r 2.6 (`--home` at .6);
  - import at r 2.1 (`--grid`).
- **Last-year ghost:** one `LineLoop` at the solar ring whose radius offset per day is last year's solar (`--solar` at .25), 1 draw call [A].
- **Full-battery days** (`socMax ≥ 99`): instanced thin `--batt` ticks on the floor [A].
- **Outage days:** instanced `--out` beads above the bar, radius ∝ √duration [A].
- 12 month labels (`.lax`) and a "today" hand.
- Bars grow in over 1.2 s on first build.
- ≈ 13k triangles, ≈ 7 draw calls.

**Interactions.**
- Slow autoRotate until the first touch (off in calm). Drag orbits (polar .35–1.0).
- Tap → `instanceId` → date → `.readout`: `Jun 14 · 61 kWh solar · 79 home · 12 from PEC · 9 sent · 97°F · full at 100%`, plus `Open this day →`. That link calls a new `showDay(S, date)` export in `history.js`, which sets `day` and `range = 'day'` and redraws.

**Phone.** 330 px (the `.ring3d` height), DPR 1.5.

**Files.** `web/src/scenes/yearring.js`, `views/history.js`, `index.html`, `main.js`, `style.css`.

## 8. Scene 6: roof dust veil + expected-vs-actual (Panels → Live roof, existing scene)

This is [B], plus [A]'s clipping note, corrected.

**Decision it informs:** "Is dust costing enough to clean this week, and which hours fell short of what the sun offered?"

- **Veil.** The panel `CanvasTexture` gets a second noise layer drawn at alpha `score/100 × .35`.
  - `S.dust = { score, loss }` is stashed in `drawCleaning()`.
  - The texture is re-uploaded only when `drawPerformance` runs, never per frame.
  - On by default and subtle.
- **Hour bars** behind a `.chip` toggle, default **off**, so the roof stays minimal:
  - one `InstancedMesh` of 2 × 15 thin boxes at the sun-path hour marks (`sunVec(sp) × 150`, 6 AM–8 PM);
  - expected (white at .25) = `S.wx.hourly.global_tilted_irradiance × S.yieldK` for the hour ending at t;
  - actual (`--solar`) = the mean of `S.today.buckets` in that hour.
- **HUD** (one extra `.roofhud` line):
  - `sun says 6.1 kW · panels 5.6 kW (92%)`;
  - when an **hourly mean** reaches ≥ 9.2 kW: `flat-topping at the microinverters' 9.45 kW`. Single 5-min buckets are inflated (CLAUDE.md), so they are not used.
- +0.4k triangles, +2 draw calls. Nothing else on the tab changes. No pool, pad or AC (the `extras` group is hidden in `'sun'` mode).

**Files.** `web/src/scenes/home.js`, `views/panels.js`, `index.html`.

## 9. Optional scene 7: Powerwall health core (History → Powerwall patterns, only if the owner wants it; Q4)

This is [B], scoped honestly as A argued. The site's `live_status` omits `total_pack_energy`, so **no fade curve is possible**.

- **Measurable:**
  - round-trip efficiency = Σdischarge/Σcharge over 30 days from `S.daily` (expected ≈ 85–90% for PW2);
  - cycles/day;
  - days at 100% and reserve hits (already computed in `drawSocHeat`).
- **Scene:**
  - the two PW slabs from `geo/house.js` scaled ×3 as glass, with a liquid level replaying `S.gridDays.soc` (30 × 24) at 1 day/s;
  - a green strip trailing the 30-day SOC path, and the reserve line;
  - `.lbl3d` labels for RTE / cycles / days full.
- ≈ 2k triangles, 8 draw calls, 260 px, above the SOC heatmap.
- If the owner declines it, these numbers become `.kv` rows in the Powerwall patterns card instead. That is outside this topic.

## 10. Performance budget and phone layout (393 px; `.screen` padding 20, content 353 wide, canvases full-bleed with −16 px margins)

| Scene | Tab / card | Canvas | Triangles | Draw calls | Points | DPR phone/desktop | Shadows | Renders when |
|---|---|---|---|---|---|---|---|---|
| Twin (live/replay) | Now / Energy flow | 370 (unchanged) + 34 scrub + chips | ≈ 7k | ≈ 20 | 210 + rain | 1.5 / 2 | on demand, 1024² / 2048² | Now, pinned |
| 48 h road | Now / Next 48 hours | 260 | ≈ 2k | 8 | 0 | 1.5 / 2 | none | card in view |
| Sankey | History / new | 300 | ≈ 3k | ≈ 14 | 0 | 1.5 / 2 | none | card in view |
| Outage (night) | Insights → Home / new first | 330 | ≈ 9.5k | ≈ 25 | rain | 1.5 / 2 | none | card in view |
| Year ring | History / new | 330 | ≈ 13k | ≈ 7 | 0 | 1.5 / 2 | none | card in view |
| Roof veil + bars | Panels / Live roof | 300 (unchanged) | +0.4k | +2 (and −58 from instancing) | 0 | as roof | as roof | Panels |
| PW health (optional) | History / Powerwall patterns | 260 | ≈ 2k | 8 | 0 | 1.5 / 2 | none | card in view |
| Live contexts | | | | | | | | ≤ 6 (aurora, orb, Now twin, ≤ 3 cards) |

- Frame target 16.7 ms. No post-processing, no new addons: only `OrbitControls` and `CSS2DRenderer`, which are already bundled.
- New code is ≈ +45 kB raw / +14 kB gzip.
- **Build split (V8):**
  - `web/vite.config.js` gets `build.rollupOptions.output.manualChunks: { three: ['three'] }`, so app edits stop re-downloading three.js.
  - Off-Now scenes load through the host's dynamic `import()`: landscape, dayRing, pool/thermal twins, sankey, yearring, outage, pwhealth.
  - The service worker caches GETs network-first, so lazy chunks work offline after first use. A tab never opened before will not render its 3D while offline. That is accepted (decided, not asked).

## 11. Where each idea came from, and what was dropped

**Taken from B (base):**
- replay as a synthetic frame into `home.render()`;
- live framing kept pixel-identical, camera widens only while scrubbing;
- `extras` group hidden in `'sun'`;
- per-date cached `/api/appliances/day` instead of fattening `/api/day`;
- condenser collision fix and placeholder;
- `palette.js`, `flowline.js`, `geo/house.js`;
- on-demand shadow map (this removes A's shadows-vs-fps question);
- DPR drop while scrubbing;
- 48 h road geometry with SVG fallback;
- two-column Sankey layout and parallax camera;
- outage card on Insights → Home with night mode, 6-house neighbourhood, PEC pole, storm flash, toggles, `simulateIsland`, card-local preview;
- year rings with import;
- roof veil and expected-vs-actual bars;
- optional PW health;
- vendor chunk + lazy chunks.

**Grafted from A:**
- central host with a context cap, adaptive DPR and `stats()` for Data health;
- `--ac`/`--rest` tokens;
- HUD sentence and coverage honesty chips;
- 20 s idle return, keyboard scrubbing, dimmed no-data hours;
- POOL/AC labels linking to the approved twins;
- reserve tick on the PW fill;
- `week[]` pre-cool/coast window fields (V2a);
- marker text parity with `#fcTxt` and the 4-label cap;
- `/api/flows` as one SQL aggregate with the 7th edge (`battGrid`), residual and money;
- `poolKwhBetween`/`acKwhBetween` with provenance;
- outage load ladder, usable-kWh formula, 10 kW-at-once note, state chips and last-outage row;
- year-ring last-year ghost, full-battery ticks, √duration beads, grow-in, `showDay`;
- replay-any-day link (V10);
- clipping note (corrected to hourly means).

**Dropped:**
- **A's five framing pills, the Pool/AC framings and the AC cutaway inside the realistic house.** They duplicate the approved pool and thermal twins (mockups h and i), conflict with rule 3, and are the costliest part of A. The labels link to those twins instead.
- **A's Now changes:** canvas 370→400, the title change to "Your home · live", auto-switching the twin to an outage framing, and a new Now outage card that re-orders under `body.out`. All of these redesign an approved card (rule 3).
- **A's extension of `/api/day` with `pool[]`/`nest[]`.** `loadNow` polls `/api/day` every 30 s, so this adds 2 queries per poll per client. The History day view also calls it.
- **A's `Line2` addon.** It adds bundle bytes, and B's strips do the same job.
- **A's per-panel sunlight/self-shade heat map and roof scrubber.** All 30 panels are coplanar on one roof face, so cos(incidence) is identical across them. Self-shading by the hip roof is effectively nil, and real shade sources (trees, neighbours) are not modelled. The map would be uniform and could mislead. A scrubber on the roof would also duplicate the Now twin's and add to the "minimal roof".
- **A's 48-building lit neighbourhood.** B's six dark houses give the same contrast for fewer triangles.
- **A's condenser at z 2.5 m.** It misread thermaltwin's 0.28 scale.
- **B's `eco` field.** A public, unauthenticated endpoint would reveal when the house is empty. `mode`/`heatF` are kept.
- **B's JS `splitBucket()` over transferred rows (hourly beyond 31 days).** Replaced by A's single aggregate, which is cheaper on Neon and exact per 5-minute bucket.
- **B's DPR 1 in calm mode.** Calm is reduced motion, not low power.
- **B's "nothing new server-side" for the 48 h view.** Tomorrow's pre-cool window needs V2a.
- **Both candidates' `j-*` mockup names.** `mockups/j-ui-fixes.html` already exists, so the new mockups use k–q.
- **Both candidates' lazy-chunk and shadow questions.** Decided above instead of asked.
- **Thermal comfort tunnel.** Both candidates folded or dropped it: the approved AC comfort chart already answers it (rule 3).

**Out of scope, noted.** Everything under `/api` is unauthenticated in single-owner mode. The new GETs inherit that, which is why their payloads are minimal. Both Autopilots are `auto` on the live site, against rule 4. Neither is changed by this design.

## 12. Mockups for the orchestrator

Each mockup is in `mockups/`, links `../web/src/style.css`, and inlines its scene like `h-pool-twin.html`. The importmap is pinned to `three@0.186.1` from jsDelivr (the approved mockups use 0.160; the app uses 0.186.1). All data is synthetic, and each is checked at 393 px for overflow. No real price, loan, bill or payback figures.

| File | Must show |
|---|---|
| `k-home-twin.html` | Now Energy flow card: (1) live framing exactly as today, plus the pool/pad, condenser, PW fill strips, POOL/AC labels, the scrub row and chips; (2) replay at 2:35 PM in the widened framing with the HUD sentence, `(schedule)` tag and a `pool 62%` coverage chip; (3) night replay at 9 PM with the pump off and the AC cooling. |
| `l-forecast48.html` | Next 48 hours card: road lanes, night/cloud floor, reserve dash, full-by and lowest markers matching the unchanged sentence, pool (applied solid, tomorrow outlined) and pre-cool/coast gutter, a rain glyph, tap readout. |
| `m-flows.html` | History card for Day and Month: 7 ribbons, stacked Home (pool/AC/rest with provenance), a tapped ribbon readout with kWh, share and sample $, and the "unaccounted" fine print. |
| `n-outage.html` | Insights → Home first card: night house, dark neighbourhood, red wire, PEC pole, storm variant; toggles with the HUD; ladder `.kv`; state chips; last-outage row and 12-month strip. |
| `o-year-ring.html` | History "Your year": three rings, the partial last-year ghost with its note, full-battery ticks, outage beads, month labels, a tapped-day readout with "Open this day →". |
| `p-roof-veil.html` | Panels Live roof with the veil at a 55 dust score, hour bars chip off and on, the HUD line and the clipping note. |
| `q-pw-health.html` (only if Q4 = yes) | Powerwall patterns card with the health core. |

## 13. Build order (Phase 2, preview branch, about 5 items per batch, each verified on a preview URL at 393 px)

1. **Foundation + twin:** V0, V1a, V1b, V1c, V1d (mockup k).
2. **Contexts + forecast + flows data:** V9 (existing scenes onto the host before more contexts are added), V8, V2a, V2 (mockup l), V3a.
3. **Flows, outage, year:** V3b (mockup m), V4a, V4b, V4c (mockup n), V5 (mockup o).
4. **Roof and extras:** V6 (mockup p), V10, V3c (if Q3 = yes), V7 (if Q4 = yes).
