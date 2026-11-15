# Performance at scale (phase 0: measurements)

Plan item: "restructure to more efficiently stream objects and data instead of indexing everything at any given moment". This document is phase 0 only: it measures where the time goes with a synthetic catalog of 2 k, 100 k and 1 M Earth orbiters. Nothing was restructured.

## How to measure

- `http://localhost:5173/?mock=1&n=100000&perf=1` runs the mock with N orbiters (default 2000, capped at 2,000,000; `mockSatellites` in `apps/web/src/mock/generators.ts`: ISS and CSS, a Starlink-like constellation, three debris clouds, then a LEO / sun-synchronous / GPS-like MEO / GEO / Molniya mix, deterministic seed 7) and shows the readout in the bottom right corner.
- The readout (`ui/PerfOverlay.tsx`; state and call sites in `lib/perf.ts`, maths in `lib/perf-stats.ts`) shows: frame time p50/p95 over the last 600 frames, main-thread JS time of `draw()`, point-buffer upload, the O(N) scope scan, the worker's SGP4 pass, the buffer copy on the main thread, store updates per second, the last store ingest, the last `SceneController.setEntities`, the last text search, entity browser rows and tree builds, entity and satellite count and the JS heap (`performance.memory`, Chromium only).
- With `?perf=1` absent every call site costs one boolean test. `window.__eioPerf.snapshot()` returns the same numbers as JSON (this is what the measurement script used).
- `performance.now()` in headless Edge is coarsened to 0.1 ms, so sub-0.1 ms values read as 0.

## Method and caveats

One headless Edge session per N (1000x700, below-normal priority, torn down after each), Vite dev server (unminified, so JS is somewhat slower than a production build), mock data, nothing selected, default camera. Steady numbers are the rolling window over about 10 s after the catalog loaded and a 3 s settle; the search figures are one `setText('starlink')` (the store call the search field makes) followed by 2.5 s.

**The GPU is SwiftShader (software rendering), so frame time (p50/p95) is dominated by software rasterisation and says nothing about a real GPU.** What carries over to a real machine are the JS, worker and heap figures (all CPU work, measured with the same engine): draw JS time, scope scan, propagation, ingest, search and tree. Not verified: a real GPU, other browsers, a real server feeding 100 k objects over REST and WebSocket, a phone.

## Results

| | 2 k (default) | 100 k | 1 M |
|---|---|---|---|
| Catalog in the store (page load to ingest done) | 0.2 s | 0.5 s | 2.7 s |
| First frame (scene up, no points yet) | 1.4 s | 2.1 s | 9.5 s |
| First SGP4 positions on the main thread (first frame with points) | 2.0 s | 4.0 s | 27 s |
| Steady frame p50 / p95 (SwiftShader, not a GPU number) | 134 / 142 ms | 183 / 192 ms | 618 / 720 ms (17 frames) |
| `draw()` JS per frame p50 / p95 | 2.5 / 3.2 ms | 61 / 67 ms | 624 / 716 ms |
| of which scope scan (`refreshScope`, runs up to 8 x/s) | 1.0 / 1.4 ms | 59 / 64 ms | 616 / 705 ms |
| Point buffer upload p50 / p95 | 0.0 / 0.1 ms | 0.5 / 0.7 ms | 4.6 / 5.7 ms |
| Propagation, one worker pass over all sats p50 / p95 | 2.8 / 6.8 ms | 156 / 194 ms | 1852 / 3094 ms (3 passes) |
| Position updates per second (worker tick 33 ms) | 30 | 6 | about 0.5 |
| Main-thread copy of a position buffer | 0.0 / 0.1 ms | 0.3 / 0.4 ms | 2.5 / 3.8 ms |
| Store ingest (`upsertEntities`) | 0.2 ms | 8.7 ms | 182 ms |
| `SceneController.setEntities` (reconcile, once per catalog load) | 53 ms | 247 ms | 2724 ms |
| Entity browser rows / tree build, first load | 0.7 / 1.8 ms | 14.7 / 33 ms | 281 / 478 ms |
| Text search (`rankEntities` over the catalog, one query) | 2.2 ms | 83 ms | 1027 ms |
| Rows / tree rebuild after that query | 0.3 / 0.6 ms | 24 / 30 ms | 400 / 447 ms |
| JS heap after load / steady / after the query | 45 / 62 / 57 MB | 137 / 131 / 138 MB | 695 / 677 / 789 MB |
| Entities | 2,053 | 100,053 | 1,000,053 |

The mock has no pushes, so store updates per second were 0 in steady state; the first full load is one update. The real server pushes `entities.changed`; each push runs the same `upsertEntities` plus `setEntities` path (the cost above scales with the whole catalog, not with the delta).

## Reading the numbers

1. **The main thread is first lost to the per-frame scope scan, not to propagation or upload.** `refreshScope` walks every point to set its show flag. It is 1 ms at 2 k, 59 ms at 100 k (more than a 60 fps frame budget of 16 ms, by itself) and 0.6 s at 1 M, and it runs every frame once frames are slower than 125 ms. The buffer upload is cheap (0.5 ms at 100 k, 5 ms at 1 M): a plain `Float64Array` that is re-based on the camera in a pass, not the bottleneck at these sizes.
2. **SGP4 is already in a worker, but one worker serial over all sats.** About 1.4 to 1.9 microseconds per satellite: 3 ms at 2 k (fine), 156 ms at 100 k (positions refresh 6 times a second, visibly stepped at x1 and wrong at x600), 1.9 s at 1 M. The main thread only pays the 0.3 ms copy, so propagation does not block frames, it makes the data stale. Starting 1 M takes 27 s to the first positions: the first pass waits behind building 1 M satrecs in `json2satrec`.
3. **Search and the tree are linear in the catalog and run on the main thread.** One text query is 83 ms at 100 k and 1 s at 1 M, and the rows and tree rebuild adds 55 ms and 850 ms. They block input at 100 k and freeze the page at 1 M. The tree already virtualises its DOM (a few dozen rows), so rendering is fine; the cost is the full-catalog sort, filter and group pass (`browseOrder` sort, `classify`, `buildTreeRows`) that runs again on every query change.
4. **Ingest and the reconcile are paid per catalog change, over the whole catalog.** `setEntities` is 0.25 s at 100 k and 2.7 s at 1 M, `upsertEntities` copies the whole `Map` each time. Fine for a one-off load, wrong for a push stream of deltas at 100 k objects.
5. **Memory is about 0.65 to 0.7 KB per entity in JS** (record objects, OMM fields as JS objects, strings, maps, plus the worker's satrecs and buffers not included in `performance.memory` of the main thread): 137 MB at 100 k, 700 MB at 1 M, close to 800 MB while searching. 1 M entities fit in a tab here, but at 2 M (the cap of `n`) this would need over 1.4 GB; not tried.
6. **Frame time is not informative here** (SwiftShader). The point cloud at 1 M on a real GPU is a vertex-bound draw that GPUs handle; the JS figures above are what remains.

## Ranked recommendation

Ordered by how much each removes at 100 k to 1 M, per unit of work:

1. **Spatial and scope work off the frame: stop scanning every point on the main thread** (no item name in the plan; it follows from the numbers). The scope scan is the largest per-frame main-thread cost (59 of 61 ms at 100 k). Move the show/hide decision into the vertex shader (distance to the focus is already a uniform-friendly test, the shader already does the Earth occlusion) or into the propagation worker, which already touches every satellite each pass, and send a flag array back with the positions. The filter and selection exemptions become a small set of ids or a per-point flag array maintained incrementally.
2. **Server paging plus viewport / scope filtering.** The most scalable fix, because it avoids holding and indexing everything: the client asks for the objects in scope (the camera focus radius, the selection and its related objects, the query matches) and for the rest only counts. It also cuts the 0.65 KB/entity heap, the ingest and reconcile (4) and the first-positions delay (2). It needs a contract change (`/api/entities` paging and bounds) and is the largest piece of work; mock mode can implement it first.
3. **Server-side search (FTS5 in the SQLite cache).** Search and the tree query then return a bounded page (`/api/search` already exists with a ranking) instead of ranking the whole catalog in the browser: removes the 83 ms to 1 s query and the 55 to 850 ms rebuild, and with it the sort in `ordered`. Tree counts per body and kind come from `GROUP BY`. Do this after or with paging; it depends on the server being reachable (mock mode would keep the local ranking).
4. **Parallel or chunked worker propagation.** Split the satellites over a few workers (or propagate only those in scope, which falls out of 2) and keep one position buffer per chunk. 100 k at 30 Hz needs 4 to 8 workers; only worth doing if paging does not already bring the in-scope count down to a few thousand. Also build satrecs in chunks so first positions do not wait 27 s at 1 M.
5. **Typed-array catalog (struct of arrays) instead of record objects.** Shrinks the heap and the Map copy; the invasive one, since every consumer reads `EntityRecord`. Skip until paging shows a real need; the 0.7 KB/entity only matters at 1 M.
6. **Tree virtualisation: nothing to do.** The DOM is already virtualised; the cost sits in the pass that builds the rows (covered by 3), not in rendering. Rebuild the rows incrementally only if a server-side tree is not done.
7. **Typed-array point buffers: nothing to do now.** The point upload is already a float64 array shared with the worker; upload is 0.5 ms at 100 k.

Suggested next phase: (1) first, since it is local to `SceneController` and the worker, testable with the `n=` mock and this overlay; then (2) with (3) as one server-side change.

## Not measured

A real GPU, a production build, the server path (REST page size and WebSocket pushes of 100 k objects), Firefox or Safari (`performance.memory` is Chromium only), label scanning and picking costs (`pickAll` and `scanLabelCands` run on input or a timer and are not in the readout), time spent in React rendering of the rest of the UI, and anything selected or followed (overlays, orbit lines, 3D models).

## Phase 1: the scope scan is sliced and cheap (2026-11-14)

The per-frame scope scan (item 1 of the ranked recommendation) was rewritten:

- `lib/scope-scan.ts` (`scanScope`, `markSpecials`) is the old per-point loop as a pure function over typed arrays. It no longer hashes an id string per point (`ctx.focus.has`) or compares three strings: the hovered / selected / followed / related ids are resolved once to a per-point `special` byte array (`markSpecials`, only when those ids change). It no longer writes a `Vector3` or calls `Math.hypot` per point (squared distances; one square root only inside the thinning band), and it skips the view, occlusion and disc tests for points that are out of scope. `scope-scan.test.ts` checks every flag against `inScope` (the reference policy) and that a sliced scan equals one pass.
- `SceneController.refreshScope` runs it as a cycle sliced over frames: 2 to 8 ms per frame (about 5% of the last frame), `SCOPE_CHUNK` = 2048 points per call, with the camera focus, radius and view matrix captured when the cycle starts so a slice never mixes two policies. A cycle starts at most 8 times a second, or straight after the running one when an input changed (selection, filter, mode). The HUD tally (`scopeCounts`) is published when a cycle completes. A catalogue that fits in one slice (the default 2 k) is scanned in one frame as before.
- Measured (same method as above, headless Edge, SwiftShader, Vite dev, `?mock=1&n=100000&perf=1`): scope scan per frame p50 / p95 **59 / 64 -> 2.7 / 8.0 ms**, main-thread `draw()` p50 / p95 **61 / 67 -> 6.7 / 15.5 ms**; 2 k default unchanged (the HUD tally of the 20 k mock reads 10,921 of 20,031 drawn). `scope scan` in the readout is now the cost of one slice, not of a whole pass.
- Cost of slicing: the show flags of a very large catalogue lag the camera by one cycle. At 100 k a cycle is about 20 frames (0.3 s at 60 fps); at 1 M about 4 s at 60 fps (2 ms slices). The point shader still culls the horizon exactly per frame, so the lag only affects which far points are thinned and what can be hovered. Not verified: a real GPU (the 1 M run here has frames of 0.6 s, so a cycle did not finish in the measurement window), selection and filter changes at 1 M.

Next, as before: server paging with viewport filtering, then FTS5 search.

## Phase 2a: the catalogue is loaded in pages (2026-11-14)

First half of ranked item 2 (the other half, serving only what is in scope, is not done). `GET /api/entities` takes `limit` and `offset` and answers `next` / `total` (docs/CONTRACT.md); the client (`api/client.ts` `loadEntities`, pure part `lib/paging.ts`) loads the full catalogue and every incremental refresh in pages of 20,000 and commits them to the store on a doubling schedule (the first page at once, then whenever the waiting records equal those shown), so total copy work stays about twice one whole commit instead of one per page. The remembered frame is restored when the last page is in (`catalogLoaded`), because its entity may be on a later page.

Why it matters is the real server path, which the mock does not exercise. Measured with the real Fastify route (`app.inject`) and mock-generator records (about 0.7 KB each), Node, 300,000 entities:

| | unpaged | paged, 20,000 a page |
|---|---|---|
| Response | one 210.7 MB document | 15 pages, largest 14.2 MB |
| Server build, JSON | 1,287 ms in one block | 113 ms for the first page |
| Client `JSON.parse` | 1,230 ms in one block | 95 ms for the first page |
| Slowest single step (server + parse) | 2.5 s | 209 ms |
| First records usable after | about 2.5 s | about 0.2 s |
| All records | 2.5 s | 2.6 s |

At about 1,000,000 records (700 MB of JSON) the unpaged answer is past V8's longest string and cannot be built at all; paged it is 50 pages of the same size. The mock (everything in memory) shows no gain: at 1 M objects the store ingest is 7 commits (mean 80 ms, worst 266 ms; one commit of everything was 182 ms) and the first ingest is done at 2.2 s (2.7 s before), the first positions at 23.5 s (27 s), the heap about 300 MB higher before the first collection. Headless Edge, SwiftShader, dev build, same method as above.

Not done: the scene still reconciles the whole catalogue on every commit (the `sceneEntities` row: 0.27 s at 100 k, 2 s at 1 M, once in the mock because the pages arrive within one frame, one per commit on a real network), the client still holds every record, and nothing is filtered by scope. Those are the viewport half: it needs counts per body and kind from the server (the tree and browser read the whole catalogue today), a scope contract the server can evaluate from orbit shells (it does not propagate), and a delta reconcile in `SceneController`.

## Phase 2b: the scene applies deltas (2026-11-14)

Item 4 of "Reading the numbers" (the reconcile is paid per catalogue change over the whole catalogue). Profile of one `setEntities` before the change, headless Edge, SwiftShader, dev build, mock `n` = 1 M: a push that changed ONE record took **1,187 ms** in the scene (the reconcile loop 367, `applyAppearance` 683 because it classifies every entity, the 3D-model pass 137); the first full load spent 547 ms in the loop and 1.45 s posting 1 M records to the worker (needed once, not per push). At 100 k a one-record push took 99 ms.

What changed:
- The store reports what a merge changed: `entityChange = { records, base }` (`base` is the map the records were merged into). `SceneView` hands a merge whose `base` is the catalogue the scene already has to `SceneController.applyEntityDelta(records)`; anything else (a replace, a scene that missed a version) takes `setEntities` as before.
- `reconcile` and `applyEntityDelta` share one `applyChanges(changed, removed, full)`. A delta skips the whole-catalogue passes: `ModelLayer.setEntity` replaces `setEntities` per record, the dynamic point set is rebuilt only when a record joins or leaves it (it was rebuilt on every change), and `repaint(changed)` repaints the points of the changed records only (through `satIndex` / `dynIndex`) instead of `applyAppearance`. A change that alters the point sets (a body, a new or departed SGP4 record) still takes the full repaint (the worker's new layout repaints everything anyway). `applyAppearance` is now a loop over the same `paintSat` / `paintDyn` the delta uses, so the two cannot drift.
- Measured, the scene part of a one-record push: **98.8 -> 0.1 ms at 100 k, 1,187 -> 0.1 ms at 1 M**. Checked in the browser that the points a delta paints (colour, size, glyph and scope flags of the cloud and of the dynamic set) are identical to a full `applyAppearance` afterwards, and that the dynamic set is not rebuilt.

What is left of a push at 1 M (about 300 to 500 ms) is the store: `upsertEntities` copies the whole `Map` (measured 460 ms for 1 M entries) because a new reference is how 34 consumers learn the catalogue changed. Not done: a mutable catalogue with a version counter, and the UI consumers that rebuild from the whole catalogue (the Objects tree and list: 0.4 s at 1 M).

## Phase 3: text search through a server index (2026-11-14)

Ranked item 3: one text query ranked the whole catalogue in the browser (`rankEntities`: 83 ms at 100 k, 1 s at 1 M, on the main thread, plus the rows and tree rebuild after it).

What changed:
- The ranking moved into `@eio/core` (`match.ts`: `matchScore`, `rankMatches`), one source for the browser's local search, the offline mock and the server; equal scores now tie-break by id so the order does not depend on how records arrive.
- The server keeps an in-memory SQLite FTS5 table with the `trigram` tokenizer over the lower-cased id, name and alias values (`apps/server/src/search-index.ts`), synced from the hub's `entities.changed`. `GET /api/match?q=` takes the candidates from the index (any substring of 3 or more characters) and ranks only those with the shared `matchScore`. A test checks that the answer equals ranking the whole catalogue, in the same order, for plain, accented, quoted and FTS-operator queries (`*`, `NEAR(`, `AND`, `^`) and for queries under three characters (which scan). `GET /api/counts` is a `GROUP BY` over a side table of the same rows (not used by the client yet).
- The store asks the server when the catalogue has 20,000 records or more, 150 ms after the last keystroke, keeps the previous answer while the next is awaited, ignores answers that arrive late, and ranks locally on an error or a truncated answer.

Measured, Node, 300,000 mock entities (about 40 characters of text each; one core):

| | local scan and rank (what the browser did) | server index |
|---|---|---|
| `starlink-12` (11,100 matches) | 154 ms | 20 ms |
| `cosmos` (26,903 matches) | 151 ms | 40 ms |
| `deb` (47,997 matches) | 158 ms | 64 ms |
| `iss` (1 match), `25544` (16), no match | 157 ms | 0 ms |
| a query matching most of the catalogue (`sat`) | 401 ms | 743 ms: capped, the client ranks locally |
| Browser main thread per query (JSON parse + hit rows) | 157 to 231 ms | 0 to 12 ms (140 KB payload for 11,100 ids) |
| Index build | | 2.8 s (9.4 microseconds a row); 8 ms to sync 500 changed records |

Finding on the way: the first build took 12.2 s (37 microseconds a row) because the side table was written with `INSERT OR REPLACE`, which costs 32 microseconds a row next to an FTS5 table; a plain `INSERT` for new rows and an `UPDATE` for known ones made it 8.5.

Limits: a query that matches most of the catalogue is no faster (the cost is ranking and sending the matches; the server caps the list and the client then ranks itself); the browser still holds every record; the Objects tree and list rebuild from the whole catalogue after a query (0.4 s at 1 M, not touched); the index lives in memory next to the catalogue it indexes, about 40 bytes of index per record plus the text; not verified: a real server with a real catalogue and the browser end to end (the pieces are tested separately: route, index equivalence, store behaviour with a fake matcher).

## Phase 4: viewport filtering, measured first and not built (2026-11-14)

The second half of ranked item 2: let the server send only the objects in the camera's scope, so the client holds and indexes less. It needs the client to hold a partial catalogue (the lists, counts, search results and related objects all read the whole one today), so before building it the question is how much a server could actually prune. It does not propagate orbits, so the only thing it can test is the orbit shell: an object can be in a ball of radius R around the camera focus (at geocentric radius rf) only if its shell, perigee to apogee radius (from mean motion and eccentricity), meets [rf - R, rf + R], with R the scope radius of `lib/scope.ts` (80 camera distances, at least 100 km).

`scripts/shell-prune-analysis.mjs` applies that to the real CelesTrak files in `data/celestrak` (19,498 distinct objects; offline):

| View | Scope radius | Kept by the shell test |
|---|---|---|
| Default Earth view (camera 24,000 km) | 1,920,000 km | 100 % |
| Earth centre, camera 8,000 km | 640,000 km | 100 % |
| Following the ISS, camera 200 km | 16,000 km | 96 % |
| Following the ISS, camera 50 km | 4,000 km | 96 % |
| Following the ISS, camera 5 km | 400 km | 85 % |
| Following a Starlink, camera 20 km | 1,600 km | 96 % |
| Following a GPS or GEO satellite | 160,000 and 40,000 km | 100 % |
| On a pad, camera 4 km (altitude 0 to 320 km) | 320 km | 1 % |

Of the 19,498, 18,675 (96 %) are under 2,000 km altitude. Whatever the focus, almost all of them share its radial range, so a shell filter removes next to nothing; the only view that prunes is a close-up on the ground, where the scene's own scope policy already hides what is out of range at no cost (phase 1). What would prune is a position test (which LEO satellites are above this part of the Earth now), and that needs the propagation the server does not do.

Decision: the viewport half is not built. Its cost (a partial catalogue through every list, count and selection path) buys almost no reduction on a real catalogue, and the default view keeps everything in scope by design (the cloud is the product). Per-record cost is better attacked by what is already in: paging (2a), deltas (2b), the index (3). What remains if memory ever matters at 1 M records is a typed-array catalogue (item 5 of the ranked list), which changes no behaviour. The groundwork that was useful for any future partial client is in: `/api/counts` (per body, kind and group) and the paged `/api/entities`.

### Phase 4, revised: scope by hierarchy (2026-11-15)

Bounced with a direction: scope by the hierarchy instead of a distance, to draw as much as possible with nothing unnecessary. The scope policy (`lib/scope.ts`) now keeps an object when its listed parent is the focus body or an ancestor of it (details in docs/reference.md, Scope). In the scan this is cheaper than the distance rule: the whole SGP4 cloud is in or out with one flag (every SGP4 object is the Earth's), the dynamic set has one byte a point from the memoised `listedParent`, and there is no per-point distance or hash. What it changes for the numbers above: the Earth view keeps every Earth object (the distance rule also did at the default zoom; it cut them only near the ground), and every view outside the Earth system now drops all of them, which is where a scope saves real work. Loading is unchanged: the client still holds the whole catalogue, since the lists, counts and search read it.

## Phase 2c: a push costs its records end to end (2026-11-15)

After 2b, one pushed record at 1 M still cost the browser about 1.4 s: the store copied its whole catalogue `Map` (460 ms measured) and the Objects tree and list rebuilt from the whole catalogue (rows 325 ms, tree 566 ms, after a one-record push).

- `lib/catalog.ts` `Catalog`: the store's `entities` is a read-only view over one shared map. A merge writes its records into the map and returns a new view, so `entities` still changes identity on every merge (how its consumers notice) without a copy. An older view is not a snapshot (it reads the same map); nothing compared old and new contents (the store now reads the old size before the merge, the one place that did). A replace starts a new map. A test may still set a plain `Map`; the first merge adopts it.
- `catalogShape` (store) moves only when a merge changes what a list shows: a record added, or one whose fields other than its SGP4 elements and `updatedAt` changed (`sameShape`; any non-SGP4 change counts, since new samples can move a listed parent). The Objects browser's counts, order, rows and tree depend on it instead of on `entities`, so a push of new elements (the CelesTrak refresh, the bulk of the pushes) leaves them alone.
- Measured, headless Edge, mock, `n` = 1 M: one pushed record, store merge plus scene delta **290 to 528 ms -> 0.5 ms** (100 k: 9 -> 0.6 ms); the tree and list after a push of new elements: **rows 325 + tree 566 ms -> not rebuilt**; after a rename they rebuild as before (0.3 + 0.56 s at 1 M; an incremental tree is not done). The scene delta still paints exactly what a full repaint paints.
