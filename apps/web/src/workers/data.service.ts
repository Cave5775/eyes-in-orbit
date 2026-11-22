import type { ClientMessage, CredentialInfo } from '@eio/core';
import type { MinorPlanetIndex, MinorPlanetStatus, StorageInfo } from '../api/types';
import { ArchiveImagesService } from '../engine/archive';
import { engineConfig, type EngineConfig } from '../engine/config';
import { bodies } from '../engine/connectors/bodies';
import { celestrak } from '../engine/connectors/celestrak';
import { dsn } from '../engine/connectors/dsn';
import { flightclub } from '../engine/connectors/flightclub';
import { horizons } from '../engine/connectors/horizons';
import { horizonsBodies } from '../engine/connectors/horizons-bodies';
import { issLive } from '../engine/connectors/iss-live';
import { issRest } from '../engine/connectors/iss-rest';
import { createLaunchlibrary, syncLaunchEntities } from '../engine/connectors/launchlibrary';
import {
  CREDIT, MPCORB_META_KEY, createMinorPlanets, downloadMinorPlanets, mpcorbChunkKey, storedMinorPlanets, type StoredMeta,
} from '../engine/connectors/minor-planets';
import { observatories } from '../engine/connectors/observatories';
import { snapi, searchNews } from '../engine/connectors/snapi';
import { createSpacetrack } from '../engine/connectors/spacetrack';
import { readTraverse, surfaceSites } from '../engine/connectors/surface-sites';
import { notam, satnogs, webcastOcr } from '../engine/connectors/stubs';
import { CREDENTIAL_FIELDS, Credentials } from '../engine/credentials';
import { DescribeService } from '../engine/describe/service';
import { Http, LimitedError } from '../engine/http';
import { Hub } from '../engine/hub';
import { Limiter } from '../engine/net/limiter';
import { webLocks } from '../engine/net/lock.browser';
import type { WithLock } from '../engine/net/lock';
import { defaultUpstreams, setAppBase, setUpstreams } from '../engine/net/upstream';
import { Scheduler, type Connector } from '../engine/scheduler';
import { EntitySearch } from '../engine/search';
import { PRUNE_KEEP_PREFIXES, PRUNE_MAX_AGE_MS, openKv, readOnlyKv, type KvStore } from '../engine/store';
import { TelemetryService } from '../engine/telemetry';
import {
  HEALTH_THROTTLE_MS, MAX_TOPICS, RPC_METHODS, type FromWorker, type RpcError, type RpcMethod, type ToWorker, type WorkerEvent,
} from './data.protocol';

export interface DataServiceOptions {
  /** deliver a message to the page (with the buffers to hand over) */
  post(msg: FromWorker, transfer?: Transferable[]): void;
  /** a ready store (tests); default: IndexedDB `eio`, or memory when the browser refuses */
  kv?: KvStore;
  config?: Partial<EngineConfig>;
  fetch?: typeof fetch;
  /** the lock around each source's limiter state (default Web Locks) */
  withLock?: WithLock;
  /** absolute URL of the app root, which a relative relay base resolves against (the worker passes origin + BASE_URL) */
  appBase?: string;
  /** replaces the connector list (tests) */
  connectors?: (deps: { credentials: Credentials; withLock: WithLock }) => Connector[];
  /** `navigator.storage` (tests pass a stub) */
  storage?: Pick<StorageManager, 'persist' | 'estimate'>;
  /** random start jitter of the connectors (default 1 s) */
  jitterMs?: number;
  /** the smallest MPCORB download that counts as the real file (tests use a 20-line sample) */
  minOrbits?: number;
}

export interface DataService {
  /** feed one message from the page */
  handle(msg: ToWorker): void;
  /** the engine is built and the scheduler started (rejects when it cannot start) */
  ready: Promise<void>;
  /** stop the connectors and close the store */
  stop(): Promise<void>;
}

const rpcError = (err: unknown): RpcError => {
  if (err instanceof LimitedError) return { message: err.message, name: err.name, limited: true, retryAt: err.retryAt };
  if (err instanceof Error) return { message: err.message, name: err.name };
  return { message: String(err) };
};

const int = (v: unknown, fallback?: number): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

/**
 * The browser data engine behind one message port: builds what `apps/server/src/main.ts` built (store, limiter with Web Locks, Http,
 * Hub, Scheduler with every connector, credentials, describe, archive images, telemetry, search) and serves the page the way the
 * server's REST routes and `/stream` did. The worker entry (`data.worker.ts`) is `createDataService` plus `onmessage`.
 *
 * Telemetry ingest and clear are not reachable from here: only the read side (`ascent`) is part of the protocol.
 */
export function createDataService(opts: DataServiceOptions): DataService {
  const withLock = opts.withLock ?? webLocks();
  const config = engineConfig(opts.config);
  const prevUpstreams = setUpstreams(defaultUpstreams({ relayBase: config.relayBase, celestrakViaRelay: config.celestrakViaRelay }));
  const prevBase = opts.appBase !== undefined ? setAppBase(opts.appBase) : undefined;

  const hub = new Hub();
  let kv!: KvStore;
  let closeKv: (() => void) | undefined;
  let storage: StorageInfo = { persistent: false };
  let scheduler!: Scheduler;
  let credentials!: Credentials;
  let describe!: DescribeService;
  let archive!: ArchiveImagesService;
  let telemetry!: TelemetryService;
  let http!: Http;
  let limiter!: Limiter;
  const search = new EntitySearch(hub);

  // ---- push (the old /stream)
  let started = false;
  const topics = new Set<string>();
  const emit = (msg: WorkerEvent) => opts.post({ kind: 'event', msg });
  const emitIf = (msg: WorkerEvent, topic?: string) => { if (started && (!topic || topics.has(topic))) emit(msg); };
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  const pushHealth = async () => emit({ type: 'health', connectors: await hub.healthList() });
  const listeners: [Parameters<Hub['on']>[0], (p: never) => void][] = [];
  const listen = <K extends Parameters<Hub['on']>[0]>(event: K, fn: (p: never) => void) => {
    hub.on(event, fn as never);
    listeners.push([event, fn]);
  };

  // ---- minor planets (opt-in download)
  let mp: MinorPlanetStatus = { state: 'none' };
  let mpRun: Promise<MinorPlanetStatus> | undefined;
  let mpCtl: AbortController | undefined;
  const setMp = (status: MinorPlanetStatus) => {
    mp = status;
    emitIf({ type: 'minorPlanets', status });
  };
  const mpStored = async (): Promise<MinorPlanetStatus> => {
    const s = await storedMinorPlanets(kv);
    return s ? { state: 'ready', count: s.meta.count, fetchedAt: s.fetchedAt } : { state: 'none' };
  };

  const minorPlanetsDownload = (o?: { force?: boolean }): Promise<MinorPlanetStatus> => {
    if (mpRun) return mpRun;
    const ctl = (mpCtl = new AbortController());
    const run = (async (): Promise<MinorPlanetStatus> => {
      const before = await mpStored();
      try {
        await downloadMinorPlanets({
          store: kv, limiter, withLock, offline: config.offline || http.offline, signal: ctl.signal, fetch: opts.fetch, minOrbits: opts.minOrbits,
          onPhase: (phase) => setMp({ ...before, state: 'downloading', phase }),
        }, { force: o?.force });
        setMp(await mpStored());
      } catch (err) {
        // a layer turned off is not a failure: back to what is stored
        setMp(ctl.signal.aborted ? await mpStored() : { ...(await mpStored()), state: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
      return mp;
    })().finally(() => { mpRun = undefined; mpCtl = undefined; });
    return (mpRun = run);
  };

  const minorPlanetIndex = async (): Promise<MinorPlanetIndex | null> => {
    const s = await storedMinorPlanets(kv);
    if (!s) return null;
    const m = s.meta;
    return {
      count: m.count, chunkSize: m.chunkSize,
      chunks: m.chunkBytes.map((_, k) => ({
        chunk: k, count: k < m.chunks - 1 ? m.chunkSize : m.count - k * m.chunkSize,
        hFirst: k === 0 ? m.hMin ?? null : null, hLast: k === m.chunks - 1 ? m.hMax ?? null : null,
      })),
      fetchedAt: s.fetchedAt, stale: Date.now() - s.fetchedAt >= s.ttlMs, skipped: m.skipped,
      epochMin: m.epochMin ?? null, epochMax: m.epochMax ?? null, credit: CREDIT,
    };
  };

  /** the chunk's bytes (an `MPCB` container) as the store holds them, alone in their buffer so the page gets them without a copy */
  const minorPlanetChunk = async (k: number): Promise<Uint8Array> => {
    const meta = (await kv.get<StoredMeta>(MPCORB_META_KEY))?.value;
    const row = meta && Number.isInteger(k) && k >= 0 && k < meta.chunks ? await kv.getBlob(mpcorbChunkKey(meta.gen, k)) : undefined;
    if (!meta || !row || row.data.length !== meta.chunkBytes[k]) throw new Error(`minor planet chunk ${k} is not stored`);
    const d = row.data;
    return d.byteOffset === 0 && d.buffer.byteLength === d.byteLength ? d : d.slice();
  };

  const credentialStatus = (): Promise<CredentialInfo[]> => credentials.status();

  const readEstimate = async (): Promise<void> => {
    try {
      const e = await opts.storage?.estimate();
      if (e) storage = { ...storage, usageBytes: e.usage, quotaBytes: e.quota };
    } catch { /* an estimate is a courtesy */ }
  };

  // ---- RPC: one case per Api method
  const call = async (method: RpcMethod, args: unknown[]): Promise<{ value: unknown; transfer?: Transferable[] }> => {
    const a = args as any[];
    switch (method) {
      case 'entities': {
        const [since, page] = a;
        return { value: search.page({ since: int(since), limit: int(page?.limit), offset: int(page?.offset) }) };
      }
      case 'search': return { value: search.search(String(a[0] ?? ''), Math.min(int(a[1], 20)!, 100)) };
      case 'match': return { value: search.match(String(a[0] ?? '')) };
      case 'launches': return { value: hub.launches };
      case 'dsn': return { value: hub.dsn };
      case 'news': {
        const o = (a[0] ?? {}) as { entity?: string; q?: string; limit?: number };
        const limit = Math.min(int(o.limit, 20)!, 50);
        let q = o.q?.trim();
        if (!q && o.entity) {
          const rec = hub.graph.get(o.entity);
          if (!rec) throw new Error(`unknown entity ${o.entity}`);
          q = rec.links?.newsQuery ?? rec.name;
        }
        return { value: q ? await searchNews(http, q, limit) : hub.articles.slice(0, limit) };
      }
      case 'describe': {
        const rec = hub.graph.get(String(a[0]));
        if (!rec) throw new Error(`unknown entity ${a[0]}`);
        return { value: await describe.describe(rec) };
      }
      case 'archiveImages': {
        const [observatory, body] = a;
        if (!observatory || !body || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(body)) throw new Error('observatory=<entity id> and body=<body id, e.g. JUPITER> are required');
        const rec = hub.graph.get(observatory);
        if (!rec) throw new Error(`unknown entity ${observatory}`);
        return { value: await archive.get(rec, body) };
      }
      case 'iss': return { value: { fix: hub.issFix, telemetry: [...hub.telemetry.values()], arrays: hub.issArrays } };
      case 'health': {
        await readEstimate(); // the estimate moves while the app runs
        return { value: { serverTime: Date.now(), entityCount: hub.graph.size, connectors: await hub.healthList(), storage } };
      }
      case 'ascent': return { value: telemetry.series(String(a[0])) ?? null };
      case 'traverse': return { value: (await readTraverse(kv, String(a[0]))) ?? null };
      case 'minorPlanetIndex': return { value: await minorPlanetIndex() };
      case 'minorPlanetChunk': {
        const bytes = await minorPlanetChunk(Number(a[0]));
        return { value: bytes, transfer: [bytes.buffer as ArrayBuffer] };
      }
      case 'minorPlanetsStatus': return { value: mpRun ? mp : await mpStored() };
      case 'minorPlanetsDownload': return { value: await minorPlanetsDownload(a[0]) };
      case 'minorPlanetsCancel':
        mpCtl?.abort(new Error('stopped'));
        return { value: undefined };
      case 'credentials': return { value: await credentialStatus() };
      case 'saveCredentials':
        await credentials.update(a[0]);
        return { value: await credentialStatus() };
      case 'clearCredentials':
        await credentials.update(Object.fromEntries(CREDENTIAL_FIELDS.map((f) => [f.key, null])));
        return { value: await credentialStatus() };
    }
  };

  // ---- startup
  const init = async (): Promise<void> => {
    if (opts.kv) kv = opts.kv;
    else {
      const opened = await openKv();
      kv = opened.kv;
      closeKv = () => (kv as unknown as { close?: () => void }).close?.();
      storage = { persistent: opened.persistent, ...(opened.error ? { error: opened.error } : {}) };
    }
    try {
      // a granted request means the browser will not evict the data under pressure; it is allowed to say no
      const persisted = await opts.storage?.persist();
      if (persisted !== undefined) storage = { ...storage, persisted };
    } catch { /* ignore */ }
    await readEstimate();
    try {
      // the last good CelesTrak and MPCORB downloads are kept at any age (celestrak may stay unreachable for weeks)
      await kv.prune(PRUNE_MAX_AGE_MS, Date.now(), PRUNE_KEEP_PREFIXES);
    } catch (err) {
      console.warn(`[data] startup prune failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    limiter = new Limiter(kv, { withLock });
    http = new Http(kv, { offline: config.offline, fetch: opts.fetch, limiter });
    credentials = new Credentials({
      store: kv, limiter,
      onChange: (r) => {
        // the DISCOS feed shows stub or idle by whether a token is set; the connectors whose settings moved run again at once
        describe.syncHealth().catch(() => undefined);
        r.connectors.forEach((id) => void scheduler.refresh(id));
      },
    });
    describe = new DescribeService({ store: kv, http, config, hub, credentials });
    archive = new ArchiveImagesService({ store: kv, http });
    telemetry = new TelemetryService({ hub, store: kv, refresh: () => { syncLaunchEntities(hub); hub.flush(); } });
    await telemetry.load().catch(() => 0);

    const connectors = opts.connectors?.({ credentials, withLock }) ?? [
      bodies, flightclub, celestrak, createLaunchlibrary(credentials), snapi, surfaceSites, dsn, horizons, horizonsBodies, observatories,
      createMinorPlanets({ withLock, fetch: opts.fetch, minOrbits: opts.minOrbits }), issRest, issLive, createSpacetrack({ credentials, fetch: opts.fetch }), satnogs, notam, webcastOcr,
    ];
    const off = new Set(config.disabledConnectors);
    for (const id of off) Object.assign(hub.healthOf(id), { status: 'disabled', note: 'disabled by configuration' });

    // the first pass reads the cache only: never the network, and no write to the real store
    const roStore = readOnlyKv(kv);
    const hydrateHttp = new Http(roStore, { offline: config.offline, fetch: opts.fetch, cacheOnly: true, limiter: new Limiter(roStore, { withLock }) });
    scheduler = new Scheduler({ hub, config, store: kv, http, hydrate: { http: hydrateHttp, store: roStore } }, connectors.filter((c) => !off.has(c.id)), opts.jitterMs);
    mp = await mpStored();

    listen('entities.changed', (e: { ids: string[]; at: number }) => emitIf({ type: 'entities.changed', ids: e.ids, at: e.at }));
    listen('launches', (launches) => emitIf({ type: 'launches', launches } as WorkerEvent));
    listen('news', (articles) => emitIf({ type: 'news', articles } as WorkerEvent));
    listen('dsn', (snapshot) => emitIf({ type: 'dsn', snapshot } as WorkerEvent));
    listen('iss.fix', (fix) => emitIf({ type: 'iss.fix', fix } as WorkerEvent, 'iss'));
    listen('iss.telemetry', (points) => emitIf({ type: 'iss.telemetry', points } as WorkerEvent, 'iss'));
    listen('iss.arrays', (arrays) => emitIf({ type: 'iss.arrays', arrays } as WorkerEvent, 'iss'));
    listen('health', () => {
      // the same 2 s throttle as the server's stream: a burst of connector runs is one message
      healthTimer ??= setTimeout(() => {
        healthTimer = undefined;
        if (started) void pushHealth();
      }, HEALTH_THROTTLE_MS);
    });

    await scheduler.start();
  };

  const ready = init();
  let fatal = false;
  ready.catch((err) => {
    fatal = true;
    opts.post({ kind: 'fatal', error: err instanceof Error ? err.message : String(err) });
  });

  // ---- one consumer: the page
  const onClient = (msg: ClientMessage): void => {
    if (!Array.isArray(msg?.topics)) return;
    for (const topic of msg.topics.filter((t) => typeof t === 'string' && t.length <= 64)) {
      if (msg.op === 'subscribe' && !topics.has(topic) && topics.size < MAX_TOPICS) {
        topics.add(topic);
        hub.subscribe(topic);
        if (topic === 'iss') {
          if (hub.issFix) emit({ type: 'iss.fix', fix: hub.issFix });
          if (hub.telemetry.size) emit({ type: 'iss.telemetry', points: [...hub.telemetry.values()] });
          if (hub.issArrays) emit({ type: 'iss.arrays', arrays: hub.issArrays });
        }
      } else if (msg.op === 'unsubscribe' && topics.delete(topic)) hub.unsubscribe(topic);
    }
  };

  const releaseTopics = (): void => {
    for (const t of topics) hub.unsubscribe(t);
    topics.clear();
  };

  const dispatch = async (msg: ToWorker): Promise<void> => {
    switch (msg.kind) {
      case 'start':
        started = true;
        emit({ type: 'hello', serverTime: Date.now(), entityCount: hub.graph.size });
        await pushHealth();
        if (hub.launches.length) emit({ type: 'launches', launches: hub.launches });
        if (hub.articles.length) emit({ type: 'news', articles: hub.articles });
        if (hub.dsn.links.length) emit({ type: 'dsn', snapshot: hub.dsn });
        emit({ type: 'minorPlanets', status: mpRun ? mp : await mpStored() });
        return;
      case 'stop':
        started = false;
        releaseTopics();
        return;
      case 'client':
        onClient(msg.msg);
        return;
      case 'rpc': {
        if (!RPC_METHODS.includes(msg.method)) {
          opts.post({ kind: 'result', id: msg.id, ok: false, error: { message: `unknown method ${String(msg.method)}` } });
          return;
        }
        try {
          const r = await call(msg.method, Array.isArray(msg.args) ? msg.args : []);
          opts.post({ kind: 'result', id: msg.id, ok: true, value: r.value }, r.transfer);
        } catch (err) {
          opts.post({ kind: 'result', id: msg.id, ok: false, error: rpcError(err) });
        }
      }
    }
  };

  return {
    ready,
    handle(msg) {
      if (fatal) {
        if (msg.kind === 'rpc') opts.post({ kind: 'result', id: msg.id, ok: false, error: { message: 'the data engine did not start' } });
        return;
      }
      void ready.then(() => dispatch(msg), () => undefined);
    },
    async stop() {
      await ready.catch(() => undefined);
      clearTimeout(healthTimer);
      mpCtl?.abort(new Error('stopped'));
      scheduler?.stop();
      for (const [e, fn] of listeners) hub.off(e, fn as never);
      releaseTopics();
      closeKv?.();
      setUpstreams(prevUpstreams);
      if (opts.appBase !== undefined) setAppBase(prevBase);
    },
  };
}
