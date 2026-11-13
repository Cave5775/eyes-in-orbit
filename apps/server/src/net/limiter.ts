import type { FeedLimit } from '@eio/core';
import type { Store } from '../store';
import { LIMITS, type SourceLimit } from './limits';

/**
 * The persistent request limiter. Every outgoing request to a data source passes through `acquire` first (see
 * `guarded-fetch.ts`). State lives in the SQLite kv (`limit:<source>`) and is written BEFORE the request is sent, so a
 * crash still counts the attempt and a restart never resets spacing, counters or blocks.
 *
 *  - spacing: `nextAllowedAt`, set to now + the minimum gap on every attempt
 *  - caps: fixed minute / hour / day windows counted per attempt
 *  - block: `blockedUntil`, set from 403/429/503 answers, Retry-After, X-Rate-Limit headers, repeated failures and backoff
 *
 * Callers choose a mode. `poll` (scheduled connectors) may sit out a short spacing gap and otherwise reschedules to
 * `retryAt`; `demand` (a user opened the About tab, searched news, asked for a tile) never waits unless the caller allows
 * a bounded `waitMs`, and never queues: it answers `limited` at once so the caller can use its cache.
 */
export type LimitMode = 'poll' | 'demand';

type Counter = { start: number; count: number };

export interface LimitState {
  nextAllowedAt: number;
  minute?: Counter;
  hour?: Counter;
  day?: Counter;
  demandHour?: Counter;
  blockedUntil?: number;
  blockReason?: string;
  /** timestamps of recent failed answers (for `failureStop`) */
  failures?: number[];
  consecutiveFailures?: number;
}

export type LimitKind = 'spacing' | 'cap' | 'blocked';

export type AcquireResult =
  | { ok: true }
  | { limited: true; retryAt: number; reason: string; kind: LimitKind };

export const hhmmz = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + 'Z';

/** Thrown by `Http` when a request was not sent because a limit applies. The message is what the health record shows. */
export class LimitedError extends Error {
  constructor(readonly source: string, readonly retryAt: number, readonly reason: string, readonly kind: LimitKind = 'cap') {
    super(`rate limited until ${hhmmz(retryAt)} (${reason})`);
    this.name = 'LimitedError';
  }
}

const STATE_TTL_MS = 7 * 86_400_000;
const MAX_RETRY_AFTER_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const WINDOW_MS = { minute: 60_000, hour: HOUR_MS, day: 24 * HOUR_MS, demandHour: HOUR_MS } as const;
type WindowName = keyof typeof WINDOW_MS;
export const limitKey = (source: string): string => `limit:${source}`;

/** `Retry-After`: seconds or an HTTP date. ms from `now`, or undefined. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * `X-Rate-Limit-*` / `X-RateLimit-*` headers (wheretheiss.at sends them): when no requests remain, ms until the window
 * resets (`-Reset` as epoch seconds or as a number of seconds), else 60 s. undefined while requests remain.
 */
export function parseRateLimitHeaders(get: (name: string) => string | null | undefined, now: number): number | undefined {
  const pick = (suffix: string) => get(`x-rate-limit-${suffix}`) ?? get(`x-ratelimit-${suffix}`);
  const remaining = pick('remaining');
  if (remaining === null || remaining === undefined || remaining.trim() === '' || !Number.isFinite(Number(remaining)) || Number(remaining) > 0) return undefined;
  const reset = Number(pick('reset'));
  if (!Number.isFinite(reset) || reset <= 0) return 60_000;
  const ms = reset > 1e9 ? reset * 1000 - now : reset * 1000;
  return Math.min(Math.max(ms, 1000), MAX_RETRY_AFTER_MS);
}

export interface ReportInput {
  /** HTTP status; undefined for a network failure */
  status?: number;
  headers?: { get(name: string): string | null };
  /** the request failed before an answer (timeout, reset, DNS) */
  networkError?: boolean;
}

export interface LimiterOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** replaces the table (tests); a source missing from it is unlimited */
  limits?: Record<string, SourceLimit>;
}

export class Limiter {
  private now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  private limits: Record<string, SourceLimit>;

  constructor(private store: Store, opts: LimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.limits = opts.limits ?? LIMITS;
  }

  limitOf(source: string): SourceLimit | undefined {
    return this.limits[source];
  }

  state(source: string): LimitState {
    return this.store.get<LimitState>(limitKey(source))?.value ?? { nextAllowedAt: 0 };
  }

  private save(source: string, s: LimitState): void {
    this.store.set(limitKey(source), s, STATE_TTL_MS, this.now());
  }

  /** A copy of the state without windows that rolled over and without a block that ended. */
  private rolled(s: LimitState, now: number): LimitState {
    const out = { ...s };
    for (const name of Object.keys(WINDOW_MS) as WindowName[]) {
      const w = out[name];
      if (w && now - w.start >= WINDOW_MS[name]) delete out[name];
    }
    if (out.blockedUntil !== undefined && out.blockedUntil <= now) {
      delete out.blockedUntil;
      delete out.blockReason;
    }
    return out;
  }

  /** One attempt: decide, and when allowed count it and persist BEFORE the caller sends anything. */
  tryAcquire(source: string, mode: LimitMode, commit = true): AcquireResult {
    const lim = this.limits[source];
    if (!lim) return { ok: true };
    const now = this.now();
    const s = this.rolled(this.state(source), now);
    if (s.blockedUntil !== undefined) return { limited: true, retryAt: s.blockedUntil, reason: s.blockReason ?? 'blocked by the source', kind: 'blocked' };
    const capped = (name: WindowName, cap: number | undefined, label: string): AcquireResult | undefined => {
      const w = s[name];
      if (cap === undefined || !w || w.count < cap) return undefined;
      return { limited: true, retryAt: w.start + WINDOW_MS[name], reason: `${label} cap of ${cap} reached`, kind: 'cap' };
    };
    const hit = capped('minute', lim.perMinute, 'per-minute') ?? capped('hour', lim.perHour, 'hourly') ?? capped('day', lim.perDay, 'daily')
      ?? (mode === 'demand' ? capped('demandHour', lim.demandPerHour, 'hourly lookup') : undefined);
    if (hit) return hit;
    if (s.nextAllowedAt > now) {
      return { limited: true, retryAt: s.nextAllowedAt, reason: `${Math.round(lim.minSpacingMs / 100) / 10} s spacing`, kind: 'spacing' };
    }
    if (!commit) return { ok: true };
    const bump = (name: WindowName): void => {
      const w = s[name];
      s[name] = w ? { start: w.start, count: w.count + 1 } : { start: now, count: 1 };
    };
    if (lim.perMinute) bump('minute');
    if (lim.perHour) bump('hour');
    if (lim.perDay) bump('day');
    if (mode === 'demand' && lim.demandPerHour) bump('demandHour');
    s.nextAllowedAt = now + lim.minSpacingMs;
    this.save(source, s);
    return { ok: true };
  }

  /** Would an attempt be allowed now? Counts nothing (Space-Track checks its query before it logs in). */
  peek(source: string, mode: LimitMode): AcquireResult {
    return this.tryAcquire(source, mode, false);
  }

  /**
   * `tryAcquire` with a bounded wait for the spacing gap: a `poll` caller waits up to the source's `maxWaitMs`
   * (default 15 s), a `demand` caller only `waitMs` (default 0). Caps and blocks never wait.
   */
  async acquire(source: string, mode: LimitMode, waitMs?: number): Promise<AcquireResult> {
    const maxWait = waitMs ?? (mode === 'poll' ? this.limits[source]?.maxWaitMs ?? 15_000 : 0);
    let waited = 0;
    for (;;) {
      const r = this.tryAcquire(source, mode);
      if ('ok' in r || r.kind !== 'spacing') return r;
      const gap = Math.max(r.retryAt - this.now(), 1);
      if (waited + gap > maxWait) return r;
      await this.sleep(gap);
      waited += gap;
    }
  }

  /** The source answered (or the network failed): set blocks from the status and headers. */
  report(source: string, input: ReportInput): void {
    const lim = this.limits[source];
    if (!lim) return;
    const now = this.now();
    const s = this.rolled(this.state(source), now);
    const { status, headers } = input;
    const failed = !!input.networkError || (status !== undefined && !(status >= 200 && status < 300) && status !== 304);
    let until = 0;
    let reason = '';
    const raise = (ms: number, why: string): void => {
      if (now + ms > until) {
        until = now + ms;
        reason = why;
      }
    };
    const retryAfter = parseRetryAfter(headers?.get('retry-after'), now);
    const rl = headers ? parseRateLimitHeaders((n) => headers.get(n), now) : undefined;
    const blockOn = status !== undefined ? lim.blockOn?.[status] : undefined;
    if (blockOn !== undefined) raise(Math.max(blockOn, retryAfter ?? 0), `HTTP ${status}${retryAfter ? `, Retry-After ${Math.round(retryAfter / 1000)} s` : ''}`);
    else if (retryAfter && (status === 429 || status === 503 || status === 403)) raise(retryAfter, `HTTP ${status}, Retry-After ${Math.round(retryAfter / 1000)} s`);
    if (rl !== undefined) raise(rl, 'X-Rate-Limit: no requests remaining');
    const b = lim.backoff;
    // with `backoff.statuses` only those statuses (and network errors) count as failures: a 404 is a working source
    const backoffFailure = failed && (!b?.statuses || !!input.networkError || (status !== undefined && b.statuses.includes(status)));
    if (failed && !backoffFailure) s.consecutiveFailures = 0;
    if (failed) {
      if (backoffFailure) s.consecutiveFailures = (s.consecutiveFailures ?? 0) + 1;
      const stop = lim.failureStop;
      if (stop) {
        const recent = [...(s.failures ?? []), now].filter((t) => now - t < stop.windowMs);
        s.failures = recent;
        if (recent.length >= stop.count) {
          raise(stop.blockMs, `${recent.length} failed answers within ${Math.round(stop.windowMs / HOUR_MS)} h`);
          s.failures = [];
        }
      }
      if (b && backoffFailure) {
        const n = s.consecutiveFailures ?? 1;
        raise(Math.min(b.baseMs * 2 ** (Math.min(n, 20) - 1), b.maxMs), `backoff after ${n} failure${n === 1 ? '' : 's'}`);
      }
    } else if (status !== undefined) {
      s.consecutiveFailures = 0;
    }
    if (until > (s.blockedUntil ?? 0)) {
      s.blockedUntil = until;
      s.blockReason = reason;
    }
    this.save(source, s);
  }

  /** Block `source` for `ms` (a failed Space-Track login, say). Never shortens an existing block. */
  block(source: string, ms: number, reason: string): void {
    const now = this.now();
    const s = this.rolled(this.state(source), now);
    if (now + ms > (s.blockedUntil ?? 0)) {
      s.blockedUntil = now + ms;
      s.blockReason = reason;
      this.save(source, s);
    }
  }

  /** Drop only the failure block and failure history: spacing and counters stay, so saved credentials never skip a cap. */
  clearBlock(source: string): void {
    const row = this.store.get<LimitState>(limitKey(source));
    if (!row) return;
    const s: LimitState = { ...row.value, failures: [], consecutiveFailures: 0 };
    delete s.blockedUntil;
    delete s.blockReason;
    this.save(source, s);
  }

  consecutiveFailures(source: string): number {
    return this.state(source).consecutiveFailures ?? 0;
  }

  /** The most used window (as a share of its cap) plus the spacing and block times still ahead; undefined for a source without caps. */
  status(source: string): FeedLimit | undefined {
    const lim = this.limits[source];
    if (!lim) return undefined;
    const now = this.now();
    const s = this.rolled(this.state(source), now);
    const rows: { window: FeedLimit['window']; used: number; cap: number }[] = [];
    if (lim.perMinute) rows.push({ window: 'minute', used: s.minute?.count ?? 0, cap: lim.perMinute });
    if (lim.perHour) rows.push({ window: 'hour', used: s.hour?.count ?? 0, cap: lim.perHour });
    if (lim.perDay) rows.push({ window: 'day', used: s.day?.count ?? 0, cap: lim.perDay });
    if (!rows.length) return undefined;
    rows.sort((a, b) => b.used / b.cap - a.used / a.cap);
    const out: FeedLimit = { ...rows[0] };
    if (s.nextAllowedAt > now) out.nextAllowedAt = s.nextAllowedAt;
    if (s.blockedUntil !== undefined) out.blockedUntil = s.blockedUntil;
    return out;
  }
}

const registry = new WeakMap<Store, Limiter>();

/** The limiter of a store (one per cache file, shared by Http, the scripts and the credential saves). */
export function limiterFor(store: Store): Limiter {
  let l = registry.get(store);
  if (!l) {
    // EIO_RATE_LIMITS=off: the test suite's fixtures fire many requests in no time; production never sets it
    l = new Limiter(store, process.env.EIO_RATE_LIMITS === 'off' ? { limits: {} } : {});
    registry.set(store, l);
  }
  return l;
}

/** Make `limiter` the one `limiterFor(store)` returns (tests that want the real table where the default is off). */
export function useLimiter(store: Store, limiter: Limiter): Limiter {
  registry.set(store, limiter);
  return limiter;
}
