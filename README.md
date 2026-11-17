# EyesInOrbit

A local mission control for spaceflight. It pulls public feeds (satellite orbits, upcoming launches, the Deep Space Network, the ISS, planet and probe ephemerides, Mars rover positions from NASA, space news), keeps them in a small database on your machine, and shows everything in an interactive 3D scene of the solar system, drawn to true scale.

<img width="2255" height="1275" alt="image" src="https://github.com/user-attachments/assets/1d3312c5-b37e-4569-99ee-27c462c0ca5e" />

## What you can do

- **Explore the sky**: thousands of satellites, stations, debris, launch pads and deep-space probes around the Earth, plus the Sun, the planets, the dwarf planets and their major moons, all at their real positions and sizes.
- **Search and filter**: type a name or ID, or use tags like `group:starlink` or `type:debris`. Hide or highlight whole groups, or browse everything as a tree grouped by the body it orbits.
- **Visit other worlds**: landers, rovers and the Ingenuity helicopter stand on the Moon, Mars and Titan at their cited coordinates (Apollo to Chang'e and Chandrayaan-3, Viking to Perseverance); Curiosity and Perseverance follow NASA's waypoint data.
- **Follow anything**: click an object to see its telemetry, launch info, livestream, news and a Wikipedia summary, and let the camera follow it.
- **Look through a telescope**: the Observatories panel lists space telescopes and ground sites. The Sky view turns the scene into a sky survey (Aladin Lite) seen from there, with the planets marked and archive images from Hubble and JWST.
- **Watch launches**: a launch board with live countdowns, livestreams in pop-out windows, and modeled ascent paths for Falcon 9 and Electron.
- **Control time**: live, pause, rewind, speed up to x600, or jump to any offset from now.
- **Track the ISS**: live position and solar array angles on a 3D model.
- **Pick a look**: three skins (Classic, Terminal and a 1960s mission-control console) in Settings.
- **Work offline**: cached data keeps working without a network, and `?mock=1` runs the app on synthetic data.

## Quick start

You need **Node 24**.

```
npm install
npm run assets     # optional: surface maps for the Earth, Moon, Mars and 18 more planets, moons and dwarf planets
npm run dev        # server on :8787, web on :5173
```

Open <http://localhost:5173>. Run the tests with `npm test`.

## Basic controls

| Input | Action |
|---|---|
| Left drag / wheel | Orbit / zoom |
| Right drag | Pan |
| Click | Select an object (an object with no position now shows its parent body) |
| `F` | Frame the selection |
| `S` | Toggle the surface-aligned view |
| `Esc` | Deselect and return to Earth view |
| View menu (top bar) | Labels, shading, highlight, scope, legend and which panels are shown |
| Settings (top bar gear) | Skin, close-up imagery, surface view default, YouTube controls, panel sizes, restore defaults |
| `H` or `?` | Show all controls in the app |

## Where the data comes from

[CelesTrak](https://celestrak.org) (satellite orbits, optionally [Space-Track](https://www.space-track.org) with a login), [Launch Library 2](https://thespacedevs.com/llapi) (launches), [Spaceflight News](https://www.spaceflightnewsapi.net), NASA DSN Now, [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) (probes, and the positions of the planets, dwarf planets and major moons, with an analytic fallback offline) and [wheretheiss.at](https://wheretheiss.at) plus the ISS Lightstreamer feed (ISS). The About tab reads [Wikipedia](https://www.wikipedia.org) (found through Wikidata) and, with a free token, [ESA DISCOS](https://discosweb.esoc.esa.int/); the Sky view's image card reads [MAST](https://archive.stsci.edu/) (Hubble, JWST). Both fetch only for the object you open. If CelesTrak is blocked on your network, see the troubleshooting section of the [reference](docs/reference.md#celestrak-blocked-or-unreachable).

## How it is organised

An npm workspaces monorepo:

- `packages/core`: shared model (bodies, frames, orbit providers, the clock).
- `apps/server`: Node aggregator that polls the feeds, caches them in SQLite and serves REST and WebSocket.
- `apps/web`: React and three.js client.

## More documentation

- [Reference](docs/reference.md): every feature, control, setting, data source and known issue in detail.
- [API contract](docs/CONTRACT.md): REST and WebSocket routes and entity conventions.
- [Frames of reference](docs/frames.md): how the frame, lock and orbit-line rules work, and the sky pointing maths.
- [Models](docs/models.md): how an object gets its shape (sphere, ellipsoid, procedural model, glb mesh), the body surface maps, and how assets are loaded and freed.
- [Performance](docs/perf.md): where the time goes with large catalogs (2 k to 1 M objects).

## Credits

Earth imagery: NASA Blue Marble and NASA GIBS. Moon: three.js example texture from NASA LRO imagery. Mars: USGS Astrogeology / NASA Viking MDIM 2.1. Other planets, moons and dwarf planets: USGS Astrogeology planetary WMS (MESSENGER, Magellan, Galileo, Voyager, Cassini, Dawn, New Horizons) and, for Jupiter, the NASA/JPL/Space Science Institute Cassini cylindrical map (PIA07782). Maps are downloaded by `npm run assets` and not committed. Sky view: [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/) and the HiPS surveys served by the CDS, Strasbourg (loaded from a CDN when the Sky view is started).

## License

GNU GPL v3, see [LICENSE](LICENSE).
