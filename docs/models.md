# Models: how an object gets its shape

Every object is a point sprite from afar. Closer in, it can get a better shape. The framework has five tiers, from free to costly; an object uses the cheapest tier that is right for it, and a missing or slow asset always falls back to the tier below, never to nothing.

| Tier | What | Good for | Cost per object | Where |
|---|---|---|---|---|
| 0. Sprite | one point in the shared point cloud | everything, from any distance | a few bytes in a buffer | `SceneController` point sets |
| 1. Sphere / oblate | the shared sphere scaled to the registry radius (and flattening) | planets, moons, Ceres | none (one shared geometry) | `CelestialLayer.buildGeneric` |
| 2. Ellipsoid | the same sphere scaled per axis (a, b, c) | bodies that are measurably not round: Haumea, the small moons | none | `BodyShape` kind `ellipsoid` |
| 3. Procedural model | a three.js builder (boxes, cylinders, joints) | the ISS, satellites, rocket stages | built when the camera is near, freed after | `scene/models/registry.ts`, `ModelDef.build` |
| 4. Mesh (glb) | a glTF binary | detail that cannot be parametric: dwarf planets, small bodies with shape models, named spacecraft | the file, fetched once and shared | `BodyShape` kind `mesh`, `assetModel()` |

## Why these choices

- **Parametric first.** A planet or a moon is a sphere, an oblate spheroid or a triaxial ellipsoid; a file adds nothing and costs a download. Tiers 1 and 2 are data (three numbers and a source), so adding a body is one line.
- **glb for the rest.** glTF is the standard compact format for three.js, `three/addons` ships its loader (no new dependency), it holds geometry, materials and textures in one file, and NASA and ESA publish their shape models in formats that convert to it. It is imported only when a mesh is first asked for, so the first page load does not carry it.
- **Scalability is in the lifecycle, not the format.** Three rules apply to every asset:
  1. *Nothing is fetched until it is needed.* Entities: the file is requested when the first instance is built, which `ModelLayer` does only inside the model's `lodKm`. Bodies: when the body's disc is 24 px across (`MESH_LOAD_PX`, per body `loadPx`), dropped again under 40 % of that (hysteresis, no flicker).
  2. *One parsed copy, many users.* `MODEL_ASSETS` (`lib/asset-cache.ts`) keys by URL and counts references. A thousand satellites naming one model share its geometry and textures; an instance clones only the scene graph and its own materials (so dimming one does not dim the rest).
  3. *A memory budget with LRU eviction.* An asset nobody holds stays cached while the byte budget (`MODEL_BUDGET_BYTES`, 256 MB) allows, so zooming back in is instant, and is disposed oldest-first when it does not. An asset someone holds is never evicted.
- **Failure degrades.** A model that cannot be loaded (missing file, a dev server answering with its HTML page, a bad glb) keeps the placeholder ball (entities) or the sphere / ellipsoid (bodies), logs one line, and is asked again after a minute.
- **Everything keeps the floating origin.** Models are positioned camera-relative in float64 on the CPU like every other object; a glb is normalised to a unit bounding sphere on load so the file's own units and origin do not matter, then scaled to the radius the registry states.

## Body surface maps

Tier 1 bodies can wear a downloaded global map (`npm run assets`, git-ignored, `apps/web/public/textures/<file>`). The table is `BODY_TEXTURES` in `lib/body-textures.ts`; the downloads are in `scripts/fetch-assets.mjs`. A missing file changes nothing (the body keeps its tinted or banded look and the console says so once).

- **Lifecycle.** Mars loads its map at once (as before; `eager: true` in `BODY_TEXTURES` is the one switch, and the file name lives only there); every other body loads it when it is selected (at once, at any zoom; `selectObject()` is the only route, and `mapWanted` in `lib/body-textures.ts` is the one decision, shared with the glb mesh tier) or when its disc reaches `MAP_LOAD_PX` (24 px), and frees it (texture and material disposed, the procedural material put back) when it is no longer selected and the disc falls under 40 % of that, the same hysteresis as the mesh tier; a selected body never loses its map. A 2048 x 1024 map is about 11 MB with mipmaps; the GPU's texture limit still scales a map down. A load that finishes after the body left is discarded. A file that is missing is not asked for again that session.
- **Why downloaded global maps, not a runtime tile stream.** The Earth streams finer DETAIL tiles (NASA GIBS) because it is the one body whose imagery changes daily and that you fly low over. For the other bodies the data is static, the global maps are a few hundred KB, and the USGS WMS would need one request per tile per view with no benefit at the sizes these bodies are usually seen; a runtime stream would add network dependence and a politeness budget for nothing. A tile stream for a close-up of one body (the Moon from LRO, Mars from the same WMS) is the natural extension if a lander-scale view is added.
- **Orientation.** The registry's IAU rotation (pole, W0, rate: `packages/core/src/bodies.ts`) puts the mesh's +x at the prime meridian with z on the pole; every map is laid out with the prime meridian at the centre column and east to the right (`textureU`, layout `centred-east`: u = 0.5 + east longitude / 360), which is how `createMapSphere` maps it. The USGS layers are declared in the IAU 2015 east-positive planetocentric system, so a WMS request for the box -180..180 returns exactly that. Checked by eye against known features after download: Io's Pele (105 E) sits at 0.79 of the width, Callisto's Valhalla (56 W) at 0.34. Orientation check by eye on the downloaded maps (all confirmed east-positive, centred, east to the right; none was flipped or shifted): Io (Pele 105 E, at 0.79 of the width), Callisto (Valhalla ring basin near 56 W), Europa (Pwyll, 271 W = 89 E, bright ray crater at 0.75 of the width and 25 S), Ganymede (Osiris rays at 166 W on the left edge, the dark Galileo Regio in the western half, Tros rays near 27 W), Tethys (Odysseus, 128 W, at 0.14 of the width), Iapetus (dark Cassini Regio on the leading hemisphere, centred on 90 W, left half), Mimas (Herschel on the leading hemisphere, at about 110 W), Charon (dark Mordor Macula at the north pole; the south was not imaged), Pluto (Sputnik Planitia split across the 180 degree seam at the edges), Mercury, Venus, Titan, Rhea, Ceres and Triton (large features only). Weakest: Dione (the bright wispy cliffs fall on the trailing hemisphere, 90 E, as expected) and Enceladus (no feature identified unambiguously at 1024 px); both rely on the same service and conventions. The Charon longitude is confirmed only by its pole, since no unambiguous longitude feature was identified.
- **Flattening and ellipsoids** stay (Jupiter 0.065, Ceres 0.074 and the BODY_SHAPES ellipsoids such as Mimas, Enceladus and Iapetus, applied as a scale of the sphere). The map material takes the same `uInv2` normal correction as the procedural one (`createMapMaterial(sun, tex, inv2)`; the layer passes the procedural material's uniform on), so the terminator does not jump when the map replaces the tinted sphere. The shader line is `normalize(mat3(modelMatrix) * (normal * uInv2))`: the correction acts on the body-fixed normal before the model matrix (rotation and scale) takes it to world; the procedural material used to apply it after the matrix, which is only right for an unrotated body, and was fixed in the same change. Mars keeps its older sphere-only treatment.

| Body | Source (layer) | Licence | Native layout, as requested |
|---|---|---|---|
| Mars | USGS Astrogeology WMS `mars/mars_simp_cyl.map` MDIM21_color (Viking, 231 m/px) | US government work, no access constraints stated | -180..180 E, 4096 x 2048 |
| Mercury | USGS WMS `mercury/mercury_simp_cyl.map` MESSENGER (MDIS global mosaic, greyscale) | same | -180..180 E, 2048 x 1024 |
| Venus | USGS WMS `venus/venus_simp_cyl.map` MAGELLAN_color (Magellan radar, colourised) | same | same |
| Io | USGS WMS `jupiter/io_simp_cyl.map` SSI_VGR_color (Galileo/Voyager) | same | same |
| Europa, Ganymede, Callisto | USGS WMS `jupiter/<body>_simp_cyl.map` GALILEO_VOYAGER | same | same |
| Mimas, Enceladus, Tethys, Dione, Rhea, Iapetus, Titan | USGS WMS `saturn/<body>_simp_cyl.map` (CASSINI or CASSINI_VOYAGER; Titan CASSINI, Mimas falls back to CASSINI_MIMAS_MOSAIC) | same | same |
| Triton | USGS WMS `neptune/triton_simp_cyl.map` TRITON_VOYAGER2 | same | same; half the globe was never imaged (black) |
| Ceres | USGS WMS `asteroid_belt/ceres_simp_cyl.map` Ceres_FC_global (Dawn FC) | same | same |
| Pluto, Charon | USGS WMS `pluto/pluto_simp_cyl.map`, `pluto/charon_simp_cyl.map` NEWHORIZONS_*_MOSAIC | same | same; the unimaged south of Pluto is white |
| Jupiter | NASA/JPL/Space Science Institute, Cassini cylindrical map PIA07782 (Dec 2000, 3601 x 1801), the Wikimedia Commons copy | NASA imagery, public domain, credit NASA/JPL/SSI | latitude planetocentric, longitude axis west-positive increasing left, 0 at centre, so east is right. No surface: the clouds are a 2000 snapshot and the centre meridian is the nominal System III prime meridian |

The WMS maps' pixel scale is the service's resampling to 2048 px, not the native resolution. Evaluated and rejected: Solar System Scope textures (CC BY 4.0 but the download URLs answer an HTML page to scripts, and the Saturn, Uranus and Neptune maps are artistic rather than mapped); NASA Photojournal direct JPEG URLs (redirect to the new site, the PIA07782 file there carries a title and a labelled grid). Saturn, Uranus and Neptune: no clear-licence cylindrical map found (Cassini saw no stable surface; Voyager 2 saw near-featureless ice giants), so they keep the banded look. Phobos, Deimos, the Uranian moons (Voyager covers one hemisphere only), Eris, Haumea and Makemake (no rotation model in the registry) were not given maps.

## Adding things

**A round-ish body that needs a better shape (tier 2).** Add an entry to `BODY_SHAPES` in `lib/body-shape.ts`:

```ts
HAUMEA: { kind: 'ellipsoid', radiiKm: [a, b, c], source: 'paper or NASA/JPL page the numbers come from' },
```

`a >= b >= c`, km, along the body-fixed x (prime meridian), y and z (pole). The `source` is required and a test checks every entry has one: never put in a number you did not read from somewhere. Occluders, disc cones and picks keep using the registry's mean radius (a sphere); for the bodies this is for the difference is under a pixel at any distance where a sphere hides something. The body shader corrects its normals per axis (`uInv2`), so a strongly elongated body such as Phobos is lit correctly.

**A body with a model (tier 4).** Put the glb in `apps/web/public/models/` (or use a CORS-enabled https URL), then:

```ts
CERES: { kind: 'mesh', url: '/models/ceres.glb', bytes: 3_000_000, fallback: { kind: 'ellipsoid', radiiKm: [...], source: '...' }, source: 'where the model comes from and its licence' },
```

`bytes` is what the parsed model holds (geometry plus textures at 4 bytes a texel); measure it (`sceneBytes` in `scene/models/glb.ts`). The glb's +z must be the pole and +x the prime meridian (the convention of the map spheres); it is drawn at the registry's mean radius. Mind licences: only add models that may be redistributed, and say so in `source`.

**An object with a model (tier 3 or 4).** Procedural: write a builder with `ModelKit` (see `scene/models/satellite.ts`) and list its `ModelDef` in `registry.ts`. Glb: list `assetModel({ key, label, url, radiusM, lodKm, minViewKm, fitKm, attitude })` in `registry.ts` instead, and set `render.model` = its `key` on the entities that should use it (in the connector that creates them). A file is in the body frame of `attitude` (+X forward, +Y starboard, +Z nadir for `lvlh`) and is scaled to `radiusM` metres, whatever its own units.

## What is not here yet

- Shipped ellipsoids (NAIF `pck00011.tpc`, the IAU radii; every body whose c / a is under 0.975): Phobos, Deimos, Mimas, Enceladus, Iapetus, Miranda, and since 2026-11-17 Amalthea, Thebe, Phoebe, Janus, Epimetheus and Proteus. Hyperion (180.1 x 133.0 x 102.7 km in the same kernel) is left out like Haumea: its rotation is chaotic, the registry has none, so an ellipsoid would have no orientation. Haumea is left out (no sourced radii and no rotation in the registry to orient it). No glb is registered: the mesh tier was checked with a generated test model (a lumpy sphere standing in for Io, in a headless browser: the file loaded when the disc passed 24 px, replaced the sphere, was lit by the Sun and released when the camera left). The real models are requested as triage items (the user supplies the files); until one is added the tier is idle.
- Mesh bodies are lit by one directional light per held mesh and have no night-side fill, texture maps are used only as the glb carries them, and there are no levels of detail inside a mesh (one file per body; split into two entries with different `loadPx` if a coarse and a fine model are wanted).
- Articulated glb models (joints) are not supported: `assetModel` instances have no joints.
- Not verified: a real GPU, a production build (the loader is a separate chunk through the dynamic import), the budget under memory pressure with several large files.
