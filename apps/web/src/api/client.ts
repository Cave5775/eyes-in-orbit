import type { ArchiveImagesResult, Article, AscentSeries, CredentialInfo, Description, EntityRecord, Launch, RoverTraverse, ServerMessage } from '@eio/core';
import { isIss } from '../lib/entity';
import { clampMockCount } from '../mock/generators';
import { createMockApi } from '../mock/mock-api';
import { setTextMatcher, useStore } from '../state/store';
import { bodyEntityRecords, mmgisTileUrlFor } from '@eio/core';
import { PAGE_SIZE, loadPaged } from '../lib/paging';
import type { Api, MinorPlanetIndex } from './types';
import { StreamClient } from './stream';

async function getJson<T>(path: string, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(path, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

const restApi: Api = {
  entities: (since, page) => getJson(`/api/entities${qs({ since, limit: page?.limit, offset: page?.offset })}`, 60_000),
  search: (q, limit = 20) => getJson(`/api/search${qs({ q, limit })}`, 8_000),
  match: (q) => getJson(`/api/match${qs({ q })}`, 15_000),
  launches: async () => (await getJson<{ launches: Launch[] }>('/api/launches')).launches,
  news: async (o = {}) => (await getJson<{ articles: Article[] }>(`/api/news${qs({ entity: o.entity, q: o.q, limit: o.limit })}`)).articles,
  dsn: () => getJson('/api/dsn'),
  describe: (entityId) => getJson<Description>(`/api/describe/${encodeURIComponent(entityId)}`, 30_000),
  archiveImages: (observatoryId, bodyId) => getJson<ArchiveImagesResult>(`/api/archive-images${qs({ observatory: observatoryId, body: bodyId })}`, 30_000),
  iss: () => getJson('/api/iss'),
  health: () => getJson('/api/health', 4_000),
  traverse: (entityId) => getJson<RoverTraverse>(`/api/traverse/${encodeURIComponent(entityId)}`, 15_000).catch(() => null),
  mapTile: (layer, z, x, y) => mmgisTileUrlFor(layer, z, x, y),
  minorPlanetIndex: () => getJson<MinorPlanetIndex>('/api/minor-planets', 15_000).catch(() => null),
  minorPlanetChunk: async (k) => {
    const res = await fetch(`/api/minor-planets?chunk=${k}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`minor planet chunk ${k}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  ascent: (launchId) => getJson<AscentSeries>(`/api/telemetry/${encodeURIComponent(launchId)}`, 8_000).catch(() => null),
  credentials: async () => (await getJson<{ credentials: CredentialInfo[] }>('/api/credentials', 8_000)).credentials,
  saveCredentials: async (values) => {
    const res = await fetch('/api/credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json().catch(() => ({}))) as { credentials?: CredentialInfo[]; error?: string };
    if (!res.ok || !body.credentials) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body.credentials;
  },
};

/** Active data source: the REST client, or the offline mock when the API is unreachable (or `?mock=1`). */
export let api: Api = restApi;

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

  const onMessage = (m: ServerMessage, reconnected: boolean) => {
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
    }
  };

  const stream = new StreamClient(onMessage, (c) => store().setConn(c));
  watchIssSelection((t) => stream.setTopics(t));
  setTextMatcher((text) => api.match(text)); // large catalogues are searched by the server's index (state/store.ts)
  void loadAll(true).then(() => stream.start());
}

function startMock(): void {
  // ?n=12000 stress-tests the catalog size (capped at MOCK_MAX_SATS)
  const n = clampMockCount(Number(new URLSearchParams(location.search).get('n')));
  api = createMockApi(Date.now(), n);
  store().setConn('mock');
  void loadAll(true);
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

export async function startData(): Promise<void> {
  const forced = new URLSearchParams(location.search).get('mock') === '1';
  if (!forced) {
    try {
      await restApi.health();
      return startReal();
    } catch {
      console.warn('[eio] API unreachable on /api, falling back to mock data');
    }
  }
  startMock();
}
