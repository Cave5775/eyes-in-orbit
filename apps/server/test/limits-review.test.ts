import { readFileSync } from 'node:fs';
import { classifyFeed } from '@eio/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { Scheduler, type Connector } from '../src/connector';
import { FALLBACK_AFTER_FAILURES } from '../src/connectors/dsn';
import { CLEAR_BLOCK_EVERY_MS, Credentials } from '../src/credentials';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { LimitedError, Limiter, limiterFor, rateLimitsOff, rateLimitsOffWarning, useLimiter } from '../src/net/limiter';
import { LIMITS } from '../src/net/limits';
import { Store } from '../src/store';

const T0 = Date.parse('2026-11-01T10:00:00Z');
const H = 3600_000;
const fx = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('EIO_RATE_LIMITS=off only works under the test runner', () => {
  it('is honoured with VITEST set and ignored (with a warning) without it', () => {
    expect(rateLimitsOff({ EIO_RATE_LIMITS: 'off', VITEST: 'true' })).toBe(true);
    expect(rateLimitsOff({ EIO_RATE_LIMITS: 'off' })).toBe(false);
    expect(rateLimitsOff({ VITEST: 'true' })).toBe(false);
    expect(rateLimitsOffWarning({ EIO_RATE_LIMITS: 'off' })).toMatch(/only honoured under the test runner/);
    expect(rateLimitsOffWarning({ EIO_RATE_LIMITS: 'off', VITEST: 'true' })).toBeUndefined();
    expect(rateLimitsOffWarning({})).toBeUndefined();
  });

  it('limiterFor gives real limits when the variable is set outside the tests', () => {
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(limiterFor(new Store(':memory:')).limitOf('celestrak')).toBeDefined();
    } finally {
      process.env.VITEST = saved;
    }
    expect(limiterFor(new Store(':memory:')).limitOf('celestrak')).toBeUndefined(); // under vitest it is off
  });
});

describe('block origin: rate vs failure', () => {
  const rig = () => {
    const c = { t: T0 };
    return { c, limiter: new Limiter(new Store(':memory:'), { limits: LIMITS, now: () => c.t }) };
  };

  it('rate signals record a rate block, backoff and failure stops a failure block', () => {
    const a = rig();
    a.limiter.report('ll2', { status: 429 });
    expect(a.limiter.status('ll2')).toMatchObject({ blockKind: 'rate' });
    const b = rig();
    b.limiter.report('dsn', { networkError: true });
    expect(b.limiter.status('dsn')).toMatchObject({ blockKind: 'failure' });
    const c = rig();
    c.limiter.report('dsn', { status: 503, headers: new Headers({ 'retry-after': '600' }) });
    expect(c.limiter.status('dsn')).toMatchObject({ blockKind: 'rate' }); // Retry-After outlasts the 30 s backoff
    const d = rig();
    for (let i = 0; i < 3; i++) d.limiter.report('celestrak', { status: 500 });
    expect(d.limiter.status('celestrak')).toMatchObject({ blockKind: 'failure' });
  });

  it('classifyFeed: a failure block keeps the old mapping (red repeated), a rate block is orange', () => {
    const now = T0;
    const base = { id: 'dsn', status: 'error' as const, runs: 5, failures: 4, lastError: 'waiting until 10:10Z (backoff after 4 failures)' };
    const lim = (blockKind: 'rate' | 'failure') => ({ used: 4, cap: 800, window: 'hour' as const, blockedUntil: now + 600_000, blockKind });
    expect(classifyFeed({ ...base, limit: lim('failure') }, now)).toMatchObject({ level: 'red', reason: 'repeated' });
    expect(classifyFeed({ ...base, limit: lim('rate') }, now)).toMatchObject({ level: 'orange', reason: 'rate-limited' });
    expect(classifyFeed({ ...base, limit: { ...lim('rate'), blockKind: undefined } }, now)).toMatchObject({ reason: 'rate-limited' });
  });

  it('LimitedError from a failure block reads "waiting until", a rate one "rate limited until"', () => {
    expect(new LimitedError('dsn', T0, 'backoff', 'blocked', 'failure').message).toMatch(/^waiting until 10:00Z/);
    expect(new LimitedError('dsn', T0, 'HTTP 429', 'blocked', 'rate').message).toMatch(/^rate limited until 10:00Z/);
  });
});

describe('scheduler counts failure-kind blocks as failures', () => {
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

  const run = async (blockKind: 'rate' | 'failure') => {
    const c: Connector = {
      id: 'dsn', intervalMs: 1000,
      run: async () => { throw new LimitedError('dsn', Date.now() + 30_000, 'blocked', 'blocked', blockKind); },
    };
    const hub = new Hub(0);
    const store = new Store(':memory:');
    const limiter = new Limiter(store, { limits: LIMITS });
    const scheduler = new Scheduler({ hub, config: loadConfig({}), store, http: new Http(store, { limiter }) }, [c], 0);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(200_000);
    scheduler.stop();
    return hub.healthList().find((h) => h.id === 'dsn')!;
  };

  it('a failure block with no data ends red "repeated"; a rate block stays orange and does not count failures', async () => {
    const failing = await run('failure');
    expect(failing.failures).toBeGreaterThanOrEqual(3);
    expect(failing.feed).toMatchObject({ level: 'red', reason: 'repeated' });
    const rate = await run('rate');
    expect(rate.failures ?? 0).toBe(0);
    expect(rate.feed).toMatchObject({ level: 'orange', reason: 'rate-limited' });
  });

  it('a successful run clears the spacing note', async () => {
    let n = 0;
    const c: Connector = {
      id: 'c', intervalMs: 1000,
      run: async () => { if (n++ === 0) throw new LimitedError('x', Date.now() + 2000, '30 s spacing', 'spacing'); },
    };
    const hub = new Hub(0);
    const store = new Store(':memory:');
    const scheduler = new Scheduler({ hub, config: loadConfig({}), store, http: new Http(store) }, [c], 0);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(hub.healthOf('c').note).toMatch(/request spacing/);
    await vi.advanceTimersByTimeAsync(3000);
    expect(hub.healthOf('c').note).toBeUndefined();
    scheduler.stop();
  });
});

describe('CelesTrak stop counts HTTP answers only', () => {
  it('offline flapping (network errors, timeouts) never triggers the 24 h stop', () => {
    const c = { t: T0 };
    const limiter = new Limiter(new Store(':memory:'), { limits: LIMITS, now: () => c.t });
    for (let i = 0; i < 10; i++) {
      limiter.report('celestrak', { networkError: true });
      c.t += 60_000;
    }
    expect(limiter.state('celestrak').blockedUntil).toBeUndefined();
    expect(limiter.tryAcquire('celestrak', 'poll')).toEqual({ ok: true });
    for (let i = 0; i < 3; i++) limiter.report('celestrak', { status: 502 });
    expect(limiter.state('celestrak').blockedUntil).toBe(c.t + 24 * H);
  });
});

describe('credential re-saves lift a failed-login block at most once per hour', () => {
  it('the second save inside the hour leaves a new block in place; after the hour it lifts again', () => {
    const c = { t: T0 };
    const store = new Store(':memory:');
    const limiter = useLimiter(store, new Limiter(store, { limits: LIMITS, now: () => c.t }));
    const config = loadConfig({});
    const creds = new Credentials(config, store);
    const blockBoth = () => ['spacetrack:login', 'spacetrack:query'].forEach((s) => limiter.block(s, 6 * H, 'failed login', 'failure'));
    blockBoth();
    creds.update({ spacetrackPassword: 'one' });
    expect(limiter.state('spacetrack:login').blockedUntil).toBeUndefined();
    blockBoth(); // the bad account failed again
    c.t += 10 * 60_000;
    creds.update({ spacetrackPassword: 'two' });
    expect(limiter.state('spacetrack:login').blockedUntil).toBeGreaterThan(c.t);
    c.t += CLEAR_BLOCK_EVERY_MS;
    creds.update({ spacetrackPassword: 'three' });
    expect(limiter.state('spacetrack:login').blockedUntil).toBeUndefined();
  });
});

describe('DSN: an unreadable 200 counts toward the fallback rotation', () => {
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

  it('three unparsable answers from the first URL, then the second URL is tried', async () => {
    const A = 'https://eyes.nasa.gov/dsn/data/dsn.xml', B = 'https://eyes.nasa.gov/dsn/dsn.xml';
    vi.resetModules();
    const { dsn } = (await import('../src/connectors/dsn')) as { dsn: Connector };
    const calls: string[] = [];
    const store = new Store(':memory:');
    const limiter = new Limiter(store, { limits: LIMITS });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      calls.push(String(input));
      return String(input).startsWith(A) ? new Response('<html>maintenance</html>') : new Response(fx('dsn.xml'));
    });
    const scheduler = new Scheduler({ hub: new Hub(0), config: loadConfig({ DSN_URL: `${A},${B}` }), store, http: new Http(store, { fetch: fetchMock, limiter }) }, [dsn], 0);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    scheduler.stop();
    const hosts = calls.map((u) => (u.startsWith(A) ? 'A' : 'B'));
    expect(hosts.indexOf('B')).toBe(FALLBACK_AFTER_FAILURES);
    expect(hosts.slice(0, FALLBACK_AFTER_FAILURES)).toEqual(['A', 'A', 'A']);
  });
});
