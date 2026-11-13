import { RateCounter, RollingWindow } from './perf-stats';

/**
 * Perf instrumentation, off unless the page was opened with `?perf=1`. Every hot-spot call site is
 * `const t0 = perf.on ? performance.now() : 0; ...; if (perf.on) perf.time('name', performance.now() - t0)`, so with the
 * overlay off the cost is one boolean test. Stats live here; `lib/perf-stats.ts` has the maths.
 */
const WINDOW = 600; // about 10 s of frames

export type PerfName =
  | 'frame' // wall time between animation frames
  | 'draw' // main-thread JS time of one draw() (excludes the GPU)
  | 'upload' // the point buffer re-base + upload block of a frame
  | 'propagate' // one worker SGP4 pass over every satellite (measured in the worker)
  | 'positionsCopy' // main-thread copy of the worker's buffer into the point buffer source
  | 'ingest' // store.upsertEntities (Map copy + text lookup)
  | 'sceneEntities' // SceneController.setEntities (reconcile with the catalog)
  | 'textSearch' // rankEntities over the whole catalog for the typed text
  | 'rows' // the entity browser's filter/classify pass
  | 'tree' // buildTreeRows
  | 'scope'; // refreshScope: the O(N) show/hide scan over every point, when it runs (up to 8 times a second)

const NAMES: PerfName[] = ['frame', 'draw', 'upload', 'propagate', 'positionsCopy', 'ingest', 'sceneEntities', 'textSearch', 'rows', 'tree', 'scope'];

class Perf {
  on = false;
  entities = 0;
  satellites = 0;
  /** ms from page load (performance.now) to the first rendered frame, 0 until it happens */
  firstFrameMs = 0;
  /** ms from page load to the catalog landing in the store, and to the first SGP4 positions reaching the main thread */
  firstIngestMs = 0;
  firstPositionsMs = 0;
  private win = new Map<PerfName, RollingWindow>();
  /** the latest value of every metric (the windows only keep recent samples) */
  last = new Map<PerfName, number>();
  private storeRate = new RateCounter(1000);
  private tickRate = new RateCounter(1000);
  storeUpdates = 0;

  enable(): void {
    this.on = true;
    for (const n of NAMES) this.win.set(n, new RollingWindow(WINDOW));
  }

  time(name: PerfName, ms: number): void {
    if (!this.on) return;
    this.win.get(name)?.push(ms);
    this.last.set(name, ms);
    if (name === 'propagate') this.tickRate.hit(performance.now());
  }

  storeUpdate(): void {
    if (!this.on) return;
    this.storeUpdates++;
    this.storeRate.hit(performance.now());
  }

  frameDone(): void {
    if (this.on && !this.firstFrameMs) this.firstFrameMs = performance.now();
  }

  clear(): void {
    this.win.forEach((w) => w.clear());
    this.storeUpdates = 0;
  }

  snapshot() {
    const now = performance.now();
    const stat = (n: PerfName) => this.win.get(n)?.summary() ?? { n: 0, p50: NaN, p95: NaN, mean: NaN, max: NaN };
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      frame: stat('frame'), draw: stat('draw'), upload: stat('upload'), propagate: stat('propagate'), positionsCopy: stat('positionsCopy'),
      ingest: stat('ingest'), sceneEntities: stat('sceneEntities'), textSearch: stat('textSearch'), rows: stat('rows'), tree: stat('tree'), scope: stat('scope'),
      last: Object.fromEntries(this.last) as Record<string, number>,
      storeUpdatesPerSec: this.storeRate.perSecond(now),
      workerTicksPerSec: this.tickRate.perSecond(now),
      storeUpdates: this.storeUpdates,
      entities: this.entities,
      satellites: this.satellites,
      firstFrameMs: this.firstFrameMs,
      firstIngestMs: this.firstIngestMs,
      firstPositionsMs: this.firstPositionsMs,
      heapMB: mem ? mem.usedJSHeapSize / 1048576 : null,
    };
  }
}

export const perf = new Perf();
export type PerfSnapshot = ReturnType<Perf['snapshot']>;

if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('perf') === '1') {
  perf.enable();
  (window as unknown as { __eioPerf?: Perf }).__eioPerf = perf;
}
