import type { FromWorker, RpcArgs, RpcMethod, RpcResult, ToWorker, WorkerEvent } from '../workers/data.protocol';

/** The part of a `Worker` (or a test's fake port) the link uses. */
export interface PortLike {
  postMessage(msg: ToWorker): void;
  onmessage: ((ev: { data: FromWorker }) => void) | null;
  onerror?: ((ev: { message?: string }) => void) | null;
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
 * The page's end of the data worker: numbered RPC calls with their answers, and the pushed events. One link is shared by the Api
 * (`worker-api.ts`) and the stream (`worker-stream.ts`).
 */
export class DataLink {
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private listeners = new Set<(msg: WorkerEvent) => void>();
  private dead: string | undefined;
  /** resolves when the worker script has started, rejects when it could not (or the engine inside it did not start) */
  readonly ready: Promise<void>;
  private settle!: { resolve(): void; reject(e: Error): void };

  constructor(private port: PortLike) {
    this.ready = new Promise<void>((resolve, reject) => (this.settle = { resolve, reject }));
    this.ready.catch(() => undefined);
    port.onmessage = (ev) => this.onMessage(ev.data);
    port.onerror = (ev) => this.die(ev.message || 'the data worker failed');
  }

  call<M extends RpcMethod>(method: M, ...args: RpcArgs<M>): Promise<RpcResult<M>> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = this.nextId++;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ kind: 'rpc', id, method, args });
    });
  }

  send(msg: ToWorker): void {
    if (!this.dead) this.port.postMessage(msg);
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
    if (m.kind === 'ready') this.settle.resolve();
    else if (m.kind === 'fatal') this.die(m.error);
    else if (m.kind === 'event') for (const fn of [...this.listeners]) fn(m.msg);
    else if (m.kind === 'result') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new RpcFailure(m.error.message, m.error));
    }
  }

  private die(reason: string): void {
    if (this.dead) return;
    this.dead = reason;
    this.settle.reject(new Error(reason));
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
}
