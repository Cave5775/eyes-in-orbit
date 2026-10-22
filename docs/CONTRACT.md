# EyesInOrbit — build contract (server <-> web)

Reference feeds: `spaceflight_live_data_streams_reference.md`.
`packages/core` (`@eio/core`) is the shared spine: read `packages/core/src/{types,feeds,frames,bodies,entity-graph,mission-fsm,ascent}.ts` before coding. Units: km, km/s, ms since epoch. Frames: `EARTH:inertial` (TEME) / `EARTH:fixed`. Keep changes to `packages/core` additive.

Environment notes: Windows, Git Bash/PowerShell, Node 24, npm workspaces (no pnpm). `npm install` of git-based deps is blocked, so no `lightstreamer-client-node`. Write source files with the Write tool (big bash heredocs break). Run tests with `npx vitest run` from the repo root. Dev server port **8787**, web dev port **5173** with Vite proxy `/api` and `/stream` -> `http://localhost:8787`.

## HTTP API (server, Fastify, gzip via @fastify/compress, CORS open on localhost)

| Route | Returns |
|---|---|
| `GET /api/health` | `{ serverTime, entityCount, connectors: ConnectorHealth[] }` |
| `GET /api/entities?since=<ms>&kind=&body=&q=&group=&limit=` | `{ serverTime, entities: EntityRecord[] }` — full records including `provider` spec. No filters = whole catalog (~12k, rely on gzip). `since` = only records with `updatedAt > since`. |
| `GET /api/entities/:id` | `EntityRecord` (404 if unknown) |
| `GET /api/search?q=&limit=20` | lightweight `{id,name,kind,group,aliases}[]` ranked: exact id/NORAD/COSPAR alias > name prefix > substring |
| `GET /api/launches` | `{ launches: Launch[] }` sorted by NET, includes recent past (~10) + upcoming |
| `GET /api/news?entity=<id>&q=<text>&limit=20` | `{ articles: Article[] }`; without params = latest global news; with entity/q = SNAPI `search=` (entity query = `links.newsQuery` or name), cached 10 min |
| `GET /api/dsn` | `DsnSnapshot` |
| `GET /api/iss` | `{ fix?: IssFix, telemetry: TelemetryPoint[] }` |
| `GET /api/bodies` | `Body[]` from `@eio/core` registry |

## WebSocket `/stream` (JSON `ServerMessage` / `ClientMessage` from `feeds.ts`)
Server sends `hello` on connect, then pushes: `entities.changed` (client then refetches `/api/entities?since=`), `launches`, `news`, `dsn`, `health`, and `iss.fix` (1 Hz) / `iss.telemetry` **only while at least one client has subscribed to topic `iss`**. Client topics: `iss` (others always pushed). Server pings; client auto-reconnects with backoff.

## Entity conventions (server produces, web consumes)
- Satellites: id `sat-<NORAD>`, `provider: {type:'sgp4', omm}`, `aliases: {norad, cospar}`, `group` in `stations|active|starlink`, kind `station` (ISS, Tiangong/CSS/Tianhe), `debris` (name contains DEB/R/B and ' DEB'), else `satellite`; `render.colorKey` = `station|starlink|satellite|debris`; ISS also gets `render.footprint: true, orbitLine: true, trailSeconds: 5400` and `links.streams` (NASA ISS HD Earth viewing / NASA TV YouTube embeds as `kind:'youtube'`—use known stable URLs like `https://www.youtube.com/watch?v=...` only if verified, otherwise `kind:'nasa-tv'` with `https://www.nasa.gov/nasalive`).
- Launches: id `launch-<ll2 id>`, kind `launch_vehicle`, `phase` from `deriveMissionState`, provider = `geodetic` at the pad until a trajectory file exists in `data/trajectories/` (then `composite`: pad before NET, `sampled` ascent in `EARTH:fixed` after), `links: {streams, newsQuery, launchId}`, attrs (provider, vehicle, orbit, pad, status). Re-derive phase every 15 s (emit `entities.changed` only when phase changes).
- DSN: ground station entities `dsn-goldstone|madrid|canberra` (kind `ground_station`, geodetic: Goldstone 35.4267,-116.8900; Madrid 40.4314,-4.2481; Canberra -35.4014,148.9817); spacecraft entities `dsn-<CODE>` (kind `probe`, `aliases.dsn=CODE`, positions from JPL Horizons geocentric vectors: sampled provider in `EARTH:inertial`, 30-min step over [now-1d, now+2d], refreshed every 12 h, cached in SQLite for 23 h; table of Horizons ids: VGR1 -31, VGR2 -32, JWST -170, M20 -168, MSL -76, MRO -74, ODY -53, MVN -202, NHPC -98, JNO -61, LRO -85, PSP -96, TGO -143, MEX -41, LUCY -49, PSYC -255, EURC -159, SOLO -144, BEPI -121, STA, SOHO, TESS, CHDR; full list in `apps/server/src/connectors/dsn-targets.ts`). Link DSN activity to entities via `attrs` (rangeKm, rtltSec, dataRate, dish).
- Demo (extensibility proof, always on, id prefix `demo-`): a Falcon-9-style booster `demo-booster` as a `composite` (ascent sampled -> `relative` ENU landing arc -> `geodetic` landed on a pad), a `demo-drone` using `relative` (ENU orbit around `demo-booster`'s landing pad), and `demo-rover` on MARS (`geodetic` on `MARS:fixed`, body `MARS`) tagged `group: 'demo'`. Loop their timeline relative to server start so something is always in motion.

## Web architecture
Vite + React 18 + zustand + three.js (r170) raw `SceneController` (not r3f). `satellite.js` v6 propagation in a Web Worker writing a transferable `Float32Array` of ECI positions (km) at ~30 Hz for every `sgp4` entity; other providers via `EntityGraph` on the main thread. Render in Earth-inertial; rotate the Earth mesh by `gmstRad`, sun light from `sunDirectionEci`. Deep-space probes (|r| > ~2e6 km) drawn at a compressed shell radius (direction preserved, log-scaled radius) and flagged in the UI. Live stream iframe lives in a `React.memo` panel keyed only by URL. Offline-capable: procedural Earth when `public/textures/earth.jpg` is missing.
