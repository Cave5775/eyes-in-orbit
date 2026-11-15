/**
 * Shared cache of heavy assets (parsed 3D models) with reference counts, a byte budget and least-recently-used eviction
 * (pure: the loader and the disposer are passed in, so it is tested without three.js or a network).
 *
 * Why it exists: a detailed model is megabytes of geometry and textures. Thousands of entities can share one model key
 * (every Starlink uses the same bus), so the parsed asset is loaded once and handed out by reference; an asset nobody
 * holds is kept while the budget allows (zooming back in is then instant) and disposed oldest-first when it does not.
 * A failed load is remembered for `retryMs` so a missing file is not requested every frame.
 */

export interface AssetLoad<T> {
  value: T;
  /** approximate memory the asset holds (geometry + textures), bytes; what the budget counts */
  bytes: number;
}

export interface AssetCacheOptions<T> {
  loader: (key: string) => Promise<AssetLoad<T>>;
  /** frees the GPU and CPU memory of an asset that leaves the cache */
  dispose: (value: T, key: string) => void;
  /** total bytes kept; assets held by someone never count against eviction, so the cache may exceed it while in use */
  budgetBytes: number;
  /** how long a failed key is not asked again, ms */
  retryMs?: number;
  now?: () => number;
}

interface Slot<T> {
  state: 'loading' | 'ready' | 'failed';
  value?: T;
  bytes: number;
  refs: number;
  lastUsed: number;
  failedAt?: number;
  error?: unknown;
  /** resolves when the load has ended, whichever way */
  ready: Promise<void>;
  /** the cache disposed or released this while it was loading: dispose it on arrival */
  cancelled?: boolean;
}

export class AssetCache<T> {
  private slots = new Map<string, Slot<T>>();
  private now: () => number;
  private tick = 0;
  private readonly retryMs: number;

  constructor(private readonly o: AssetCacheOptions<T>) {
    this.now = o.now ?? Date.now;
    this.retryMs = o.retryMs ?? 60_000;
  }

  /**
   * Take a reference to `key`. Returns the value when it is loaded, else null and starts (or joins) the load; call
   * `peek` or `acquire` again later (the returned promise resolves when the load ends, for callers that want to wait).
   * Every `acquire` must be matched by one `release`.
   */
  acquire(key: string): { value: T | null; ready: Promise<void> } {
    let s = this.slots.get(key);
    if (s?.state === 'failed' && this.now() - (s.failedAt ?? 0) >= this.retryMs) {
      this.slots.delete(key);
      s = undefined;
    }
    if (!s) s = this.start(key);
    s.refs++;
    s.cancelled = false; // wanted again while it was still loading
    s.lastUsed = ++this.tick;
    return { value: s.state === 'ready' ? (s.value as T) : null, ready: s.ready };
  }

  private start(key: string): Slot<T> {
    const slot: Slot<T> = { state: 'loading', bytes: 0, refs: 0, lastUsed: ++this.tick, ready: Promise.resolve() };
    this.slots.set(key, slot);
    slot.ready = this.o.loader(key).then(
      (r) => {
        slot.bytes = r.bytes;
        if (slot.cancelled || this.slots.get(key) !== slot) {
          this.o.dispose(r.value, key);
          return;
        }
        slot.value = r.value;
        slot.state = 'ready';
        this.evict();
      },
      (err) => {
        slot.state = 'failed';
        slot.failedAt = this.now();
        slot.error = err;
      },
    );
    return slot;
  }

  /** The value of a loaded key without taking a reference or touching recency; null while loading, failed or unknown. */
  peek(key: string): T | null {
    const s = this.slots.get(key);
    return s?.state === 'ready' ? (s.value as T) : null;
  }

  /** `loading`, `ready`, `failed` or `unknown` (for the HUD and tests). */
  stateOf(key: string): 'loading' | 'ready' | 'failed' | 'unknown' {
    return this.slots.get(key)?.state ?? 'unknown';
  }

  /** The error of a failed key, for the log line. */
  errorOf(key: string): unknown {
    return this.slots.get(key)?.error;
  }

  /** Give a reference back; an unreferenced asset stays until the budget needs the room. */
  release(key: string): void {
    const s = this.slots.get(key);
    if (!s || s.refs <= 0) return;
    s.refs--;
    s.lastUsed = ++this.tick;
    if (s.refs === 0 && s.state === 'loading') s.cancelled = true; // nobody wants it any more
    if (s.refs === 0) this.evict();
  }

  /** Bytes held by loaded assets. */
  get bytes(): number {
    let n = 0;
    for (const s of this.slots.values()) if (s.state === 'ready') n += s.bytes;
    return n;
  }

  /** Dispose unreferenced assets, least recently used first, until the loaded bytes fit the budget. */
  private evict(): void {
    let total = this.bytes;
    if (total <= this.o.budgetBytes) return;
    const idle = [...this.slots.entries()].filter(([, s]) => s.state === 'ready' && s.refs === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, s] of idle) {
      if (total <= this.o.budgetBytes) break;
      total -= s.bytes;
      this.slots.delete(key);
      this.o.dispose(s.value as T, key);
    }
  }

  /** Dispose everything, held or not (the scene is going away). A load still running disposes its result on arrival. */
  clear(): void {
    for (const [key, s] of this.slots) {
      if (s.state === 'ready') this.o.dispose(s.value as T, key);
      else s.cancelled = true;
    }
    this.slots.clear();
  }
}
