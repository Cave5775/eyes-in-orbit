import type { EntityRecord } from '@eio/core';
import { isIss } from '../lib/entity';
import { clampMockCount } from '../mock/generators';
import { createMockApi } from '../mock/mock-api';
import { setTextMatcher, useStore } from '../state/store';
import { useMinorPlanetStatus } from '../state/minor-planet-status';
import { useView } from '../state/view';
import { bodyEntityRecords } from '@eio/core';
import { watchMinorPlanets } from '../lib/minor-planet-watch';
import { PAGE_SIZE, loadPaged } from '../lib/paging';
import { beginStream } from '../lib/stream-start';
import type { WorkerEvent } from '../workers/data.protocol';
import type { Api } from './types';
import { DataLink } from './data-link';
import { createWorkerApi } from './worker-api';
import { WorkerStream } from './worker-stream';

/** Active data source: the browser data engine (the data worker), or the offline mock (`?mock=1`, or when the worker cannot start). */
export let api: Api = new Proxy({} as Api, {
  // until `startData` has chosen: nothing is asked (the first calls only follow it), and a tile has no address
  get: (_t, name) => (name === 'mapTile' ? () => null : () => Promise.reject(new Error('the data layer has not started'))),
});
let link: DataLink | undefined;

/** How long the engine may take to start (it opens IndexedDB and reads every connector's cache before it answers). */
const START_TIMEOUT_MS = 30_000;

const store = useStore.getState;
let lastEntitiesAt = 0;

/**
 * Load the catalogue in pages (lib/paging.ts): a full load replaces it, an incremental one (after `lastEntitiesAt`) merges. The
 * first page is on screen at once and the rest follow on a doubling commit schedule. The cursor for the next incremental load is
 * the first page's server time, so records changed while paging are fetched then. Loads run one at a time: a push that arrives
 * during a load waits for it.
 */
let entityLoad: Promise<void> = Promise.resolve();
function loadEntities(full: boolean): Promise<void> {
  const run = async () => {
    const since = full ? undefined : lastEntitiesAt;
    const r = await loadPaged(
      (offset) => api.entities(since, { offset, limit: PAGE_SIZE }),
      (records, first, serverTime) => {
        // a full load replaces the catalog, so bodies the server did not send are added locally; the server's own win when
        // they arrive in a later page (an incremental load only merges)
        const batch = full && first ? [...records, ...missingBodies(records, serverTime)] : records;
        // partial: more pages follow, so the remembered frame is restored by `catalogLoaded` below, not on the first page
        if (batch.length || full) store().upsertEntities(batch, full && first, full);
      },
    );
    lastEntitiesAt = r.serverTime - 1000;
    if (full) {
      // the bodies of the registry the server never sent (its `bodies` connector is off, or it is an older server)
      const have = store().entities;
      const missing = bodyEntityRecords(undefined, r.serverTime).filter((b) => !have.has(b.id));
      if (missing.length) store().upsertEntities(missing);
      store().catalogLoaded();
    }
  };
  entityLoad = entityLoad.then(run, run);
  return entityLoad;
}

const missingBodies = (records: EntityRecord[], serverTime: number): EntityRecord[] => {
  const have = new Set(records.map((r) => r.id));
  return bodyEntityRecords(undefined, serverTime).filter((b) => !have.has(b.id));
};

/** Pull every collection; individual failures are tolerated so a flaky connector does not blank the UI. */
async function loadAll(full: boolean): Promise<void> {
  const s = store();
  const results = await Promise.allSettled([
    loadEntities(full),
    api.launches().then(s.setLaunches),
    api.news().then(s.setNews),
    api.dsn().then(s.setDsn),
    api.health().then((h) => s.setHealth(h.connectors, h.serverTime)),
  ]);
  results.forEach((r) => r.status === 'rejected' && console.warn('[eio] load failed:', r.reason));
}

/** Subscribe to the `iss` topic only while the ISS is selected; fetch a snapshot on selection. */
function watchIssSelection(setTopics: (t: Set<string>) => void): void {
  let was = false;
  useStore.subscribe((s) => {
    const on = isIss(s.selectedId ? s.entities.get(s.selectedId) : undefined);
    if (on === was) return;
    was = on;
    setTopics(new Set(on ? ['iss'] : []));
    if (on) api.iss().then((p) => store().setIss(p)).catch(() => undefined);
  });
}

function startReal(): void {
  let pending: ReturnType<typeof setTimeout> | undefined;
  const refetchEntities = () => {
    clearTimeout(pending);
    pending = setTimeout(() => void loadEntities(false).catch((err) => console.warn('[eio] entity refresh failed:', err)), 250);
  };

  const onMessage = (m: WorkerEvent, reconnected: boolean) => {
    const s = store();
    switch (m.type) {
      case 'hello':
        s.setHealth(s.health, m.serverTime);
        if (reconnected) void loadAll(false);
        break;
      case 'entities.changed': refetchEntities(); break;
      case 'launches': s.setLaunches(m.launches); break;
      case 'news': s.setNews(m.articles); break;
      case 'dsn': s.setDsn(m.snapshot); break;
      case 'health': s.setHealth(m.connectors); break;
      case 'iss.fix': s.setIss({ fix: m.fix }); break;
      case 'iss.telemetry': s.setIss({ telemetry: m.points }); break;
      case 'iss.arrays': s.setIss({ arrays: m.arrays }); break;
      case 'minorPlanets': useMinorPlanetStatus.getState().set(m.status); break;
    }
  };

  const stream = new WorkerStream(link!, onMessage, (c) => store().setConn(c));
  watchIssSelection((t) => stream.setTopics(t));
  watchMinorPlanetDownload();
  setTextMatcher((text) => api.match(text)); // large catalogues are matched by the engine over its catalogue (state/store.ts)
  void beginStream(loadAll(true), () => stream.start(), () => loadEntities(false));
  link!.onDead((reason) => {
    // the engine is gone: nothing more arrives. The scene keeps what it has, and the header says so.
    console.warn('[eio] the data worker stopped:', reason);
    store().setConn('offline');
  });
}

function watchMinorPlanetDownload(): void {
  watchMinorPlanets(() => api, useView, useMinorPlanetStatus.getState().set);
}

function startMock(): void {
  // ?n=12000 stress-tests the catalog size (capped at MOCK_MAX_SATS)
  const n = clampMockCount(Number(new URLSearchParams(location.search).get('n')));
  api = createMockApi(Date.now(), n);
  useMinorPlanetStatus.getState().setAvailable(true);
  store().setConn('mock');
  void loadAll(true);
  watchMinorPlanetDownload();
  // stand-in for pushes: ISS fix at 1 Hz while selected, DSN/health refresh every few seconds
  let issTimer: ReturnType<typeof setInterval> | undefined;
  watchIssSelection((topics) => {
    clearInterval(issTimer);
    if (topics.has('iss')) issTimer = setInterval(() => void api.iss().then((p) => store().setIss(p)), 1000);
  });
  setInterval(() => {
    void api.dsn().then(store().setDsn);
    void api.health().then((h) => store().setHealth(h.connectors, h.serverTime));
  }, 5000);
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

export async function startData(): Promise<void> {
  const forced = new URLSearchParams(location.search).get('mock') === '1';
  if (!forced) {
    try {
      link = new DataLink(new Worker(new URL('../workers/data.worker.ts', import.meta.url), { type: 'module', name: 'eio-data' }) as never);
      const real = createWorkerApi(link);
      await withTimeout(real.health(), START_TIMEOUT_MS, 'the data worker'); // answers once the engine is built and its cache is read
      api = real;
      useMinorPlanetStatus.getState().setAvailable(true);
      return startReal();
    } catch (err) {
      link?.close();
      link = undefined;
      console.warn('[eio] the data worker could not start, falling back to mock data:', err);
    }
  }
  startMock();
}
