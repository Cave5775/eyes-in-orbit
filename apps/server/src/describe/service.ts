import { composeFallback, type ConnectorHealth, type Description, type DescribeSourceState, type EntityRecord } from '@eio/core';
import { isBackedOff, readBackoff, recordFailure, clearBackoff } from '../backoff';
import type { Config } from '../config';
import type { Http } from '../http';
import { HttpError } from '../http';
import type { Hub } from '../hub';
import { isFresh, type Store } from '../store';
import {
  discosHeaders, discosUrl, parseDiscos, parseWikidataEntities, parseWikidataNameSearch, parseWikidataSearch, parseWikipediaSummary,
  pickWikidataItem, uniqueSpaceCandidate, wikidataEntitiesUrl, wikidataNameSearchUrl, wikidataSearchUrl, wikidataUrl, wikipediaSearchUrl,
  wikipediaSummaryUrl, type DiscosObject, type WikipediaSummary,
} from './sources';

/** Cache lifetimes: a description changes rarely; a miss is retried weekly (a Wikipedia article may appear); a lookup that hit an error soon. */
export const HIT_TTL_MS = 30 * 86_400_000;
export const MISS_TTL_MS = 7 * 86_400_000;
export const ERROR_TTL_MS = 10 * 60_000;
const CACHE_VERSION = 'v1';

/** Health ids: Wikidata and Wikipedia share one feed (one rate limit, one failure gate); DISCOS has its own. */
export const WIKI_FEED = 'wikipedia';
export const DISCOS_FEED = 'discos';

export interface DescribeOptions {
  /** minimum ms between two requests to the same source */
  spacingMs?: { wikipedia: number; discos: number };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const NOTE_WIKI = 'On demand: Wikidata and Wikipedia are asked about an object only when its About tab is open; answers are cached 30 days (misses 7).';
const NOTE_DISCOS = 'On demand: ESA DISCOS is asked about an object only when its About tab is open; answers are cached 30 days.';

const noradOf = (rec: EntityRecord): number | undefined => {
  const n = Number(rec.aliases?.norad);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** Most requests that may wait for one source; further lookups answer "busy" at once and are not cached. */
export const MAX_QUEUE = 50;

/** The source's queue is full. */
class BusyError extends Error {
  constructor() {
    super('busy: too many lookups queued for this source');
  }
}

/** The persistent failure gate closed while a request waited in the queue. */
class GateError extends Error {}

/** Runs tasks one after another with a minimum gap, so a burst of selections never becomes a burst of requests. */
class Spacer {
  private tail: Promise<unknown> = Promise.resolve();
  private last = 0;
  private pending = 0;
  constructor(private gapMs: number, private sleep: (ms: number) => Promise<void>, private now: () => number, private maxPending = MAX_QUEUE) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maxPending) return Promise.reject(new BusyError());
    this.pending++;
    const p = this.tail.then(async () => {
      const wait = this.last + this.gapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await fn();
      } finally {
        this.last = this.now();
      }
    }).finally(() => void this.pending--);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

interface SourceResult<T> {
  state: DescribeSourceState;
  value?: T;
  /** the source's queue was full: nothing was asked, nothing may be cached */
  busy?: boolean;
}

/**
 * Descriptions on demand. `describe(entity)` returns the cached description or runs the lookup chain
 * (Wikidata item -> Wikipedia summary, plus DISCOS facts with a token). Scalability rules: nothing runs unless a client
 * asks for one object; concurrent asks for the same object share one lookup; each source has a request gap and a
 * persistent failure gate (`backoff.ts`); results, including "nothing found", are cached in SQLite.
 */
export class DescribeService {
  private inflight = new Map<string, Promise<Description>>();
  /** descriptions that must not be cached (a source was busy) */
  private uncached = new WeakSet<Description>();
  private lastToken: string | undefined;
  /** when the DISCOS token last changed; cached DISCOS errors older than this are asked again */
  private tokenChangedAt = 0;
  private wiki: Spacer;
  private discos: Spacer;
  private now: () => number;

  constructor(private deps: { store: Store; http: Http; config: Config; hub: Hub }, opts: DescribeOptions = {}) {
    const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.wiki = new Spacer(opts.spacingMs?.wikipedia ?? 600, sleep, this.now);
    this.discos = new Spacer(opts.spacingMs?.discos ?? 3000, sleep, this.now);
    const offline = this.deps.config.offline;
    Object.assign(deps.hub.healthOf(WIKI_FEED), { note: NOTE_WIKI, ...(offline ? { offline: true } : {}) });
    this.syncHealth();
  }

  /** Make the DISCOS feed show `stub` (needs credentials) or `idle` according to whether a token is set; call after credential changes. */
  syncHealth(): void {
    const token = this.deps.config.discosToken;
    if (token !== this.lastToken) {
      if (this.lastToken !== undefined || token) this.tokenChangedAt = this.now();
      this.lastToken = token;
    }
    const h = this.deps.hub.healthOf(DISCOS_FEED);
    if (this.deps.config.offline) h.offline = true;
    if (!this.deps.config.discosToken) {
      Object.assign(h, { status: 'stub', note: 'Needs a DISCOS API token (DISCOS_TOKEN or the Keys section here); without one DISCOS is skipped.' });
    } else if (h.status === 'stub') {
      Object.assign(h, { status: 'idle', note: NOTE_DISCOS });
    }
  }

  describe(rec: EntityRecord): Promise<Description> {
    const pending = this.inflight.get(rec.id);
    if (pending) return pending;
    const p = this.load(rec).finally(() => this.inflight.delete(rec.id));
    this.inflight.set(rec.id, p);
    return p;
  }

  private cacheKey = (id: string): string => `describe:${CACHE_VERSION}:${id}`;

  private async load(rec: EntityRecord): Promise<Description> {
    const { store, config } = this.deps;
    const key = this.cacheKey(rec.id);
    const row = store.get<Description>(key);
    if (row) {
      const s = row.value.sources.discos;
      // a token that is set now but was missing (off) or rejected (error) when this was cached: ask DISCOS again
      const tokenRetry = !!config.discosToken && noradOf(rec) !== undefined && (s === 'off' || (s === 'error' && row.fetchedAt < this.tokenChangedAt));
      if ((isFresh(row, this.now()) && !tokenRetry) || config.offline) return { ...row.value, fromCache: true };
    }
    this.syncHealth();
    const d = await this.lookup(rec);
    // an OFFLINE answer is only the fallback line: caching it would hide the real description once the network is back
    if (config.offline || this.uncached.has(d)) return d;
    const found = !!(d.summary || d.discos);
    const failed = Object.values(d.sources).includes('error');
    store.set(key, d, failed ? ERROR_TTL_MS : found ? HIT_TTL_MS : MISS_TTL_MS, this.now());
    return d;
  }

  private async lookup(rec: EntityRecord): Promise<Description> {
    const norad = noradOf(rec);
    const cospar = rec.aliases?.cospar;
    const d: Description = {
      entityId: rec.id,
      ...(norad !== undefined ? { norad } : {}),
      fallback: composeFallback(rec),
      searchUrl: wikipediaSearchUrl(rec.name),
      sources: { wikidata: 'miss', wikipedia: 'miss', discos: 'off' },
      fetchedAt: this.now(),
    };
    if (this.deps.config.offline) {
      d.sources = { wikidata: 'off', wikipedia: 'off', discos: 'off' };
      return d;
    }

    // Wikidata item, then its English Wikipedia article (bodies skip Wikidata: their name is the article title)
    let title: string | undefined;
    if (rec.id.startsWith('body-')) {
      title = rec.name;
      d.sources.wikidata = 'off';
    } else if (norad === undefined && rec.kind !== 'probe') {
      d.sources.wikidata = 'off'; // no catalogue number and not a probe: a name search would only guess
    } else {
      const wd = await this.wikidataItem(rec, norad, cospar);
      d.sources.wikidata = wd.state;
      if (wd.busy) this.uncached.add(d);
      if (wd.value) {
        d.wikidata = { id: wd.value.id, url: wikidataUrl(wd.value.id), ...(wd.value.label ? { label: wd.value.label } : {}) };
        title = wd.value.enwiki;
      }
    }
    if (title) {
      const wp = await this.source(WIKI_FEED, () => this.fetchSummary(title!));
      d.sources.wikipedia = wp.state;
      if (wp.busy) this.uncached.add(d);
      if (wp.value) d.summary = wp.value;
    }

    if (norad !== undefined && this.deps.config.discosToken) {
      const token = this.deps.config.discosToken;
      const ds = await this.source(DISCOS_FEED, async () => {
        const text = await this.get(DISCOS_FEED, this.discos, discosUrl(norad), discosHeaders(token));
        return parseDiscos(text);
      });
      d.sources.discos = ds.state;
      if (ds.busy) this.uncached.add(d);
      if (ds.value) d.discos = ds.value;
    }
    return d;
  }

  private async fetchSummary(title: string): Promise<WikipediaSummary | null> {
    try {
      return parseWikipediaSummary(await this.get(WIKI_FEED, this.wiki, wikipediaSummaryUrl(title)));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /** Item for the entity: by NORAD number when it has one, else by exact English label if exactly one spacecraft matches. */
  private async wikidataItem(rec: EntityRecord, norad: number | undefined, cospar: string | undefined) {
    return this.source(WIKI_FEED, async () => {
      let ids: string[];
      if (norad !== undefined) {
        ids = parseWikidataSearch(await this.get(WIKI_FEED, this.wiki, wikidataSearchUrl(norad)));
      } else {
        const cand = uniqueSpaceCandidate(parseWikidataNameSearch(await this.get(WIKI_FEED, this.wiki, wikidataNameSearchUrl(rec.name))), rec.name);
        ids = cand ? [cand.id] : [];
      }
      if (!ids.length) return null;
      const items = parseWikidataEntities(await this.get(WIKI_FEED, this.wiki, wikidataEntitiesUrl(ids)));
      return pickWikidataItem(items, { name: rec.name, cospar, norad });
    });
  }

  /** One request, queued behind the source's earlier ones so they are at least the configured gap apart. */
  private get(feed: string, spacer: Spacer, url: string, headers?: Record<string, string>): Promise<string> {
    return spacer.run(async () => {
      // the gate may have closed while this request waited behind others
      const gate = readBackoff(this.deps.store, `describe:${feed}`);
      if (isBackedOff(gate, this.now())) throw new GateError(gate.message);
      return this.deps.http.text(url, headers);
    });
  }

  /**
   * One gated call to a source: honours the persistent failure gate, spaces requests, and keeps the feed's health record.
   * `null` from `fn` is a clean miss; a throw is an error (not cached for long, gate closed per `backoff.ts`).
   */
  private async source<T>(feed: string, fn: () => Promise<T | null>): Promise<SourceResult<T>> {
    const { store, hub } = this.deps;
    const h = hub.healthOf(feed);
    const gate = readBackoff(store, `describe:${feed}`);
    if (isBackedOff(gate, this.now())) {
      const until = new Date(gate.notBefore).toISOString().slice(11, 16);
      this.fail(h, `${gate.message} (waiting until ${until}Z)`);
      return { state: 'error' };
    }
    try {
      const value = await fn();
      clearBackoff(store, `describe:${feed}`);
      this.ok(h);
      return value === null ? { state: 'miss' } : { state: 'ok', value };
    } catch (err) {
      if (err instanceof BusyError) {
        return { state: 'error', busy: true };
      }
      if (err instanceof GateError) {
        this.fail(h, err.message);
        return { state: 'error' };
      }
      recordFailure(store, `describe:${feed}`, err, this.now());
      this.fail(h, (err as Error).message);
      return { state: 'error' };
    }
  }

  private ok(h: ConnectorHealth): void {
    Object.assign(h, { status: 'ok', lastOkAt: this.now(), runs: h.runs + 1, failures: 0, lastError: undefined });
  }

  private fail(h: ConnectorHealth, message: string): void {
    // a lookup that failed after an earlier success keeps `ok` (orange with the error), like a connector's softFail
    Object.assign(h, {
      status: h.lastOkAt !== undefined ? 'ok' : 'error', lastError: message, lastErrorAt: this.now(), runs: h.runs + 1, failures: (h.failures ?? 0) + 1,
    });
  }
}
