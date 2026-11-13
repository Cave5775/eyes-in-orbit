import type { ConnectorHealth } from '@eio/core';
import type { Config } from './config';
import type { Cached, Http, RequestOptions } from './http';
import { LimitedError } from './net/limiter';
import { FEED_SOURCE } from './net/limits';
import type { Hub } from './hub';
import type { Store } from './store';

export interface ConnectorContext {
  hub: Hub;
  config: Config;
  store: Store;
  http: Http;
  /** this connector's mutable health record */
  health: ConnectorHealth;
  log(msg: string): void;
  /** report a partial failure: the run still counts as ok but is retried sooner than the normal interval */
  softFail(msg: string, retryInMs?: number): void;
  /** `http.cachedFetch` that also records cache usage in the health record */
  cachedFetch<T>(key: string, url: string, ttlMs: number, parse: (text: string) => T, headers?: Record<string, string>, ro?: CachedFetchOptions): Promise<Cached<T>>;
}

/** Request options plus `staleRetryMs`: how soon a run that fell back to a stale copy is retried (default 5 min; at least the limiter's retry time when a limit applies). */
export interface CachedFetchOptions extends RequestOptions {
  staleRetryMs?: number;
}

export interface Connector {
  readonly id: string;
  /** ms between runs (measured from the end of the previous run); omit to run once */
  readonly intervalMs?: number;
  /** ms before the first run (a random 0-1 s is added) */
  readonly startDelayMs?: number;
  /** only run while this WS topic has subscribers */
  readonly topic?: string;
  /** false for connectors that never use the network (they still run when OFFLINE=1) */
  readonly network?: boolean;
  /** report a fixed `stub` status (with the returned note) and never run; return undefined when the connector can run */
  stub?(config: Config): string | undefined;
  /** called once at startup (register static entities, timers) */
  start?(ctx: ConnectorContext): void | Promise<void>;
  /** one poll; throw to report an error and back off */
  run?(ctx: ConnectorContext): Promise<void>;
  stop?(): void;
}

const MAX_BACKOFF_MS = 15 * 60_000;
const STALE_RETRY_MS = 5 * 60_000;

interface Slot {
  connector: Connector;
  ctx: ConnectorContext;
  timer?: NodeJS.Timeout;
  failures: number;
  running: boolean;
  stopped: boolean;
  /** waiting for topic subscribers */
  gated: boolean;
  /** last run fell back to a stale cache entry */
  stale: boolean;
  /** retry delay requested by `softFail` or a stale-cache fallback */
  retryInMs?: number;
  /** cachedFetch calls so far in the current run */
  fetches: number;
  /** the run was refused by the request limiter: do not run again before this time */
  limitedUntil?: number;
}

/** Runs connectors on their own timers with jittered starts, exponential backoff and health records. */
export class Scheduler {
  private slots = new Map<string, Slot>();
  private healthTimer?: NodeJS.Timeout;

  constructor(
    private deps: { hub: Hub; config: Config; store: Store; http: Http },
    connectors: Connector[],
    private jitterMs = 1000,
  ) {
    for (const connector of connectors) {
      const health = deps.hub.healthOf(connector.id);
      if (deps.config.offline && connector.network !== false) health.offline = true;
      const slot: Slot = {
        connector, failures: 0, running: false, stopped: false, gated: false, stale: false, fetches: 0,
        ctx: {
          ...deps, health,
          log: (msg) => console.log(`[${connector.id}] ${msg}`),
          softFail: (msg, retryInMs) => {
            slot.stale = true;
            slot.retryInMs = Math.min(slot.retryInMs ?? Infinity, retryInMs ?? STALE_RETRY_MS);
            health.lastError = msg;
            health.lastErrorAt = Date.now();
          },
          cachedFetch: async (key, url, ttl, parse, headers, ro) => {
            const res = await deps.http.cachedFetch(key, url, ttl, parse, headers, ro);
            // true only when every response of this run came from the cache
            health.fromCache = slot.fetches++ === 0 ? res.fromCache : !!health.fromCache && res.fromCache;
            // a stale copy is served; a limited request is retried when the limiter allows it, a failed one after `staleRetryMs`
            if (res.stale) slot.ctx.softFail(res.error ?? 'serving stale cache', res.limitedUntil !== undefined ? Math.max(res.limitedUntil - Date.now(), 1000) : ro?.staleRetryMs);
            return res;
          },
        },
      };
      this.slots.set(connector.id, slot);
    }
    // the health records show each feed's request budget and block time from the limiter
    deps.hub.limitOf = (id) => (FEED_SOURCE[id] ? deps.http.limiter.status(FEED_SOURCE[id]) : undefined);
    deps.hub.on('topic', ({ topic, count }: { topic: string; count: number }) => {
      if (count !== 1) return;
      for (const s of this.slots.values()) if (s.gated && s.connector.topic === topic) this.kick(s.connector.id);
    });
  }

  async start(): Promise<void> {
    for (const slot of this.slots.values()) {
      const { connector, ctx } = slot;
      const stubNote = connector.stub?.(this.deps.config);
      if (stubNote) {
        Object.assign(ctx.health, { status: 'stub', note: stubNote });
        continue;
      }
      try {
        await connector.start?.(ctx);
      } catch (err) {
        this.fail(slot, err);
      }
      if (connector.run) this.schedule(slot, (connector.startDelayMs ?? 0) + Math.random() * this.jitterMs);
    }
    this.healthTimer = setInterval(() => this.deps.hub.emit('health', this.deps.hub.healthList()), 30_000);
  }

  stop(): void {
    clearInterval(this.healthTimer);
    for (const s of this.slots.values()) {
      s.stopped = true;
      clearTimeout(s.timer);
      s.connector.stop?.();
    }
  }

  /**
   * Re-evaluate a connector after its configuration (credentials) changed: a stub becomes runnable, or the other way
   * round; one that was stubbed or failing runs right away so the new values are tried at once.
   */
  async refresh(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot || slot.stopped) return;
    const { connector, ctx } = slot;
    const wasStub = ctx.health.status === 'stub';
    const stubNote = connector.stub?.(this.deps.config);
    if (stubNote) {
      clearTimeout(slot.timer);
      Object.assign(ctx.health, { status: 'stub', note: stubNote, nextRunAt: undefined });
    } else if (wasStub || ctx.health.status === 'error') {
      if (wasStub) {
        Object.assign(ctx.health, { status: 'idle', note: undefined });
        try {
          await connector.start?.(ctx);
        } catch (err) {
          this.fail(slot, err);
        }
      }
      if (connector.run) this.schedule(slot, 0);
    }
    this.deps.hub.emit('health', this.deps.hub.healthList());
  }

  /** Run a connector as soon as possible (used when its topic gains a subscriber). */
  kick(id: string): void {
    const slot = this.slots.get(id);
    if (slot && !slot.running && !slot.stopped && slot.connector.run) this.schedule(slot, 0);
  }

  private schedule(slot: Slot, delayMs: number): void {
    clearTimeout(slot.timer);
    slot.ctx.health.nextRunAt = Date.now() + delayMs;
    slot.timer = setTimeout(() => void this.runOnce(slot), delayMs);
  }

  private async runOnce(slot: Slot): Promise<void> {
    const { connector, ctx } = slot;
    const { hub, config } = this.deps;
    if (slot.stopped || slot.running) return;
    slot.gated = !!connector.topic && hub.subscribers(connector.topic) === 0;
    if (slot.gated) {
      Object.assign(ctx.health, { status: 'idle', note: `waiting for subscribers to "${connector.topic}"`, nextRunAt: undefined });
      return;
    }
    slot.running = true;
    const before = `${ctx.health.status}|${ctx.health.lastError}`;
    slot.stale = false;
    slot.retryInMs = undefined;
    slot.fetches = 0;
    slot.limitedUntil = undefined;
    ctx.health.fromCache = false;
    ctx.health.note = undefined;
    ctx.health.runs++;
    try {
      await connector.run!(ctx);
      slot.failures = 0;
      Object.assign(ctx.health, { status: 'ok', lastOkAt: Date.now(), failures: 0 });
      if (!slot.stale) ctx.health.lastError = undefined;
    } catch (err) {
      if (err instanceof LimitedError) this.limited(slot, err);
      else this.fail(slot, err);
    }
    slot.running = false;
    // fast pollers (iss-rest every 2 s) only announce health when it changes
    if ((connector.intervalMs ?? Infinity) >= 30_000 || before !== `${ctx.health.status}|${ctx.health.lastError}`) {
      hub.emit('health', hub.healthList());
    }

    const offlineDone = config.offline && connector.network !== false;
    if (offlineDone) {
      if (ctx.health.status === 'error') Object.assign(ctx.health, { status: 'disabled', note: 'OFFLINE=1 and nothing cached' });
      ctx.health.nextRunAt = undefined;
    } else if (!slot.stopped && connector.intervalMs !== undefined) {
      this.schedule(slot, this.nextDelay(slot));
    } else ctx.health.nextRunAt = undefined;
  }

  private fail(slot: Slot, err: unknown): void {
    slot.failures++;
    const msg = err instanceof Error ? err.message : String(err);
    Object.assign(slot.ctx.health, { status: 'error', lastError: msg, lastErrorAt: Date.now(), failures: slot.failures });
    slot.ctx.log(`error: ${msg}`);
  }

  /**
   * The request limiter refused this run: nothing was sent. A spacing gap only waits (no error); a cap or block shows as an
   * orange "rate limited until" (the feed keeps `ok` when it has delivered data before). Not a failure for the backoff.
   */
  private limited(slot: Slot, err: LimitedError): void {
    const { health } = slot.ctx;
    slot.limitedUntil = err.retryAt;
    if (err.kind === 'spacing') {
      health.note = `waiting for the request spacing (${err.reason})`;
      return;
    }
    Object.assign(health, {
      status: health.lastOkAt !== undefined ? 'ok' : 'error', lastError: err.message, lastErrorAt: Date.now(), failures: health.failures ?? 0,
    });
    slot.ctx.log(err.message);
  }

  private nextDelay(slot: Slot): number {
    if (slot.limitedUntil !== undefined) return Math.max(slot.limitedUntil - Date.now(), 1000);
    const interval = slot.connector.intervalMs!;
    if (!slot.failures) return slot.stale ? Math.min(interval, slot.retryInMs ?? STALE_RETRY_MS) : interval;
    const base = Math.min(Math.max(interval, 1000), 30_000);
    const cap = interval < 60_000 ? 60_000 : Math.min(interval, MAX_BACKOFF_MS);
    return Math.min(base * 2 ** (slot.failures - 1), cap) * (0.9 + Math.random() * 0.2);
  }
}
