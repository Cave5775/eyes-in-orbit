import { describe, expect, it, vi } from 'vitest';
import { guardedFetch, guardedWebSocket } from '../../src/engine/net/guarded-fetch';
import { LimitedError, Limiter } from '../../src/engine/net/limiter';
import { LIMITS, type SourceLimit } from '../../src/engine/net/limits';
import { inProcessLock } from '../../src/engine/net/lock';
import { webLocks, webLocksAvailable } from '../../src/engine/net/lock.browser';
import { applyUpstream, defaultUpstreams, resolveUpstream, setAppBase, setUpstreams } from '../../src/engine/net/upstream';
import { MemoryKv, type KvStore } from '../../src/engine/store';

const T0 = Date.parse('2026-11-01T10:00:00Z');
const H = 3600_000;
const table = (over: Partial<SourceLimit> = {}): Record<string, SourceLimit> => ({ src: { label: 'src', policy: 'test', minSpacingMs: 0, ...over } });
const ok = () => new Response('x', { status: 200 });

describe('opaque CORS failures', () => {
  const reject = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
  const call = (l: Limiter, source: string, url: string, online = true) =>
    guardedFetch(l, source, url, undefined, { mode: 'poll', fetch: reject, online: () => online });

  it('CelesTrak: a burst of hidden failures with the browser online is one strike and never the 24 h stop', async () => {
    let t = T0;
    const limiter = new Limiter(new MemoryKv(), { limits: LIMITS, now: () => t, sleep: async (ms) => { t += ms; } });
    await expect(call(limiter, 'celestrak', 'https://celestrak.org/NORAD/elements/gp.php')).rejects.toThrow('Failed to fetch');
    for (let i = 0; i < 5; i++) { // the rest of a startup burst: requests already in flight fail within seconds
      t += 800;
      await limiter.report('celestrak', { opaque: true, networkError: false });
    }
    expect(await limiter.tryAcquire('celestrak', 'poll')).toMatchObject({ limited: true, kind: 'blocked' });
    const s = await limiter.state('celestrak');
    expect(s.opaqueStrikes).toBe(1);
    expect(s.blockedUntil! - T0).toBeLessThanOrEqual(30_000); // one strike: 30 s, not 24 h
    expect(s.failures ?? []).toEqual([]); // never counted toward failureStop
  });

  it('repeated hidden failures back off in minutes at most (capped at 5 min), and a readable success resets the strikes', async () => {
    let t = T0;
    const limiter = new Limiter(new MemoryKv(), { limits: LIMITS, now: () => t, sleep: async (ms) => { t += ms; } });
    for (let i = 0; i < 12; i++) {
      await expect(call(limiter, 'celestrak', 'https://celestrak.org/x')).rejects.toThrow();
      expect((await limiter.state('celestrak')).blockedUntil! - t).toBeLessThanOrEqual(5 * 60_000);
      t = (await limiter.state('celestrak')).blockedUntil! + 6000;
    }
    expect((await limiter.state('celestrak')).opaqueStrikes).toBe(12);
    await limiter.report('celestrak', { status: 200 });
    expect((await limiter.state('celestrak')).opaqueStrikes).toBe(0);
  });

  it('switching the upstream lifts an opaque-induced block (but not a block the source itself announced)', async () => {
    let t = T0;
    const limiter = new Limiter(new MemoryKv(), { limits: LIMITS, now: () => t });
    await expect(call(limiter, 'celestrak', 'https://celestrak.org/x')).rejects.toThrow();
    expect(await limiter.tryAcquire('celestrak', 'poll', true, 'direct')).toMatchObject({ limited: true, kind: 'blocked' });
    t += 3000; // past the 2 s spacing gap too
    expect(await limiter.tryAcquire('celestrak', 'poll', true, 'relay')).toEqual({ ok: true });
    expect((await limiter.state('celestrak')).opaqueUpstream).toBeUndefined();
    await limiter.report('celestrak', { status: 403, upstream: 'relay' }); // a readable 403: the real 3 h block
    expect(await limiter.tryAcquire('celestrak', 'poll', true, 'direct')).toMatchObject({ limited: true, kind: 'blocked' });
  });

  it('through the upstream table: a relay mapping gets through where the direct route was blocked by hidden failures', async () => {
    let t = T0;
    const limiter = new Limiter(new MemoryKv(), { limits: LIMITS, now: () => t, sleep: async (ms) => { t += ms; } });
    await expect(call(limiter, 'celestrak', 'https://celestrak.org/x')).rejects.toThrow();
    t += 3000;
    const seen: string[] = [];
    const fetchImpl = (async (u: string) => { seen.push(u); return ok(); }) as unknown as typeof fetch;
    const r = await guardedFetch(limiter, 'celestrak', 'https://celestrak.org/x', undefined, { mode: 'poll', fetch: fetchImpl, upstreams: { celestrak: { kind: 'relay', base: '/relay' } }, appBase: 'https://app.test/eio/' });
    expect(r).toMatchObject({ ok: true });
    expect(seen).toEqual(['https://app.test/relay?url=https%3A%2F%2Fcelestrak.org%2Fx']);
  });

  it('a flagged source offline (navigator.onLine false) is a plain network error: CelesTrak has no backoff, so nothing is counted', async () => {
    let t = T0;
    const limiter = new Limiter(new MemoryKv(), { limits: LIMITS, now: () => t, sleep: async (ms) => { t += ms; } });
    for (let i = 0; i < 5; i++) await expect(call(limiter, 'celestrak', 'https://celestrak.org/x', false)).rejects.toThrow();
    expect((await limiter.state('celestrak')).blockedUntil).toBeUndefined();
  });

  it('Wikimedia and MPC back off briefly (30 s), not for their hours-long steps; a source not flagged treats it as a network error', async () => {
    const limiter = new Limiter(new MemoryKv(), { limits: LIMITS, now: () => T0 });
    await expect(call(limiter, 'wikimedia', 'https://en.wikipedia.org/x')).rejects.toThrow();
    expect((await limiter.state('wikimedia')).blockedUntil).toBe(T0 + 30_000);
    await expect(call(limiter, 'mpcorb', 'https://www.minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz')).rejects.toThrow();
    expect((await limiter.state('mpcorb')).blockedUntil).toBe(T0 + 30_000);
    // dsn is not flagged: the TypeError is a network error and starts its own backoff the usual way
    await expect(call(limiter, 'dsn', 'https://eyes.nasa.gov/dsn/data/dsn.xml')).rejects.toThrow();
    expect(await limiter.consecutiveFailures('dsn')).toBe(1);
  });

  it('the flag is on exactly the sources that block through a CDN without CORS headers', () => {
    expect(Object.entries(LIMITS).filter(([, l]) => l.opaqueIsAnswer).map(([k]) => k).sort()).toEqual(['celestrak', 'mpcorb', 'wikimedia']);
  });

  it('an abort or timeout (not a TypeError) is never opaque', async () => {
    const limiter = new Limiter(new MemoryKv(), { limits: LIMITS, now: () => T0 });
    const timeout = (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as unknown as typeof fetch;
    await expect(guardedFetch(limiter, 'wikimedia', 'https://en.wikipedia.org/x', undefined, { mode: 'poll', fetch: timeout })).rejects.toThrow('timed out');
    expect((await limiter.state('wikimedia')).consecutiveFailures).toBe(1);
  });
});

describe('the lock around the limiter state', () => {
  /** a store whose reads answer a tick late, so two unlocked callers both read the old state before either writes */
  class SlowKv extends MemoryKv {
    override async get<T = unknown>(key: string) {
      const row = await super.get<T>(key);
      await new Promise((r) => setTimeout(r, 1));
      return row;
    }
  }
  const race = async (withLock?: ReturnType<typeof inProcessLock>) => {
    const store: KvStore = new SlowKv();
    const a = new Limiter(store, { limits: table({ minSpacingMs: 10_000, perHour: 100 }), now: () => T0, withLock });
    const b = new Limiter(store, { limits: table({ minSpacingMs: 10_000, perHour: 100 }), now: () => T0, withLock });
    return Promise.all([a.tryAcquire('src', 'demand'), b.tryAcquire('src', 'demand')]);
  };

  it('without a shared lock two limiters on one store can both pass the same gap (the race the lock removes)', async () => {
    const res = await race();
    expect(res.filter((r) => 'ok' in r)).toHaveLength(2);
  });

  it('with a shared lock exactly one passes and the other sees the spacing', async () => {
    const res = await race(inProcessLock());
    expect(res.filter((r) => 'ok' in r)).toHaveLength(1);
    expect(res.find((r) => 'limited' in r)).toMatchObject({ kind: 'spacing', retryAt: T0 + 10_000 });
  });

  it('the attempt is stored before the request is sent', async () => {
    const store = new MemoryKv();
    const limiter = new Limiter(store, { limits: table({ minSpacingMs: 5000 }), now: () => T0 });
    let seen = 0;
    const fetchImpl = (async () => { seen = (await store.get<{ nextAllowedAt: number }>('limit:src'))!.value.nextAllowedAt; return ok(); }) as unknown as typeof fetch;
    await guardedFetch(limiter, 'src', 'https://x.test/', undefined, { mode: 'poll', fetch: fetchImpl });
    expect(seen).toBe(T0 + 5000);
  });

  it('inProcessLock runs sections of one name in order, even when one throws, and different names concurrently', async () => {
    const lock = inProcessLock();
    const order: string[] = [];
    const step = (name: string, tag: string, ms: number, fail = false) => lock(name, async () => {
      order.push(`${tag}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}-`);
      if (fail) throw new Error(tag);
    });
    const r = await Promise.allSettled([step('a', '1', 5, true), step('a', '2', 1), step('b', '3', 1)]);
    expect(r.map((x) => x.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(order.indexOf('1-')).toBeLessThan(order.indexOf('2+'));
    expect(order.indexOf('3+')).toBeLessThan(order.indexOf('1-')); // another name does not wait
  });

  it('webLocks hands the section to navigator.locks.request, and falls back to the in-process lock without it', async () => {
    const request = vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn());
    const lock = webLocks({ request } as unknown as LockManager);
    expect(await lock('eio:limit:x', async () => 7)).toBe(7);
    expect(request).toHaveBeenCalledWith('eio:limit:x', expect.any(Function));
    expect(await webLocks(undefined)('n', async () => 'plain')).toBe('plain');
  });
});

describe('upstream resolver', () => {
  it('defaults the no-CORS sources to the relay and every other source (CelesTrak included) to direct', () => {
    const relay = { kind: 'relay', base: '/relay' };
    for (const s of ['horizons', 'spacetrack:query', 'spacetrack:login', 'spacetrack:logout', 'discos', 'mast', 'mmgis']) expect(resolveUpstream(s)).toEqual(relay);
    for (const s of Object.keys(LIMITS).filter((k) => !['horizons', 'discos', 'mast', 'mmgis'].includes(k) && !k.startsWith('spacetrack:'))) expect(resolveUpstream(s)).toEqual({ kind: 'direct' });
    expect(resolveUpstream('anything')).toEqual({ kind: 'direct' });
  });

  it('defaultUpstreams takes the relay base and can route CelesTrak through the relay', () => {
    expect(defaultUpstreams({ relayBase: 'https://r.example/relay' }).horizons).toEqual({ kind: 'relay', base: 'https://r.example/relay' });
    expect(defaultUpstreams().celestrak).toBeUndefined();
    expect(defaultUpstreams({ celestrakViaRelay: true }).celestrak).toEqual({ kind: 'relay', base: '/relay' });
  });

  it('maps a source to a relay or a static file, and rewrites the URL', () => {
    const t = { horizons: { kind: 'relay', base: 'https://relay.example/api' }, spacetrack: { kind: 'static', path: '/data/gp.json' } } as const;
    expect(resolveUpstream('horizons', t)).toEqual({ kind: 'relay', base: 'https://relay.example/api' });
    expect(applyUpstream(resolveUpstream('horizons', t), 'https://ssd.jpl.nasa.gov/api/x?a=1')).toBe('https://relay.example/api?url=https%3A%2F%2Fssd.jpl.nasa.gov%2Fapi%2Fx%3Fa%3D1');
    expect(applyUpstream({ kind: 'relay', base: 'https://r.example/p?k=1' }, 'https://h/x')).toBe('https://r.example/p?k=1&url=https%3A%2F%2Fh%2Fx');
    expect(applyUpstream(resolveUpstream('spacetrack', t), 'https://www.space-track.org/x')).toBe('/data/gp.json');
    expect(applyUpstream({ kind: 'direct' }, 'https://h/x')).toBe('https://h/x');
  });

  it('guardedFetch sends direct URLs as given, relay calls through the relay (still limited), static files without the limiter', async () => {
    const limiter = new Limiter(new MemoryKv(), { limits: table({ perHour: 1 }), now: () => T0 });
    const seen: string[] = [];
    const fetchImpl = (async (u: string) => { seen.push(u); return ok(); }) as unknown as typeof fetch;
    const upstreams = { relayed: { kind: 'relay', base: 'https://relay.example/r' }, bundled: { kind: 'static', path: '/data/x.json' } } as const;
    await guardedFetch(limiter, 'src', 'https://a.test/x', undefined, { mode: 'poll', fetch: fetchImpl, upstreams });
    expect(await guardedFetch(limiter, 'src', 'https://a.test/y', undefined, { mode: 'poll', fetch: fetchImpl, upstreams })).toMatchObject({ limited: true });
    await guardedFetch(new Limiter(new MemoryKv(), { limits: table(), now: () => T0 }), 'relayed', 'https://b.test/z', undefined, { mode: 'poll', fetch: fetchImpl, upstreams });
    // a static answer is the app's own file: it is not counted, so it is never limited
    for (let i = 0; i < 3; i++) await guardedFetch(limiter, 'bundled', 'https://c.test/q', undefined, { mode: 'poll', fetch: fetchImpl, upstreams });
    expect(seen).toEqual(['https://a.test/x', 'https://relay.example/r?url=https%3A%2F%2Fb.test%2Fz', '/data/x.json', '/data/x.json', '/data/x.json']);
  });

  it('setUpstreams replaces the process-wide table and returns the previous one', () => {
    const prev = setUpstreams({ x: { kind: 'static', path: '/s' } });
    expect(resolveUpstream('x')).toEqual({ kind: 'static', path: '/s' });
    setUpstreams(prev);
    expect(resolveUpstream('x')).toEqual({ kind: 'direct' });
    expect(resolveUpstream('horizons')).toEqual({ kind: 'relay', base: '/relay' });
  });
});

describe('guardedWebSocket', () => {
  class FakeSocket extends EventTarget {
    static last?: FakeSocket;
    constructor(readonly url: string, readonly protocol: string) { super(); FakeSocket.last = this; }
  }

  it('returns limited without opening, and reports a socket that closes before it opened as a network failure', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    try {
      let t = T0;
      const limiter = new Limiter(new MemoryKv(), { limits: LIMITS, now: () => t, sleep: async (ms) => { t += ms; } });
      const first = await guardedWebSocket(limiter, 'iss-live', 'wss://push.lightstreamer.com/lightstreamer', 'TLCP-2.1.0.lightstreamer.com');
      expect(first).toMatchObject({ ok: true });
      expect(FakeSocket.last?.protocol).toBe('TLCP-2.1.0.lightstreamer.com');
      FakeSocket.last!.dispatchEvent(new Event('close'));
      await new Promise((r) => setTimeout(r, 0));
      expect(await limiter.consecutiveFailures('iss-live')).toBe(1);
      const second = await guardedWebSocket(limiter, 'iss-live', 'wss://push.lightstreamer.com/lightstreamer', 'p');
      expect(second).toMatchObject({ limited: true, kind: 'spacing' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ported from the server's limits review tests
describe('block origin: rate vs failure', () => {
  const rig = () => {
    const c = { t: T0 };
    return { c, limiter: new Limiter(new MemoryKv(), { limits: LIMITS, now: () => c.t }) };
  };

  it('rate signals record a rate block, backoff and failure stops a failure block', async () => {
    const a = rig();
    await a.limiter.report('ll2', { status: 429 });
    expect(await a.limiter.status('ll2')).toMatchObject({ blockKind: 'rate' });
    const b = rig();
    await b.limiter.report('dsn', { networkError: true });
    expect(await b.limiter.status('dsn')).toMatchObject({ blockKind: 'failure' });
    const c = rig();
    await c.limiter.report('dsn', { status: 503, headers: new Headers({ 'retry-after': '600' }) });
    expect(await c.limiter.status('dsn')).toMatchObject({ blockKind: 'rate' }); // Retry-After outlasts the 30 s backoff
    const d = rig();
    for (let i = 0; i < 3; i++) await d.limiter.report('celestrak', { status: 500 });
    expect(await d.limiter.status('celestrak')).toMatchObject({ blockKind: 'failure' });
  });

  it('LimitedError from a failure block reads "waiting until", a rate one "rate limited until"', () => {
    expect(new LimitedError('dsn', T0, 'backoff', 'blocked', 'failure').message).toMatch(/^waiting until 10:00Z/);
    expect(new LimitedError('dsn', T0, 'HTTP 429', 'blocked', 'rate').message).toMatch(/^rate limited until 10:00Z/);
  });
});

describe('CelesTrak stop counts HTTP answers only', () => {
  it('offline flapping (network errors, timeouts) never triggers the 24 h stop', async () => {
    const c = { t: T0 };
    const limiter = new Limiter(new MemoryKv(), { limits: LIMITS, now: () => c.t });
    for (let i = 0; i < 10; i++) {
      await limiter.report('celestrak', { networkError: true });
      c.t += 60_000;
    }
    expect((await limiter.state('celestrak')).blockedUntil).toBeUndefined();
    expect(await limiter.tryAcquire('celestrak', 'poll')).toEqual({ ok: true });
    for (let i = 0; i < 3; i++) await limiter.report('celestrak', { status: 502 });
    expect((await limiter.state('celestrak')).blockedUntil).toBe(c.t + 24 * H);
  });
});

describe('credential re-saves lift a failure block at most once per interval (clearBlock)', () => {
  it('the second lift inside the interval leaves a new block in place; after the interval it lifts again', async () => {
    const c = { t: T0 };
    const limiter = new Limiter(new MemoryKv(), { limits: LIMITS, now: () => c.t });
    await limiter.block('spacetrack:login', 6 * H, 'login rejected', 'failure');
    expect(await limiter.clearBlock('spacetrack:login', H)).toBe(true);
    await limiter.block('spacetrack:login', 6 * H, 'login rejected again', 'failure');
    c.t += 10 * 60_000;
    expect(await limiter.clearBlock('spacetrack:login', H)).toBe(false);
    expect((await limiter.state('spacetrack:login')).blockedUntil).toBeDefined();
    c.t += H;
    expect(await limiter.clearBlock('spacetrack:login', H)).toBe(true);
    expect((await limiter.state('spacetrack:login')).blockedUntil).toBeUndefined();
  });
});

describe('report failures and static files', () => {
  it('a failing limiter write after a good fetch neither loses the response nor counts a network error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const limiter = new Limiter(new MemoryKv(), { limits: table(), now: () => T0 });
    vi.spyOn(limiter, 'report').mockRejectedValue(new Error('idb closed'));
    const r = await guardedFetch(limiter, 'src', 'https://x.test/', undefined, { mode: 'poll', fetch: (async () => ok()) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a static path resolves against the injected app base (sub-path deploys, workers under /assets/)', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (u: string) => { seen.push(u); return new Response('{}', { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const limiter = new Limiter(new MemoryKv(), { limits: {}, now: () => T0 });
    await guardedFetch(limiter, 'bundled', 'https://c.test/q', undefined, { mode: 'poll', fetch: fetchImpl, upstreams: { bundled: { kind: 'static', path: 'data/x.json' } }, appBase: 'https://app.test/eio/' });
    expect(seen).toEqual(['https://app.test/eio/data/x.json']);
    expect(applyUpstream({ kind: 'static', path: '/data/x.json' }, 'u', 'https://app.test/eio/')).toBe('https://app.test/data/x.json');
    expect(applyUpstream({ kind: 'relay', base: 'relay' }, 'https://h/x', 'https://app.test/eio/')).toBe('https://app.test/eio/relay?url=https%3A%2F%2Fh%2Fx');
    const prev = setAppBase('https://app.test/eio/');
    expect(applyUpstream({ kind: 'static', path: 'a.json' }, 'u')).toBe('https://app.test/eio/a.json');
    setAppBase(prev);
  });

  it('a static answer that is the SPA fallback (HTTP 200, text/html) is a miss', async () => {
    const fetchImpl = (async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch;
    const limiter = new Limiter(new MemoryKv(), { limits: {}, now: () => T0 });
    const r = await guardedFetch(limiter, 'bundled', 'https://c.test/q', undefined, { mode: 'poll', fetch: fetchImpl, upstreams: { bundled: { kind: 'static', path: '/data/nope.json' } } });
    expect(r).toMatchObject({ ok: true });
    expect((r as { response: Response }).response.status).toBe(404);
  });
});

describe('lock guards', () => {
  it('a nested acquire of the same name is rejected by maxWaitMs instead of hanging', async () => {
    const lock = inProcessLock({ maxWaitMs: 50 });
    await expect(lock('a', () => lock('a', async () => 1))).rejects.toThrow(/nested acquire/);
    expect(await lock('a', async () => 'free again')).toBe('free again');
  });

  it('webLocks: a timeout aborts a request that waits too long, and webLocksAvailable tells whether the API is there', async () => {
    const request = vi.fn((_n: string, opts: { signal: AbortSignal }, _fn: () => Promise<unknown>) => new Promise((_res, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason))));
    const lock = webLocks({ request } as unknown as LockManager, { timeoutMs: 20 });
    await expect(lock('x', async () => 1)).rejects.toThrow(/not acquired within 20 ms/);
    expect(webLocksAvailable(null)).toBe(false);
    expect(webLocksAvailable({} as LockManager)).toBe(true);
  });
});
