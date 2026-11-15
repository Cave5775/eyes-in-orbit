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

- Shipped ellipsoids (NAIF `pck00011.tpc`, the IAU radii; every body whose c / a is under 0.975): Phobos, Deimos, Mimas, Enceladus, Iapetus, Miranda. Haumea is left out (no sourced radii and no rotation in the registry to orient it). No glb is registered: the mesh tier was checked with a generated test model (a lumpy sphere standing in for Io, in a headless browser: the file loaded when the disc passed 24 px, replaced the sphere, was lit by the Sun and released when the camera left). The real models are requested as triage items (the user supplies the files); until one is added the tier is idle.
- Mesh bodies are lit by one directional light per held mesh and have no night-side fill, texture maps are used only as the glb carries them, and there are no levels of detail inside a mesh (one file per body; split into two entries with different `loadPx` if a coarse and a fine model are wanted).
- Articulated glb models (joints) are not supported: `assetModel` instances have no joints.
- Not verified: a real GPU, a production build (the loader is a separate chunk through the dynamic import), the budget under memory pressure with several large files.
