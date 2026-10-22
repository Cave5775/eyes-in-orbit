# EyesInOrbit

Local space mission control. A Node aggregator polls public spaceflight feeds (CelesTrak, Launch Library 2, Spaceflight News, NASA DSN, JPL Horizons, wheretheiss.at, ISS Lightstreamer), caches them in SQLite, and streams one unified entity model to a three.js web client. Any tracked object can be watched live on the globe alongside its launch info, livestream, news and telemetry.

Monorepo (npm workspaces): `packages/core` (`@eio/core`, shared model), `apps/server` (`@eio/server`), `apps/web` (`@eio/web`).

## Features

- **Globe and tracking**: three.js scene with Earth, atmosphere, star field and terminator lighting. Thousands of satellites (SGP4 propagated in a Web Worker), stations, debris, launch pads, DSN ground stations and deep-space probes. Hover for a name tooltip, click to select, FOLLOW keeps the camera on the selection, EARTH VIEW / Esc resets. The Earth hides everything behind it (stars, satellites, paths, deep-space markers); picking ignores hidden points too.
- **Camera** (see [Controls](#controls)): altitude-aware zoom, a surface-aligned view (level horizon, north-up) around the selection's sub-point or any ground point, and FIT / FIT VISIBLE that frame the selection with its related objects or everything the filters leave on screen.
- **Trajectory paths**: select an object that is not SGP4 and its path is drawn: demo booster (ascent and landing arc), launch vehicles with trajectory files, relative objects (the demo drone), Keplerian objects and Horizons-sampled probes. Past is dim, future is bright, the current position is the selection ring, and composite phase boundaries (pad, ascent, landing, landed) get a tick and a label. Windows: probes -1 d to +2 d, trajectories -5 min to +10 min, relative objects +/-3 min, Keplerian -1/4 to +1 period. The HUD shows the window. SGP4 objects keep their orbit line, trail and ground track.
- **Search and filter**: debounced search by name, NORAD id or COSPAR id (server-ranked via `/api/search`, local ranking if the request fails), kind and group filter chips with counts, virtualised entity list. Filters also hide non-matching objects in the scene.
- **Launch filter**: a searchable list of launch groups (objects that share a launch, derived from the COSPAR designator `YYYY-NNN`, only groups with 2 or more members, largest first; type `2251`, `cosmos` or `1993-036`). Selecting one filters the entity list and the globe. SHOW ONLY hides everything else, HIGHLIGHT dims it; members are drawn larger. A chip shows the active group and clears it. Selecting a group also calls `runtime.onFitRequest?.(ids)` so the camera can frame the members once a fit handler is installed (none is wired yet). Example: pick COSMOS 2251 to see its debris cloud at once.
- **Detail panel** with tabs:
  - Telemetry: lat/lon/altitude, geocentric range, speed, period, phase, element age, confidence, attributes, identifiers; ISS live fix and telemetry; the current DSN link for DSN-tracked probes.
  - Launch (launch entities only): countdown, status, phase, window, provider, vehicle, mission, pad, and for Falcon 9 an [ascent telemetry](#ascent-telemetry) section (modeled or measured altitude, speed and downrange charts, event timeline).
  - Stream (when the entity or its launch has streams): YouTube links are embedded; NASA TV, X and other links open in a new tab. POP OUT floats a YouTube stream above the app (up to 3 windows; drag the title bar, resize from the corner at 16:9, DOCK returns it to the tab; positions are remembered). Hover a player for PLAY, PAUSE, MUTE and UNMUTE; the embeds hide what YouTube's parameters allow (see `apps/web/src/lib/youtube.ts`).
  - News: Spaceflight News articles for the object (`links.newsQuery` or name), or all spaceflight.
- **Launch board**: upcoming launches (plus the last 2 hours) with live countdowns, LL2 status and derived mission phase. Click a card to select the launch entity or fly to its pad.
- **DSN panel**: dishes with active links first, craft chips that select the spacecraft, range, round-trip light time, downlink band and rate.
- **News ticker**: scrolling global headlines, pauses on hover.
- **Time controls**: LIVE, PAUSE/PLAY, rates x1/x10/x60/x600, and a scrub slider covering +/- 24 h around now. All providers are evaluated at the simulation clock.
- **Deep-space shell compression**: objects beyond 2,000,000 km from Earth (e.g. Voyager 1 at ~2.5e10 km) are drawn on a logarithmically compressed shell with direction preserved, and so are their paths. The HUD flags this ("distance not to scale"). Over a 3-day window a far probe's path is a few pixels at most (Voyager 1's is effectively a point); zoom in to see it.
- **ISS**: while the ISS is selected the client subscribes to the `iss` WebSocket topic and the server starts a 1 Hz wheretheiss.at fix (lat/lon/alt/velocity/visibility/footprint) and a Lightstreamer telemetry feed. Both connectors are idle otherwise.
- **Demo entities** (always on, group `demo`): `demo-booster` (looping pad, ascent, relative-ENU landing burn, landed; 10 minute cycle from server start), `demo-drone` (orbits the landing zone), `demo-rover` (Jezero crater on MARS), plus `demo-pad` and `demo-lz`. They exercise the composite, relative and non-Earth geodetic providers.
- **Health indicator**: top-right connection state (link up, reconnecting, offline, mock) and a per-connector popover with status, age, cache use and errors.
- **Offline behaviour**: `OFFLINE=1` serves only what the SQLite cache holds. Without `apps/web/public/textures/earth.jpg` the globe uses a procedural Earth (the HUD shows `EARTH PROCEDURAL`).
- **Mock mode**: add `?mock=1` to the web URL to run entirely on synthetic in-memory data (also used automatically when `/api/health` is unreachable). `?mock=1&n=12000` sets the number of mock satellites (default 2000) for stress tests.

## Controls

| Input | Action |
|---|---|
| Left drag | Orbit (surface view: look around the local horizon) |
| Right drag, Shift + drag | Pan (globe view only) |
| Wheel, pinch | Zoom. The step scales with the camera's height above the surface: fine near the ground, coarse in deep space. The camera stops 3 km above the ground (the Earth has no terrain), at most 30,000,000 km out |
| Click | Select an object (hover shows its name) |
| FOLLOW | Keep the camera on the selection |
| `F` or FIT | Frame the selection and its related objects (bounding sphere, distance from the field of view, smooth fly-to): its `parentId` parent and children, relative-provider parents, a launch vehicle's pad, pads near a composite's launch point, the probes a DSN ground station is linked to; the selected object's drawn path is included |
| `Shift+F` or FIT VISIBLE | Frame everything the current filters leave visible |
| `S` or SURFACE | Toggle the surface-aligned view: the camera orbits a ground point (the selected object's sub-point while following, a focused launch pad, otherwise the point under the view centre) with the local vertical up and north-up. The Earth hides the stars below the horizon. Leaving flies back to the globe view of the same place |
| `Esc` or EARTH VIEW | Deselect and return to the Earth view (also leaves the surface view) |
| `H`, `?` | Show or hide the in-app controls help |

Hotkeys are ignored while typing in an input. Code can frame a set of entities with `runtime.onFitRequest?.(ids)` from `apps/web/src/state/runtime.ts` (set by `SceneView` while mounted).

## Quick start

Requires **Node 24** (the SQLite cache uses the built-in `node:sqlite`).

```
npm install
npm run assets     # optional: downloads an Earth texture (procedural Earth is used without it)
npm run dev        # server on :8787, web on :5173
npm test           # vitest, all workspaces
```

Open http://localhost:5173. The Vite dev server proxies `/api` and `/stream` to `localhost:8787` (hard-coded in `apps/web/vite.config.ts`; edit it if you change `PORT`).

Other scripts: `npm run build` (production build of the web app into `apps/web/dist`; the server does not serve it), `npm run typecheck`, `npm run start -w @eio/server` (server without file watching).

## Configuration

All variables are optional. Copy `.env.example` to `.env` (git-ignored, read from the repo root or cwd; already-set environment variables win).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP and WebSocket port |
| `HOST` | `localhost` | Bind address (loopback only by default) |
| `LL2_TOKEN` | unset | Launch Library 2 token; raises the ~15 requests/hour anonymous limit |
| `LL2_BASE` | `https://ll.thespacedevs.com/2.2.0` | LL2 base URL |
| `DATA_DIR` | `<repo>/data` | Location of `cache.sqlite` and `trajectories/` |
| `OFFLINE` | `0` | `1` (or `true`) disables all network access; connectors serve the cache |
| `DSN_URL` | NASA Eyes `dsn.xml` URLs | Comma-separated DSN Now XML candidates, tried in order |
| `SPACETRACK_USER`, `SPACETRACK_PASSWORD` | unset | Stub only: changes the connector's reported note |
| `SATNOGS_TOKEN` | unset | Stub only: changes the reported note |
| `WEBCAST_URL` | unset | Stub only: changes the reported note |

## Data sources

| Connector id | Source | Cadence | Feeds | Status |
|---|---|---|---|---|
| `celestrak` | CelesTrak GP JSON (`stations`, `starlink`, `active`, debris clouds `cosmos-2251-debris`, `iridium-33-debris`, `fengyun-1c-debris`) | every 3 h (cache TTL 3 h per group; retry 30 min after a partial failure) | `sat-<NORAD>` SGP4 entities; debris-cloud objects get kind `debris` and `group` = the CelesTrak group | wired; see Known issues |
| `launchlibrary` | Launch Library 2 (upcoming 15, previous 10) | every 10 min; phases re-derived every 15 s | launch board, `launch-<id>` entities | wired |
| `snapi` | Spaceflight News API v4 | every 5 min; per-query search cached 10 min | ticker, News tab | wired |
| `dsn` | NASA DSN Now XML | every 5 s | DSN panel, ground stations, probe link attrs | wired |
| `horizons` | JPL Horizons vectors (geocentric, 30 min steps, -1 d to +2 d) | every 12 h (cache TTL 23 h), requests spaced 1.5 s | positions of `dsn-<CODE>` probes (23 targets in `dsn-targets.ts`) | wired; some targets lack ephemerides |
| `iss-rest` | wheretheiss.at | 1 Hz, only while topic `iss` has subscribers | ISS live fix | wired |
| `iss-live` | Lightstreamer ISSLIVE over WebSocket | reconnect every 5 s, only while topic `iss` has subscribers | ISS telemetry points | wired, labels unverified |
| `flightclub` | local files in `data/trajectories/` | rescanned every 30 s, no network | ascent trajectories for launches | wired (file import; Flight Club has no stable public API) |
| `ascent model` (in `launchlibrary` / core) | parametric nominal Falcon 9 ascent (`packages/core/src/ascent-model.ts`) | recomputed with each launch sync, no network | modeled ascent path, `events` and `trajectorySource: 'modeled'` for every Falcon 9 launch without a trajectory file | wired, MODELED (not measured) |
| `POST /api/telemetry/:launchId` | rows posted by a script or by hand | on demand, localhost only | measured ascent series, replaces the modeled path (`trajectorySource: 'live'`) | wired; see [Ascent telemetry](#ascent-telemetry) |
| `demo` | generated | every 20 min | demo entities | wired, no network |
| `spacetrack` | Space-Track SATCAT/GP | none | none | stub |
| `satnogs` | SatNOGS observations | none | none | stub |
| `notam` | FAA NOTAM / NGA NAVAREA hazard areas | none | none | stub |
| `webcast-ocr` | OCR of webcast T+/altitude overlay | none | none | stub (no OCR; a script can already feed `POST /api/telemetry/:launchId`) |

Stubs report status `stub` in `/api/health` and never run. Feed background lives in `spaceflight_live_data_streams_reference.md`.

## API

REST under `/api` (health, entities, entity by id, search, launches, news, dsn, iss, bodies, telemetry) and a JSON WebSocket at `/stream` that pushes `entities.changed`, `launches`, `news`, `dsn`, `health` and, for subscribers of the `iss` topic, `iss.fix` and `iss.telemetry`. Routes, query parameters, message types and entity conventions are specified in [`docs/CONTRACT.md`](docs/CONTRACT.md); shared types are in `packages/core/src/{types,feeds}.ts`.

## Trajectory files

Drop ascent profiles into `data/trajectories/` as `*.json` or `*.csv`. The server rescans every 30 s; a matching launch becomes a `composite` entity (geodetic at the pad until NET, then a `sampled` ascent in `EARTH:fixed`). Files with errors are skipped and reported in the `flightclub` connector note. `*.local.*` files are git-ignored. A working example is `data/trajectories/example.json` (illustrative, matches no real launch).

JSON:

```json
{
  "id": "my-ascent",
  "source": "free text",
  "azimuthDeg": 90,
  "match": { "launchId": "<LL2 launch uuid>", "nameContains": "Starlink" },
  "rows": [
    { "tSec": 0,  "altKm": 0,  "speedKmS": 0.0 },
    { "tSec": 60, "altKm": 9,  "speedKmS": 0.45 }
  ]
}
```

CSV: `# key: value` comment lines (`id`, `source`, `azimuthDeg`, `launchId`, `nameContains`), then a header `tSec,altKm,speedKmS[,downrangeKm]` and one row per sample.

Rules (see the format comment at the top of `apps/server/src/trajectory.ts`):
- `match` needs `launchId` (exact LL2 id) or `nameContains` (case-insensitive substring of the launch name); `launchId` is tried first.
- At least 2 rows; `tSec` is seconds since liftoff, anchored at the launch NET.
- Every row needs either `downrangeKm`, or `speedKmS` (downrange is then integrated from speed and altitude rate).
- `azimuthDeg` defaults to 90 (due east).

## Ascent telemetry

Launch entities of **Falcon 9** launches (not Falcon Heavy) get an ascent path and an event timeline even though no open ascent telemetry exists (reference doc, section 2). Three sources, in order of precedence, reported as `attrs.trajectorySource`:

| `trajectorySource` | What it is | Measured? |
|---|---|---|
| `live` | rows posted to `POST /api/telemetry/:launchId` | yes, as accurate as whoever posts them |
| `file` | a file in `data/trajectories/` (Flight Club export, hand-made) | no |
| `modeled` | the parametric nominal ascent in `packages/core/src/ascent-model.ts` | **no, a model** |

**Modeled ascent.** Built from typical Falcon 9 / Starlink webcast figures: max-Q at about T+1:10 (12 km, 0.42 km/s), MECO at about T+2:30 (68 km, 2.3 km/s Earth-relative), stage separation 3 s and second-stage ignition 8 s after MECO, fairing at T+3:30, SECO-1 at about T+8:30 (165 km, about 7.6 km/s), booster entry burn, landing burn and touchdown (droneship about T+8:20, RTLS about T+7:45; the recovery plan comes from LL2 `launcher_stage[0].landing`). The launch azimuth follows from the target inclination and pad latitude (`sin Az = cos i / cos lat`, southward branch for Vandenberg, corrected for the Earth's rotation); the inclination comes from the launch description, a per-Starlink-group table (group 15 is the 70 degree shell) or a per-orbit and per-site default, and the used value is shown in the Launch tab. Downrange is integrated from speed and altitude rate with `reconstructDownrange`. After SECO the state is held for 10 minutes (a placeholder; the real orbit rises towards apogee), then the entity returns to the pad marker. Real flights differ by tens of seconds and a few percent. Everything in the UI is labelled MODELED until real rows arrive.

**Ingest.** Send measured rows (for example from a webcast OCR script or typed by hand):

```
curl -X POST http://localhost:8787/api/telemetry/<LL2 launch id> -H "content-type: application/json" -d '[
  {"tSec": 0,  "altKm": 0,    "speedKmS": 0},
  {"tSec": 60, "altKm": 8.4,  "speedKmS": 0.38},
  {"tSec": 120,"altKm": 38.0, "speedKmS": 1.25}
]'
```

`tSec` is seconds since liftoff (T+0 is the launch NET), `altKm` kilometres, `speedKmS` the Earth-relative speed in km/s (convert km/h by dividing by 3600). Rows are validated (finite numbers, `tSec` 0..7200, `altKm` -0.5..2000, `speedKmS` 0..15, at most 2000 rows per request, 7200 stored) and merged by `tSec`, so a script can post a row or a batch every second; add `"replace": true` to start over. The object form `{"rows": [...], "events": [{"name": "MECO", "tSec": 151}], "azimuthDeg": 158, "source": "webcast OCR", "replace": false}` also reports events (names `A-Z0-9_`, e.g. `MECO`, `SECO`, `STAGE_SEP`, `LANDING`; they replace the modeled time of the same name) and an azimuth (default: the modeled one). Downrange is integrated from the rows; the path is measured up to the last row and then follows the modeled shape re-anchored at the last measured point (reported as `liveExtrapolatedFromSec` and a lower sample `confidence`), or holds the last fix when the launch has no model. The call answers with `{ok, source, rows, lastTSec, extrapolatedFromSec}` and the server pushes `entities.changed`. `DELETE /api/telemetry/:launchId` clears the series. Posting and deleting are accepted from localhost sockets only (and only without a foreign `Origin`); rows are kept in memory and in the SQLite cache (7 days) so they survive a restart. `GET /api/telemetry/:launchId` returns `{launchId, entityId, liftoffMs, source, modeled, file, live}` (the modeled series with events and phases next to the posted rows).

**UI.** The Launch tab ends with an ASCENT TELEMETRY section: altitude, speed and downrange charts against T+ (modeled dashed once measured rows exist, measured solid), a cursor that follows the simulation clock (scrub, pause, rate), event markers (MAX-Q, MECO, SEP, SES, FAIRING, SECO and the booster ENTRY, LAND BURN, LANDING) with the current phase highlighted, readouts at the cursor, an events table and a data table. Before liftoff it shows the countdown and the nominal MAX-Q, MECO and SECO values. On the globe the same path is drawn by the usual path overlay with phase labels (stage 1 ascent, staging, stage 2 burn, orbit (held)). Try it offline with `?mock=1` (a Starlink Group 15-15 launch from Vandenberg about 40 minutes ahead): scrub to its NET plus 4 minutes.

**Limits.** There is no OCR here (the `webcast-ocr` connector stays a stub). The model knows nothing about the actual payload mass, trajectory shaping or weather, its inclination for a given mission can be wrong when the provider data does not state it, and non-Falcon vehicles have no modeled ascent (they stay at the pad unless a trajectory file or posted rows exist). A launch id that LL2 no longer lists (older than the previous-10 window) cannot receive rows.

## Architecture

```
connectors -> Hub (EntityGraph + launches/news/dsn/iss state) -> REST + WebSocket -> web store -> scene / panels
     |
  SQLite kv cache (TTL, stale fallback)
```

- **Server** (`apps/server/src`): Fastify with `@fastify/compress`, `@fastify/cors` and `@fastify/websocket`. `main.ts` builds the connector list and the `Scheduler` (`connector.ts`): jittered starts, per-connector timers, exponential backoff, topic gating, health records. `http.ts` is the fetch layer (`cachedFetch`: fresh cache hit, else network, else stale cache). `store.ts` is the SQLite key/value cache (entries expired for more than 30 days are pruned at startup). `hub.ts` holds shared state and debounces `entities.changed` (250 ms).
- **Core** (`packages/core/src`): body-agnostic. Bodies (`SUN`, `EARTH`, `MOON`, `MARS`) and frames `<BODY>:inertial|fixed`, state providers (`sgp4`, `sampled`, `keplerian`, `geodetic`, `relative`, `composite`), the `EntityGraph` that resolves parents and converts frames, the mission state machine (`deriveMissionState`), the simulation `Clock`, and ascent helpers. Units are km, km/s and ms since epoch.
- **Web** (`apps/web/src`): React 18 + zustand store (`state/store.ts`). The raw three.js `SceneController` (`scene/`) is not wrapped in r3f. SGP4 entities propagate in `workers/propagator.worker.ts` into a transferable `Float32Array`; other providers are evaluated on the main thread through an `EntityGraph` (`state/runtime.ts`). `api/client.ts` chooses the REST client or the mock API (`mock/`).
- **Paths and frames**: `lib/paths.ts` samples `provider.stateAt` over a window (<= ~480 points plus exact composite phase boundaries, buffers reused, rebuilt only when the window has slid a tenth of its length). Everything is drawn in the Earth-inertial scene, with one exception: when every sample is natively `EARTH:fixed` and the window is <= 45 min (the booster, launch ascents) the path is attached to the rotating Earth group instead, so a booster standing on its landing pad does not draw a 460 m/s eastward streak; the marker, evaluated at the current time, still sits on it. Inertial points get the deep-space shell compression.
- **Draw order and depth**: Earth, atmosphere, satellite points, paths and stars are all depth tested. Stars are pinned to the far plane (depth just under 1.0), so the opaque Earth occludes them, and everything else drawn in front of the far plane occludes them in turn.

## Extending

- **New data feed**: add a file in `apps/server/src/connectors/` exporting a `Connector` (`id`, optional `intervalMs`, `startDelayMs`, `topic`, `network: false`, `start`, `run`, `stop`, or `stub`). Use `ctx.cachedFetch(key, url, ttlMs, parse)` for network access and `ctx.hub.upsert(...)` / `hub.setLaunches` / `hub.setDsn` etc. to publish. Add it to the `CONNECTORS` array in `apps/server/src/main.ts`. Throw from `run` to report an error and back off; call `ctx.softFail(msg, retryMs)` for a partial failure.
- **New entity kind** (rover, drone, lander): emit an `EntityRecord` with any `kind` string and a provider spec; no core change is needed. Optional `render` hints set `glyph` (`dot|diamond|ring|triangle|square`), `colorKey`, `trailSeconds`, `footprint`, `orbitLine` and `label`. For a colour that does not exist yet, extend `colorKey` in `packages/core/src/types.ts`, then `KIND_COLOR` in `apps/web/src/lib/entity.ts`, `POINT_SIZE`/`FALLBACK` in `apps/web/src/scene/palette.ts` and a `--c-<key>` variable in `apps/web/src/styles.css`.
- **Entity that changes phase** (a landing booster): use a `composite` provider chaining `sampled` ascent, `relative` landing arc and `geodetic` landed segments. `apps/server/src/connectors/demo.ts` is a complete example.
- **New body**: define a `Body` (radius, flattening, GM, rotation, approximate orbit around its parent) in `packages/core/src/bodies.ts` and add it to the default list in `BodyRegistry`'s constructor (or call `defaultBodies.register`). Frames `<BODY>:inertial|fixed` and conversions then work for it, and `/api/bodies` lists it. The top bar's body tabs are static, so a new body also needs UI work to be viewable.
- **New state provider**: add its spec to the `ProviderSpec` union in `packages/core/src/types.ts`, implement `StateProvider` (`stateAt`, `toSpec`) in `packages/core/src/providers/`, then add a `case` in `providerFromSpec` and an export in `providers/index.ts`. Server and web both rebuild providers through that function.

## Testing

`npm test` runs Vitest (268 tests in 22 files, no network; includes the ascent model, the telemetry ingest and the chart helpers). Server tests use recorded fixtures in `apps/server/test/fixtures/` (CelesTrak incl. debris groups, Horizons, LL2, SNAPI, DSN). Coverage: core model and ascent (`packages/core/test`), connector parsers, cache behaviour, scheduler backoff and API routes (`apps/server/test`), filters and launch groups, deep-space compression, camera maths (zoom, fit, local frames), path sampling and related-object lookup, YouTube URL handling, the mock API, value formatting and panel layout logic (`apps/web/test`). The three.js scene itself is checked by hand in a browser. `npm run typecheck` checks all three packages.

## Project layout

| Path | Purpose |
|---|---|
| `packages/core/src` | `types`, `bodies`, `frames`, `launch-group`, `kepler`, `ephemeris`, `clock`, `mission-fsm`, `entity-graph`, `ascent`, `ascent-model`, `feeds` (wire types), `providers/` |
| `apps/server/src` | `main`, `config`, `connector` (scheduler), `http`, `store`, `hub`, `api`, `ws`, `search`, `trajectory`, `telemetry` (ascent ingest and source selection), `connectors/` |
| `apps/web/src` | `App.tsx`, `ui/` (panels, `Splitter`, `ui/detail/` tabs), `scene/` (three.js: `SceneController`, `controls` camera rig, `PathOverlay`, `overlays`, `materials`), `workers/`, `state/`, `api/`, `lib/` (formatting, filters and launch groups, deep-space, `camera`, `paths`, `related`), `mock/` |
| `data/` | `cache.sqlite` (git-ignored) and `trajectories/` |
| `docs/CONTRACT.md` | Server/web API contract |
| `scripts/fetch-assets.mjs` | Earth texture download (`npm run assets`) |
| `spaceflight_live_data_streams_reference.md` | Feed reference |
| `plans.md` | Owner's test notes and roadmap checklist |

## Layout

- **Resizing**: drag the borders between the entity list and the globe, the globe and the detail panel, the globe and the bottom row, and the launch board and the DSN panel. Double-click a border (or press Enter on it) to reset it to its default. Borders are keyboard focusable: arrow keys move by 16 px (Shift: 64 px), Home/End jump to the minimum/maximum. Sizes are clamped (the globe always keeps at least 360 x 200 px) and re-clamped when the window shrinks.
- **Persistence**: sizes are stored in `localStorage` under `eio.layout.v1` (per browser; a default size is simply not stored). If storage is unavailable the layout works but is not remembered. At 820 px and narrower the page stacks vertically and the borders are hidden.
- **Implementation**: sizes are CSS variables (`--left-w`, `--right-w`, `--bottom-h`, `--dsn-w`) on `.app` set by `ui/ResizableLayout.tsx`; `ui/Splitter.tsx` is the reusable pointer-capture splitter; pure clamp and persistence logic is in `lib/layout.ts`. The three.js canvas follows through the `ResizeObserver` in `SceneController`.
- **Displayed values**: all number formatting goes through `lib/format.ts` with fixed decimals per unit (lat/lon 3, altitude 1, distances by unit band (km, Mkm, AU), speed 3 km/s or 0 km/h, period in minutes 1, light time 1 s, data rates scaled to b/s, kb/s, Mb/s, Gb/s). Server `attrs` are formatted by key (`rangeKm`, `rtltSec`, `dataRateBps`, ...) and any other long decimal inside attribute or telemetry text is rounded to 3 decimals. Numeric cells use tabular digits and stay on one line (ellipsis when too narrow); only ids and URLs may break anywhere.

## Known issues

- **CelesTrak 403**: CelesTrak answers HTTP 403 to repeated downloads of unchanged groups. The server caches each group for 3 h and retries failed groups every 30 min, so on a cold start `active` and/or `starlink` may be missing for a while and only stations load. The connector reports `partial: ...` in its health note. The debris groups (`cosmos-2251-debris`, `iridium-33-debris`, `fengyun-1c-debris`) are fetched after the main three and were only tested against recorded fixtures: while CelesTrak blocks this machine they are missing, so the launch filter then has no live debris groups (it still groups any objects that share a COSPAR launch id, e.g. Starlink batches). `cosmos-1408-debris` is not offered because CelesTrak's index page does not list that group.
- **Launch groups**: derived only from the COSPAR designator, so objects without one (launches, probes, ground stations, demo entities) are never in a group, and launch groups are not linked to Launch Library 2 `launch-<id>` entities (LL2 carries no COSPAR id). A group is labelled by its `A` piece, else the most common name; Starlink batches therefore show the name of one satellite. The scene fit on selection needs a handler on `runtime.onFitRequest`; until one is installed the camera does not move.
- **Horizons ephemerides**: Horizons has no ephemeris for M20 (Mars 2020) and MAVEN, so those probes have no position. The connector logs them as failed targets and retries hourly.
- **ISS telemetry labels**: the Lightstreamer item ids (`USLAB000032`, `USLAB000033`, `S0000001`-`S0000004`) and their labels come from the reference document and are unverified; live values of `USLAB000032/33` do not look like geodetic position and velocity. Treat the ISS telemetry table as raw data. The wheretheiss.at fix is the trustworthy source.
- **`npm audit`**: reports advisories in dev tooling only (Vite 5, Vitest 2). Upgrading means major versions and is deferred.
- **Stub connectors**: Space-Track, SatNOGS, NOTAM and webcast OCR do nothing yet.
- **Moon and Mars views**: the MOON and MARS tabs in the top bar are disabled. Entities on other bodies (the demo rover) are positioned through the approximate body ephemeris and drawn on the Earth-centred scene.

## Known limitations / roadmap

Implemented from `plans.md`: the two UI/UX requests (stable value layout, resizable panels), the launch filter, the camera controls, the Earth occluding the stars and trajectories for non-SGP4 objects. Performance was reported fine, including with `?mock=1`. Still open: realistic distance projection and not rendering objects outside the focus object's scope. The scene has no terrain and the downloaded Earth texture is low resolution, so the closest views (3 km up) are blurry. Paths show the provider's own samples: a probe whose Horizons data is missing (M20, MAVEN) has none, and Voyager-class paths are sub-pixel at shell scale.
