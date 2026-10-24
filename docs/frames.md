# Frame of reference: design and contract

Status: design for the plans.md item "Restructure the scene to change the frame of reference to the selected celestial body in a hierarchical system". Written before the implementation; the implementing agents follow it and update it when they learn something that changes it.

## What the user sees today, and why it is wrong

The EARTH / MOON / SUN tabs only move the camera. With the Moon selected and the Lunar Reconnaissance Orbiter (LRO) picked, the LRO's path is a wavy line relative to the Earth, not a closed orbit around the Moon, because
1. LRO is a `probe` with `bodyId: 'EARTH'` and geocentric Horizons samples (`apps/server/src/connectors/horizons.ts`, `CENTER '500@399'`, `frame: 'EARTH:inertial'`, 30 min steps), and
2. paths, trails and orbit lines are sampled in `EARTH:inertial` and only *translated* with the Earth (`lib/paths.ts`, `scene/overlays.ts`), never re-expressed relative to the chosen body at each sample time.

## Model

**Body tree.** `packages/core/src/bodies.ts` already has SUN -> EARTH -> MOON and SUN -> MARS (`parentId`, `lineage()`), and `convert` / `hopInertial` / `EntityGraph.stateIn(id, t, '<BODY>:inertial')` can express any state in any body's inertial frame (all inertial frames share the equatorial axes, so hops are translations). Every entity has a primary body, `EntityRecord.bodyId` (the body it orbits or stands on): satellites EARTH, LRO MOON, deep-space probes stay as they are.

**Centre.** The frame of reference is a centre, either a body or an entity:
```ts
type Centre = { kind: 'body'; id: string } | { kind: 'entity'; id: string };   // default { kind: 'body', id: 'EARTH' }
```
Frames are translations only (no rotation): a centre at position `c(t)` in Earth-inertial coordinates. Entities stay stored and rendered in Earth-inertial coordinates; the renderer is camera-relative, so *where things are drawn now* does not depend on the frame. What the frame changes is everything that depends on time:
- **paths, trails, orbit lines** are sampled in the frame: a sample at time `t_i` is `r(t_i) - c(t_i)` (position relative to the centre at that time) drawn around the centre's *current* position, `+ c(now)`. LRO around the Moon is a closed ellipse that moves with the Moon; an Earth satellite seen from a Moon frame is the true relative curve. With the centre Earth this must reproduce today's output exactly (regression guard).
- **readouts** (range, speed) are relative to the centre (the Telemetry tab already does this for bodies through `convert`; generalise to entity centres: subtraction of two `stateIn(..., 'EARTH:inertial')`).
- **the camera** pivots on the centre when the frame is set from the UI; selecting objects moves the camera focus as today, independently of the frame.

**Selection vs frame vs lock** (the store, `apps/web/src/state/store.ts`):
```ts
frame: Centre;            // replaces refBody
frameLocked: boolean;     // locked: selecting objects never changes the frame
setFrame(centre: Centre, opts?: { lock?: boolean; fly?: boolean }): void;
setFrameLocked(locked: boolean): void;
```
- `select(id)` keeps its camera behaviour (focus, follow) but no longer touches the frame, except: when not locked and the entity is *orbitable* (a body node, or later an entity flagged as such) the frame becomes that body.
- "Lock the frame to the object": `setFrame({kind:'entity', id}, {lock: true})`; then other objects can be selected and their paths and readouts are relative to it.
- `resetView()` sets the frame to Earth and unlocks.
- Surface view stays Earth-only.

**Primary-body physics.** Orbit period and altitude use the primary body's `gm` and radius (`apps/web/src/lib/orbit.ts` is hard-wired to Earth; `computeTelemetry` already uses `rec.bodyId` for geodetic coordinates).

**Data.** LRO (Horizons id -85) must be fetched Moon-centred: `CENTER '500@301'`, `frame: 'MOON:inertial'`, `bodyId: 'MOON'`, a step fine enough for a ~2 h orbit (about 5 min, with Hermite interpolation from the velocities Horizons returns) over a window that stays modest (the per-target window/step must be explicit in `dsn-targets.ts`/`horizons.ts`). The drawn Moon comes from the low-precision series (`moonPositionEci`, about 0.3 degrees, up to ~2000 km); LRO is expressed relative to that same Moon by the frame hop, so it stays on the drawn Moon. Horizons vectors are ICRF J2000 and the core frames are equatorial of date (about 0.36 degrees of precession in 2026): a tilt of ~11 km at lunar distance, accepted and documented, not fixed here.

**UI** (later phase): a breadcrumb `SUN > EARTH > MOON` with a lock toggle shows and sets the frame; the entity browser groups entities under their primary body as a tree; a LOCK action in the selection; the DSN panel moves into a PANELS menu (plans.md UI/UX item).

## Implementation notes (FRAME, phase 1)

Where the implementation decided something or differs from the text above:
- **Store API** (as in the contract): `frame`, `frameLocked`, `setFrame(centre, {lock?, fly?})`, `setFrameLocked(locked)`. Additions: `focus.centre` replaces `focus.body` in `FocusRequest`; selectors `selectFrame`, `selectFrameLocked`, `frameInfoOf(state)` and the hook `useFrameInfo()` returning `{centre, locked, isDefault, label, crumbs, chain}`. `crumbs` is the breadcrumb root first (`SUN > EARTH > MOON`, an entity last for an entity centre), each crumb carrying the `Centre` a click on it would set.
- `setFrame`: an explicit call always applies, locked or not (the lock only blocks `select`). `lock` omitted leaves the lock as is. `fly` makes the camera go there and follow: a body centre also deselects (as the body tabs always did), the Earth is the home view, an entity centre keeps the selection (camera via `focus({centre})` -> the follow machinery).
- `select(id)`: never changes the frame, except when not locked and `id` is an orbitable body (`isOrbitableBody`: the bodies the scene can display, EARTH, MOON, SUN; selecting one flies the frame there, it is not an entity). "Later an entity flagged as orbitable" is not implemented: extend `isOrbitableBody` / the `select` check.
- **Paths and orbit lines in a frame.** A sample is `r(t_i) - c(t_i) + c(ref)` with `ref` the build time. The buffers are not rebuilt as the centre moves: `RelPositions.shift` translates them by `c(now) - c(ref)` on upload, so they follow a moving centre (the Moon moves ~26,000 km between rebuilds of a 3-day path). Deep-space compression is applied to the framed point (`ref`-based), so the Earth-centred shell is unchanged. Rebuilt when the centre, distance scale or window changes.
- The entity that is the centre is drawn relative to its **primary body** (`frameFor`): relative to itself it would be a point.
- A path or orbit is hidden while the centre entity has no state at the build time (outside its valid range).
- Footprints and the ground track are Earth-surface features of Earth-bound objects (`rec.bodyId === 'EARTH'`) and ignore the frame; LRO gets neither.
- **Orbit period** (`lib/orbit.ts`): gm and radius of `rec.bodyId`; closed-orbit limit 5e5 km for the Earth (as before), 1e5 km otherwise; the 100 km atmosphere margin is Earth-only (LRO's periapsis is ~30 km above the Moon). `orbitPeriodSec(graph, rec, s, tMs?)` converts `s` to the primary's inertial frame when `tMs` is given.
- **Readouts**: `computeTelemetry(graph, rec, t, centre)` adds `refRangeKm` / `refSpeedKmS` for a non-Earth body centre (core frame hop) or an entity centre (difference of two Earth-inertial states); none for the entity itself or an unknown centre. The centre entity must be in the `EntityGraph` (`ensureInGraph`; the scene does it for the frame centre).
- HUD: `CAM d FROM <LABEL>` is now the frame, not the camera's anchor, with ` [LOCKED]` appended when locked.
- Not done in phase 1 (breadcrumb, lock toggle, LOCK action and entity tree are now in the UI section below; the PANELS menu is the MENU agent's). Mars cannot be a body centre (no display). The frame is not persisted.

## UI (phase 2, what exists)

- **Frame bar** (`ui/FrameBar.tsx`, mounted in `SceneView` under the scene action buttons): `FRAME  SUN > EARTH > MOON > LRO` from `useFrameInfo().crumbs`; the logic of the chain stays in `lib/frame.ts` (`frameCrumbs`). A crumb click is `setFrame(crumb.centre, {fly: true})`; a crumb for a body the scene cannot display (`!isOrbitableBody`, Mars) is disabled. The lock toggle calls `setFrameLocked`; a locked frame is amber (`LOCKED`, `[LOCKED]` in the HUD too). A hint line (`NO STATE FOR <X> AT THIS TIME: PATHS HIDDEN`) appears when the centre is an entity that has no state at the sim time; it is a 500 ms poll of the main-thread graph (`graph.stateIn`), independent of the scene's own path hiding, so it also shows when nothing is selected.
- **Lock action** (`ui/DetailPanel.tsx`): under the header, `LOCK FRAME TO THIS OBJECT` = `setFrame({kind:'entity', id}, {lock: true, fly: true})`; while the selection is the locked frame it reads `UNLOCK FRAME` = `setFrameLocked(false)` (the frame stays on the object until another is chosen in the frame bar; selecting a body would then re-centre again). Any entity can be the frame; nothing restricts it to objects that "reasonably" orbit (a ground station gives a rotating-Earth wobble because frames do not rotate).
- **Entity tree** (`ui/EntityBrowser.tsx`, pure part `lib/entity-tree.ts`): TREE (default, remembered in `localStorage` `eio.browser`) / LIST. `buildTreeRows(items, {bodies, frame, frameBodyId, openAll, overrides, ...})` groups the already filtered and ordered items by `bodyId` (a search hit without one is looked up in the entity table, an unknown body hangs off the root) under the body tree from `defaultBodies`, counts each subtree, and emits only the open nodes as flat rows (`body`, `group`, `entity`), all `ROW_H` tall, so `VirtualList` stays unchanged. Order inside a body: sub-bodies first (MOON appears right under EARTH, not after thousands of satellites), then the objects, grouped by kind (largest group first) when the body holds more than 12, else listed directly. Default open: the nodes on the path to the frame (and the group of an entity frame) and, while a query or filter is active, everything that has a hit; the user's folds are `overrides` by row key and reset when the query or a filter changes. Bodies with a zero count are not shown. A body-node click sets the frame (`setFrame(bodyCentre, {fly: true})`, Mars only folds); an entity click is `select`. Cost: one pass over the filtered entities per change, rows only for open nodes (12,000 entities collapsed: a handful of rows).
- Not done: the frame is not persisted; entities cannot be flagged orbitable (large asteroids); the Moon and Sun in the scene cannot be picked; the TopBar body tabs still exist next to the breadcrumb.

## Bodies as entities (core)

`packages/core/src/hierarchy.ts` turns the body registry into ordinary entities, so celestial bodies are positional objects with trajectories like satellites.
- **Records**: `bodyEntityRecords(registry = defaultBodies, updatedAt = 0)` gives one `EntityRecord` per registry body: ids `body-sun` (kind `star`), `body-earth`, `body-mars` (`planet`), `body-moon` (`moon`); `group: 'bodies'`; `aliases.body` = registry id, `aliases.alt` = Sol / Terra / Luna; `render: { orbitLine (not the Sun), label, colorKey: 'body' }`; `attrs`: `radiusKm`, `gm`, `periodDays` (orbital period around the parent from `bodyPeriodSec`, not for the Sun), `approx`. `bodyId` is the registry id of the body it ORBITS (Moon `EARTH`, Earth and Mars `SUN`; the Sun names itself because the field is required) and `parentId` the entity id of that body (`body-earth`, unset for the Sun). The hub accepts the records as they are (it restamps `updatedAt`). `EntityRecord.createdAt?` (ms) is for the hub to set on first insert.
- **Provider**: `{ type: 'body', bodyId }` -> `BodyProvider`, state in `EARTH:inertial` from `bodyStateEci(id, t)`: Earth zero, Sun `sunPositionEci` (velocity by central difference), Moon `moonStateEci`, any other body the hop `convert({ frame: '<ID>:inertial', r: [0,0,0] }, 'EARTH:inertial')`. These are the positions the scene draws today, exactly; confidence 1.
- **Rank** (`entityRank`, smaller = higher up; `compareHierarchy` = rank ascending, then `createdAt ?? updatedAt` descending, then id): body entities by `bodyDepth * 1000 + registry index` (Sun, Earth, Mars, Moon), then every other object by `1e6 + bodyDepth(bodyId) + 1`: objects orbiting the Sun, then those orbiting Earth or Mars (same level, ordered by recency), then those orbiting the Moon; an unknown primary body ranks last. All bodies precede all objects, so a body always comes before anything that orbits it.
- **`orbitableBodyId(rec)`**: the registry id for a body entity (`provider.type === 'body'`), the entity's own id when `attrs.orbitable === true` (a future large asteroid), else `undefined`. `isBodyEntity(rec)` tests the provider type. `bodyPeriodSec(body, registry)` is `2 pi sqrt(a^3 / gm_parent)` (Moon about 27.4 d, Earth 365.3 d, Mars 687 d; the elements are approximate).

## Work split and file ownership (phase 1, parallel)

| Agent | Scope | Owns |
|---|---|---|
| DATA | per-target centre/frame/body/step in the Horizons connector; LRO Moon-centred; `bodyId` MOON; core helpers (orbitable bodies, `relativeState`) and tests | `apps/server/src/connectors/{horizons,dsn-targets}.ts` (+tests, fixtures), `packages/core/src/{bodies,entity-graph,frames}.ts` additions, `apps/web/src/mock/generators.ts` (a mock LRO around the mock Moon) |
| FRAME | `Centre` type and `lib/frame.ts`, store `frame`/`frameLocked`, replace `RefBody` usage, paths/trails/orbit lines sampled in the frame, readouts, camera pivot, orbit period by primary gm | `apps/web/src/lib/{frame,ref-body,paths,orbit,telemetry}.ts` (+tests), `apps/web/src/state/store.ts`, `scene/{PathOverlay,overlays}.ts`, the frame/focusBody/bodyTarget/path parts of `scene/SceneController.ts`, `ui/SceneView.tsx` HUD frame text, `ui/TopBar.tsx` tab wiring (keep the tabs working, they become `setFrame` shortcuts), `ui/detail/TelemetryTab.tsx` readout labels |
| SURFACE | surface view targets the object, oriented with the local surface, on by default when viewing an object | surface functions of `scene/SceneController.ts` (`setSurfaceMode`, `surfaceTarget`, `surfaceFitDist`, `fitSurface`, `panSurface`, `pickSurfaceSource`, `freezeSurfaceSource`, a small auto-surface hook at the end of `focus()`), `lib/camera.ts` and `scene/controls.ts` surface parts, tests |

Phase 2 (after phase 1 is verified and committed): UI/UX agent (breadcrumb, lock, entity tree, PANELS menu with the DSN panel).

Rules for everyone: no git commands that change state; small Edit calls and re-reading regions right before editing shared files; own dev-server port; report what was verified and what not.
