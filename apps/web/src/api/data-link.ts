import type { FromWorker, RpcArgs, RpcMethod, RpcResult, ToWorker, WorkerEvent } from '../workers/data.protocol';

/** The part of a `Worker` (or a test's fake port) the link uses. */
export interface PortLike {
  postMessage(msg: ToWorker): void;
  onmessage: ((ev: { data: FromWorker }) => void) | null;
  onerror?: ((ev: { message?: string }) => void) | null;
  /** a message from the worker that could not be deserialized */
  onmessageerror?: ((ev: unknown) => void) | null;
  terminate?(): void;
}

/** An RPC the engine refused; `limited` and `retryAt` are set when its request limiter said no. */
export class RpcFailure extends Error {
  constructor(message: string, readonly detail: { name?: string; limited?: boolean; retryAt?: number } = {}) {
    super(message);
    this.name = detail.name ?? 'RpcFailure';
  }
}

/**
 * How long each call may take before it fails (the old REST client's limits, 4 to 120 s). `health` is also the first call after
 * the worker starts, which waits for the engine to open its store and read every cache. A method not listed never times out:
 * `minorPlanetsDownload` reports its progress through the status messages and can take minutes.
 */
export const RPC_TIMEOUT_MS: Partial<Record<RpcMethod, number>> = {
  entities: 60_000, search: 8_000, match: 15_000, launches: 20_000, news: 20_000, dsn: 20_000, describe: 30_000, archiveImages: 30_000,
  iss: 20_000, health: 30_000, ascent: 8_000, traverse: 15_000, minorPlanetIndex: 15_000, minorPlanetChunk: 120_000,
  minorPlanetsStatus: 8_000, minorPlanetsCancel: 8_000, credentials: 8_000, saveCredentials: 8_000, clearCredentials: 8_000,
};

/**
 * The page's end of the data worker: numbered RPC calls with their answers, and the pushed events. One link is shared by the Api
 * (`worker-api.ts`) and the stream (`worker-stream.ts`).
 */
export class DataLink {
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer?: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(msg: WorkerEvent) => void>();
  private deadListeners = new Set<(reason: string) => void>();
  private up = false;
  private dead: string | undefined;
  /** resolves when the worker script has started, rejects when it could not (or the engine inside it did not start) */
  readonly ready: Promise<void>;
  private settle!: { resolve(): void; reject(e: Error): void };

  constructor(private port: PortLike) {
    this.ready = new Promise<void>((resolve, reject) => (this.settle = { resolve, reject }));
    this.ready.catch(() => undefined);
    port.onmessage = (ev) => this.onMessage(ev.data);
    // an error event after start (an exception in a handler) leaves the engine running: it is logged, not fatal. Before the
    // worker said `ready` it means the script itself did not load.
    port.onerror = (ev) => {
      if (!this.up) this.die(ev.message || 'the data worker failed to load');
      else console.warn(`[eio] data worker error: ${ev.message ?? 'unknown'}`);
    };
    // a result that could not be read cannot be matched to its call: every call in flight fails rather than waits
    port.onmessageerror = () => this.failPending('a message from the data worker could not be read');
  }

  /** Called once when the link is dead for good (the engine said so, the script failed to load, or `close`). */
  onDead(fn: (reason: string) => void): () => void {
    if (this.dead) fn(this.dead);
    else this.deadListeners.add(fn);
    return () => this.deadListeners.delete(fn);
  }

  private failPending(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(reason));
    }
  }

  call<M extends RpcMethod>(method: M, ...args: RpcArgs<M>): Promise<RpcResult<M>> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = this.nextId++;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const entry: { resolve(v: unknown): void; reject(e: Error): void; timer?: ReturnType<typeof setTimeout> } = { resolve: resolve as (v: unknown) => void, reject };
      const ms = RPC_TIMEOUT_MS[method];
      if (ms !== undefined) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`${method} did not answer within ${ms / 1000} s`));
        }, ms);
      }
      this.pending.set(id, entry);
      try {
        this.port.postMessage({ kind: 'rpc', id, method, args });
      } catch (err) {
        // the arguments could not be cloned: this call fails, the link stays up
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  send(msg: ToWorker): void {
    if (this.dead) return;
    try {
      this.port.postMessage(msg);
    } catch (err) {
      console.warn(`[eio] could not send to the data worker: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onEvent(fn: (msg: WorkerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.die('the data worker was closed');
    this.port.terminate?.();
  }

  private onMessage(m: FromWorker): void {
    if (m.kind === 'ready') {
      this.up = true;
      this.settle.resolve();
    }
    else if (m.kind === 'fatal') this.die(m.error);
    else if (m.kind === 'event') for (const fn of [...this.listeners]) fn(m.msg);
    else if (m.kind === 'result') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.value);
      else p.reject(new RpcFailure(m.error.message, m.error));
    }
  }

  private die(reason: string): void {
    if (this.dead) return;
    this.dead = reason;
    this.settle.reject(new Error(reason));
    this.failPending(reason);
    for (const fn of [...this.deadListeners]) fn(reason);
    this.deadListeners.clear();
  }
}
