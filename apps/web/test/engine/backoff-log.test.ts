import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordFailure } from '../../src/engine/backoff';
import { BackoffLog, describeEntry, getBackoffLog, recordBackoff, setBackoffLog, type BackoffEntry } from '../../src/engine/backoff-log';
import { guardedFetch } from '../../src/engine/net/guarded-fetch';
import { Limiter } from '../../src/engine/net/limiter';
import { LIMITS, type SourceLimit } from '../../src/engine/net/limits';
import { MemoryKv } from '../../src/engine/store';

const T0 = Date.parse('2026-11-01T10:00:00Z');
let log: BackoffLog;
let lines: string[];
const entries = (): BackoffEntry[] => log.recent(1000);

beforeEach(() => {
  lines = [];
  log = new BackoffLog({ print: (l) => lines.push(l) });
  setBackoffLog(log);
});
afterEach(() => {
  setBackoffLog(undefined);
});

const table = (over: Partial<SourceLimit> = {}): Record<string, SourceLimit> => ({ src: { label: 'src', policy: 'test', minSpacingMs: 0, ...over } });

describe('limiter decisions are recorded', () => {
  it('a 429 with Retry-After writes one entry with trigger, wait, until and host, and one console line', async () => {
    const limiter = new Limiter(new MemoryKv(), { limits: table({ blockOn: { 429: 60_000 } }), now: () => T0 });
    const fetchMock = vi.fn(async () => new Response('x', { status: 429, headers: { 'retry-after': '120' } }));
    await guardedFetch(limiter, 'src', 'https://api.example.org/v1/x', undefined, { mode: 'poll', fetch: fetchMock as unknown as typeof fetch });
    expect(entries()).toEqual([{
      time: '2026-11-01T10:00:00.000Z', source: 'src', host: 'api.example.org', origin: 'limiter', blockKind: 'rate',
      reason: 'HTTP 429, Retry-After 120 s', waitMs: 120_000, until: '2026-11-01T10:02:00.000Z',
      trigger: { status: 429, retryAfter: '120', failures: 1 },
    }]);
    expect(lines).toEqual(['backoff src (api.example.org): HTTP 429, Retry-After 120 -> wait 2 min until 10:02Z [limiter, rate]']);
  });

  it('a network error that starts the exponential backoff is recorded as a failure block', async () => {
    let t = T0;
    const limiter = new Limiter(new MemoryKv(), { limits: table({ backoff: { baseMs: 60_000, maxMs: 3_600_000 } }), now: () => t });
    await limiter.report('src', { networkError: true, host: 'h.example' });
    t += 61_000;
    await limiter.report('src', { networkError: true, host: 'h.example' });
    const [a, b] = entries();
    expect(a).toMatchObject({ blockKind: 'failure', host: 'h.example', waitMs: 60_000, trigger: { networkError: true, failures: 1 }, reason: 'backoff after 1 failure' });
    expect(a.previous).toBeUndefined();
    expect(b).toMatchObject({ waitMs: 120_000, trigger: { failures: 2 } });
    expect(b.previous).toBeUndefined(); // the first block had ended before the second failure
  });

  it('records the block that was in force when a longer one replaces it, and nothing when the block does not change', async () => {
    const limiter = new Limiter(new MemoryKv(), { limits: table({ blockOn: { 429: 60_000 } }), now: () => T0 });
    await limiter.block('src', 60_000, 'manual');
    await limiter.block('src', 10_000, 'shorter, ignored');
    await limiter.report('src', { status: 429, headers: new Headers({ 'retry-after': '600' }) });
    const all = entries();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ reason: 'manual', trigger: { note: 'manual' } });
    expect(all[1]).toMatchObject({ waitMs: 600_000, previous: { until: '2026-11-01T10:01:00.000Z' } });
  });

  it('a success, a status without a rule and a source without limits record nothing', async () => {
    const limiter = new Limiter(new MemoryKv(), { limits: table(), now: () => T0 });
    await limiter.report('src', { status: 200 });
    await limiter.report('src', { status: 500 });
    await limiter.report('unknown', { status: 429 });
    expect(entries()).toEqual([]);
  });

  it('uses the real table: a CelesTrak 403 records its 3 h block', async () => {
    const limiter = new Limiter(new MemoryKv(), { limits: LIMITS, now: () => T0 });
    await limiter.report('celestrak', { status: 403, host: 'celestrak.org' });
    expect(entries()[0]).toMatchObject({ source: 'celestrak', host: 'celestrak.org', waitMs: 3 * 3600_000, trigger: { status: 403 } });
  });

  it('a hidden (CORS) failure of a flagged source is recorded as an unreadable answer', async () => {
    const limiter = new Limiter(new MemoryKv(), { limits: { src: { label: 'src', policy: 't', minSpacingMs: 0, opaqueIsAnswer: true, backoff: { baseMs: 1000, maxMs: 5000 } } }, now: () => T0 });
    await limiter.report('src', { opaque: true, host: 'h.example' });
    expect(entries()[0]).toMatchObject({ trigger: { opaque: true } });
    expect(lines[0]).toMatch(/unreadable \(CORS\) answer/);
  });
});

describe('retry gates are recorded', () => {
  it('recordFailure writes the trigger parsed from the message, the wait, and the previous gate', async () => {
    const store = new MemoryKv();
    await recordFailure(store, 'celestrak:stations', new Error('HTTP 429 for https://celestrak.org/NORAD/elements/gp.php?GROUP=stations [retry-after=14400; server=cf]'), T0);
    await recordFailure(store, 'celestrak:stations', new Error('HTTP 429 for https://celestrak.org/x'), T0 + 1000);
    const [a, b] = entries();
    expect(a).toMatchObject({
      source: 'celestrak:stations', host: 'celestrak.org', origin: 'gate', waitMs: 14_400_000, until: '2026-11-01T14:00:00.000Z',
      trigger: { status: 429, retryAfter: '14400', failures: 1 },
    });
    expect(a.previous).toBeUndefined();
    expect(b).toMatchObject({ waitMs: 6 * 3600_000, trigger: { failures: 2 }, previous: { until: '2026-11-01T14:00:00.000Z', failures: 1 } });
  });

  it('a connect timeout is recorded as a network error on the short schedule', async () => {
    await recordFailure(new MemoryKv(), 'celestrak:gps', new Error('fetch failed (UND_ERR_CONNECT_TIMEOUT)'), T0);
    expect(entries()[0]).toMatchObject({ waitMs: 30 * 60_000, trigger: { networkError: true }, reason: 'transient, failure 1' });
  });
});

describe('the in-memory log', () => {
  it('records nothing until a log is installed', async () => {
    setBackoffLog(undefined);
    expect(getBackoffLog()).toBeUndefined();
    await recordFailure(new MemoryKv(), 'x', 'HTTP 403', T0);
    expect(log.recent()).toEqual([]);
  });

  it('is a ring buffer: the oldest entries are dropped past the capacity', () => {
    const ring = new BackoffLog({ maxEntries: 5, print: () => {} });
    setBackoffLog(ring);
    for (let i = 0; i < 20; i++) recordBackoff({ source: `s${i}`, origin: 'gate', reason: 'r', waitMs: 1000, until: T0 + 1000, trigger: {} }, T0 + i);
    expect(ring.recent(100).map((e) => e.source)).toEqual(['s15', 's16', 's17', 's18', 's19']);
    expect(ring.recent(2).map((e) => e.source)).toEqual(['s18', 's19']);
  });

  it('never throws into the caller when the console fails; the entry is still kept', async () => {
    const broken = new BackoffLog({ print: () => { throw new Error('closed console'); } });
    setBackoffLog(broken);
    await expect(recordFailure(new MemoryKv(), 'x', 'HTTP 429', T0)).resolves.toBeDefined();
    expect(broken.recent()).toHaveLength(1);
  });

  it('describeEntry is one line', () => {
    const e: BackoffEntry = { time: 't', source: 'a', origin: 'gate', reason: 'r', waitMs: 4 * 3600_000, until: '2026-11-01T14:00:00.000Z', trigger: { status: 403 } };
    expect(describeEntry(e)).toBe('backoff a: HTTP 403 -> wait 4 h until 14:00Z [gate]');
  });
});
