import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineConfig } from '../../src/engine/config';
import { Scheduler, type Connector } from '../../src/engine/scheduler';
import { Http } from '../../src/engine/http';
import { Hub } from '../../src/engine/hub';
import { Limiter, LimitedError } from '../../src/engine/net/limiter';
import { LIMITS } from '../../src/engine/net/limits';
import { MemoryKv } from '../../src/engine/store';

function setup(connectors: Connector[], over: { offline?: boolean } = {}) {
  const hub = new Hub(0);
  const store = new MemoryKv();
  const fetchMock = vi.fn<typeof fetch>();
  const config = engineConfig(over);
  // an empty limit table: the limiter has its own tests; the limited-run tests below build theirs
  const http = new Http(store, { fetch: fetchMock, offline: config.offline, limiter: new Limiter(store, { limits: {} }) });
  const scheduler = new Scheduler({ hub, config, store, http }, connectors, 0);
  return { hub, store, http, scheduler, fetchMock };
}

describe('scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls on its interval and records health', async () => {
    let n = 0;
    const { hub, scheduler } = setup([{ id: 'c', intervalMs: 10_000, run: async () => void n++ }]);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(n).toBe(1);
    expect(hub.healthOf('c')).toMatchObject({ status: 'ok', runs: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n).toBe(2);
    scheduler.stop();
  });

  it('backs off exponentially after errors, then recovers', async () => {
    const calls: number[] = [];
    let fail = true;
    const { hub, scheduler } = setup([{
      id: 'c', intervalMs: 1000,
      run: async () => {
        calls.push(Date.now());
        if (fail) throw new Error('boom');
      },
    }]);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.healthOf('c')).toMatchObject({ status: 'error', lastError: 'boom' });
    await vi.advanceTimersByTimeAsync(20_000);
    const gaps = calls.slice(1).map((t, i) => t - calls[i]);
    expect(gaps.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    fail = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hub.healthOf('c').status).toBe('ok');
    expect(hub.healthOf('c').lastError).toBeUndefined();
    scheduler.stop();
  });

  it('runs topic-gated connectors only while the topic has subscribers', async () => {
    let n = 0;
    const { hub, scheduler } = setup([{ id: 'iss', intervalMs: 1000, topic: 'iss', run: async () => void n++ }]);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(n).toBe(0);
    expect(hub.healthOf('iss').status).toBe('idle');

    hub.subscribe('iss');
    await vi.advanceTimersByTimeAsync(3500);
    expect(n).toBeGreaterThanOrEqual(3);
    hub.unsubscribe('iss');
    const before = n;
    await vi.advanceTimersByTimeAsync(5000);
    expect(n).toBeLessThanOrEqual(before + 1);
    expect(hub.healthOf('iss').status).toBe('idle');
    scheduler.stop();
  });

  it('marks stubs, and retries sooner when a fetch fell back to stale cache', async () => {
    const { hub, store, scheduler, fetchMock } = setup([
      { id: 'stubby', stub: () => 'later' },
      { id: 'cached', intervalMs: 3 * 3600_000, run: async (ctx) => void (await ctx.cachedFetch('k', 'https://x.test', 1000, String)) },
    ]);
    await store.put('k', 'old', 1000, Date.now() - 10_000);
    fetchMock.mockRejectedValue(new Error('down'));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.healthOf('stubby')).toMatchObject({ status: 'stub', note: 'later', runs: 0 });
    expect(hub.healthOf('cached')).toMatchObject({ status: 'ok', fromCache: true, lastError: 'down' });
    const next = hub.healthOf('cached').nextRunAt! - Date.now();
    expect(next).toBeLessThanOrEqual(5 * 60_000);
    scheduler.stop();
  });

  it('OFFLINE=1 runs network connectors once and reports disabled without a cache', async () => {
    let n = 0;
    const { hub, scheduler } = setup(
      [
        { id: 'net', intervalMs: 1000, run: async (ctx) => { n++; await ctx.cachedFetch('k', 'https://x.test', 1000, String); } },
        { id: 'local', intervalMs: 1000, network: false, run: async () => void n++ },
      ],
      { offline: true },
    );
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(hub.healthOf('net').status).toBe('disabled');
    expect(hub.healthOf('net').runs).toBe(1);
    expect(hub.healthOf('local').runs).toBeGreaterThan(1);
    scheduler.stop();
  });

  it('reports a feed level: orange after one failure, red once it keeps failing with no data, grey offline, green after a clean run', async () => {
    let fail = true;
    const { hub, scheduler } = setup([
      { id: 'c', intervalMs: 1000, run: async () => { if (fail) throw new Error('boom'); } },
      { id: 'soft', intervalMs: 1000, run: async (ctx) => ctx.softFail('stations: waiting until 14:30Z (HTTP 403), using cache', 60_000) },
    ]);
    const feed = async (id: string) => (await hub.healthList()).find((h) => h.id === id)!.feed;
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.healthOf('c').failures).toBe(1);
    expect(await feed('c')).toMatchObject({ level: 'orange', reason: 'error' });
    expect(await feed('soft')).toMatchObject({ level: 'orange', reason: 'backoff', retryUtc: '14:30Z' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await feed('c')).toMatchObject({ level: 'red', reason: 'repeated' });
    fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await feed('c')).toMatchObject({ level: 'ok', reason: 'ok' });
    expect(hub.healthOf('c').failures).toBe(0);
    scheduler.stop();

    const off = setup([{ id: 'net', intervalMs: 1000, run: async () => undefined }], { offline: true });
    await off.scheduler.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await off.hub.healthList())[0].feed).toMatchObject({ level: 'off', reason: 'offline' });
    off.scheduler.stop();
  });
});


// ported from the server's limiter tests: how the scheduler treats a run the limiter refused
describe('the scheduler on a limited run', () => {
  const T0 = Date.parse('2026-11-01T10:00:00Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a spacing refusal is silent (no error, rescheduled at the retry time); a cap shows "rate limited until" and keeps ok after data', async () => {
    let mode: 'spacing' | 'cap' | 'ok' = 'ok';
    const retry = () => Date.now() + 45_000;
    const c: Connector = {
      id: 'c', intervalMs: 1000,
      run: async () => {
        if (mode === 'spacing') throw new LimitedError('x', retry(), '30 s spacing', 'spacing');
        if (mode === 'cap') throw new LimitedError('x', retry(), 'hourly cap of 7 reached', 'cap');
      },
    };
    const { hub, scheduler } = setup([c]);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.healthOf('c').status).toBe('ok');
    mode = 'spacing';
    await vi.advanceTimersByTimeAsync(1100);
    expect(hub.healthOf('c')).toMatchObject({ status: 'ok', lastError: undefined });
    expect(hub.healthOf('c').nextRunAt! - Date.now()).toBeGreaterThanOrEqual(44_000);
    mode = 'cap';
    await vi.advanceTimersByTimeAsync(46_000);
    expect(hub.healthOf('c')).toMatchObject({ status: 'ok' });
    expect(hub.healthOf('c').lastError).toMatch(/rate limited until \d\d:\d\dZ \(hourly cap of 7 reached\)/);
    const feed = (await hub.healthList()).find((h) => h.id === 'c')!.feed!;
    expect(feed).toMatchObject({ level: 'orange', reason: 'rate-limited' });
    expect(feed.retryUtc).toMatch(/^\d\d:\d\dZ$/);
    scheduler.stop();
  });

  it('a failure block with no data ends red "repeated"; a rate block stays orange and does not count failures', async () => {
    const run = async (blockKind: 'rate' | 'failure') => {
      const c: Connector = { id: 'dsn', intervalMs: 1000, run: async () => { throw new LimitedError('dsn', Date.now() + 30_000, 'blocked', 'blocked', blockKind); } };
      const { hub, scheduler } = setup([c]);
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(200_000);
      scheduler.stop();
      return (await hub.healthList()).find((h) => h.id === 'dsn')!;
    };
    const failing = await run('failure');
    expect(failing.failures).toBeGreaterThanOrEqual(3);
    expect(failing.feed).toMatchObject({ level: 'red', reason: 'repeated' });
    const rate = await run('rate');
    expect(rate.failures ?? 0).toBe(0);
    expect(rate.feed).toMatchObject({ level: 'orange', reason: 'rate-limited' });
  });

  it('a successful run clears the spacing note', async () => {
    let n = 0;
    const c: Connector = { id: 'c', intervalMs: 1000, run: async () => { if (n++ === 0) throw new LimitedError('x', Date.now() + 2000, '30 s spacing', 'spacing'); } };
    const { hub, scheduler } = setup([c]);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(hub.healthOf('c').note).toMatch(/request spacing/);
    await vi.advanceTimersByTimeAsync(3000);
    expect(hub.healthOf('c').note).toBeUndefined();
    scheduler.stop();
  });

  it('health.limit carries used, cap, window and the block time of the connector\'s source, read from the limiter', async () => {
    const store = new MemoryKv();
    const limiter = new Limiter(store, { limits: LIMITS });
    const hub = new Hub(0);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}'));
    const http = new Http(store, { fetch: fetchMock, limiter });
    const snapi: Connector = { id: 'snapi', intervalMs: 600_000, run: async (ctx) => void (await ctx.cachedFetch('snapi:k', 'https://api.spaceflightnewsapi.net/v4/articles/', 1000, String)) };
    const scheduler = new Scheduler({ hub, config: engineConfig(), store, http }, [snapi], 0);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    const h = (await hub.healthList()).find((x) => x.id === 'snapi')!;
    expect(h.limit).toMatchObject({ used: 1, cap: 32, window: 'hour' });
    await limiter.block('snapi', 20 * 60_000, 'HTTP 429');
    const blocked = (await hub.healthList()).find((x) => x.id === 'snapi')!;
    expect(blocked.limit!.blockedUntil).toBe(Date.now() + 20 * 60_000);
    expect(blocked.feed).toMatchObject({ level: 'orange', reason: 'rate-limited' });
    scheduler.stop();
  });
});

describe('scheduler with an injected clock', () => {
  it('uses the clock for timers, health times and jitter instead of the globals', async () => {
    const pending: { at: number; fn: () => void; id: number }[] = [];
    let now = 1_000_000, ids = 0;
    const clock = {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => { const id = ++ids; pending.push({ at: now + ms, fn, id }); return id as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout: (h: unknown) => { const i = pending.findIndex((p) => p.id === (h as number)); if (i >= 0) pending.splice(i, 1); },
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
      random: () => 0.25,
    };
    const store = new MemoryKv();
    const hub = new Hub(0, clock);
    const http = new Http(store, { limiter: new Limiter(store, { limits: {} }), clock });
    let runs = 0;
    const scheduler = new Scheduler({ hub, config: engineConfig(), store, http, clock }, [{ id: 'c', intervalMs: 5000, startDelayMs: 100, run: async () => void runs++ }], 1000);
    await scheduler.start();
    expect(hub.healthOf('c').nextRunAt).toBe(now + 100 + 250); // start delay plus 0.25 of the 1 s jitter
    expect(pending).toHaveLength(1);
    now += 350;
    pending.shift()!.fn();
    await new Promise((r) => setTimeout(r, 0)); // the run and its health announcement are promises; the clock's own timers are fake
    expect(runs).toBe(1);
    expect(hub.healthOf('c')).toMatchObject({ status: 'ok', lastOkAt: now });
    expect(hub.healthOf('c').nextRunAt).toBe(now + 5000);
    scheduler.stop();
  });
});

describe('health announcements never stop a connector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a rejecting limit read (the store failing) does not stop the connector or the 30 s health timer', async () => {
    let n = 0;
    const { hub, scheduler } = setup([{ id: 'c', intervalMs: 31_000, run: async () => void n++ }]);
    hub.limitOf = async () => { throw new Error('idb closed'); };
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(hub.healthOf('c').status).toBe('ok');
    scheduler.stop();
  });

  it('a kick() while the health announcement is pending is not pushed back to the normal delay', async () => {
    let n = 0;
    const { hub, scheduler } = setup([{ id: 'c', intervalMs: 3_600_000, run: async () => void n++ }]);
    let release!: () => void;
    hub.limitOf = () => new Promise((r) => { release = () => r(undefined); });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1); // the first run is done; its announcement waits on the limit read
    expect(n).toBe(1);
    scheduler.kick('c');
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(n).toBe(2);
    scheduler.stop();
  });
});
