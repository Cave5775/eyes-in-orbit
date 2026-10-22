# EyesInOrbit

Local space mission control. A Node aggregator polls public spaceflight feeds (CelesTrak, Launch Library 2, Spaceflight News, NASA DSN, ISS, JPL Horizons), caches them in SQLite, and streams a unified model to a three.js web client where any tracked object can be watched live alongside its launch info, livestream, news, and telemetry.

See `spaceflight_live_data_streams_reference.md` for the feeds and `docs/CONTRACT.md` for the server/web API.

## Run

```
npm install
npm run assets     # optional: downloads an Earth texture (procedural Earth is used without it)
npm run dev        # server on :8787, web on :5173
npm test
```

Copy `.env.example` to `.env` to set `LL2_TOKEN` (higher Launch Library rate limit) or `OFFLINE=1`.

## Layout

| Path | Purpose |
|---|---|
| `packages/core` | Body-agnostic model: bodies and frames, state providers (SGP4, sampled, Keplerian, geodetic, relative, composite), mission state machine, clock, entity graph |
| `apps/server` | Connectors, scheduler, SQLite cache, REST + WebSocket API |
| `apps/web` | React UI, three.js scene, SGP4 Web Worker |

## Extending

- **New entity kind** (rover, drone, lander): emit an `EntityRecord` with any `kind` and a provider spec. The web client picks a glyph from `render`; no core change needed.
- **Entity that changes phase** (a landing booster): use a `composite` provider that chains `sampled` ascent, `relative` landing arc and `geodetic` landed segments.
- **New body**: register a `Body` in `packages/core/src/bodies.ts` (radius, flattening, GM, rotation, orbit). Frames `<BODY>:inertial|fixed` and conversions then work for it.
- **New data feed**: implement `Connector` in `apps/server/src/connectors/` and register it in `main.ts`.

## Feed status

Launch Library 2, CelesTrak, Spaceflight News, DSN, Horizons and wheretheiss.at are wired. Space-Track, SatNOGS, NOTAM zones and webcast OCR are stubs. Flight Club has no stable public API, so trajectories are imported from files in `data/trajectories/`.
