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
