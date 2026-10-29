# EyesInOrbit

A local mission control for spaceflight. It pulls public feeds (satellite orbits, upcoming launches, the Deep Space Network, the ISS, space news), keeps them in a small database on your machine, and shows everything on an interactive 3D globe.

<!-- Add a screenshot here: ![EyesInOrbit](docs/screenshot.png) -->

## What you can do

- **Explore the sky**: thousands of satellites, stations, debris, launch pads and deep-space probes, drawn to true scale around the Earth, Moon, Sun and Mars.
- **Search and filter**: type a name or ID, or use tags like `group:starlink` or `type:debris`. Hide or highlight whole groups.
- **Follow anything**: click an object to see its telemetry, launch info, livestream and news, and let the camera follow it.
- **Watch launches**: a launch board with live countdowns, and modeled ascent paths for Falcon 9 and Electron.
- **Control time**: live, pause, rewind, speed up to x600, or jump to any offset from now.
- **Track the ISS**: live position and solar array angles on a 3D model.
- **Work offline**: cached data keeps working without a network, and `?mock=1` runs the app on synthetic data.

## Quick start

You need **Node 24**.

```
npm install
npm run assets     # optional: downloads Earth, Moon and Mars maps
npm run dev        # server on :8787, web on :5173
```

Open <http://localhost:5173>. Run the tests with `npm test`.

## Basic controls

| Input | Action |
|---|---|
| Left drag / wheel | Orbit / zoom |
| Right drag | Pan |
| Click | Select an object (an orbiter of another body, like MRO round Mars or LRO round the Moon, is a satellite of that body and is framed from it; an object with no position now shows its parent or primary body) |
| `F` | Frame the selection |
| `S` | Toggle the surface-aligned view |
| `Esc` | Deselect and return to Earth view |
| `H` or `?` | Show all controls in the app |

## Where the data comes from

[CelesTrak](https://celestrak.org) (satellite orbits), [Launch Library 2](https://thespacedevs.com/llapi) (launches), [Spaceflight News](https://www.spaceflightnewsapi.net), NASA DSN Now, [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) (probes, and the positions of the planets, dwarf planets and major moons, with an analytic fallback offline) and [wheretheiss.at](https://wheretheiss.at) plus the ISS Lightstreamer feed (ISS). If CelesTrak is blocked on your network, see the troubleshooting section of the [reference](docs/reference.md#celestrak-blocked-or-unreachable).

## How it is organised

An npm workspaces monorepo:

- `packages/core`: shared model (bodies, frames, orbit providers, the clock).
- `apps/server`: Node aggregator that polls the feeds, caches them in SQLite and serves REST and WebSocket.
- `apps/web`: React and three.js client.

## More documentation

- [Reference](docs/reference.md): every feature, control, setting, data source and known issue in detail.
- [API contract](docs/CONTRACT.md): REST and WebSocket routes and entity conventions.
- [Frames of reference](docs/frames.md): how the frame, lock and orbit-line rules work.

## Credits

Earth imagery: NASA Blue Marble and NASA GIBS. Moon: three.js example texture from NASA LRO imagery. Mars: USGS Astrogeology / NASA Viking MDIM 2.1. Maps are downloaded by `npm run assets` and not committed.
