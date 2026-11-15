import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordFailure } from '../src/backoff';
import { BackoffLog, BACKOFF_LOG_FILE, backoffLogIn, describeEntry, recordBackoff, setBackoffLog, type BackoffEntry } from '../src/backoff-log';
import { guardedFetch } from '../src/net/guarded-fetch';
import { Limiter } from '../src/net/limiter';
import { LIMITS, type SourceLimit } from '../src/net/limits';
import { Store } from '../src/store';

const T0 = Date.parse('2026-11-01T10:00:00Z');
let dir: string;
let lines: string[];
const file = () => join(dir, BACKOFF_LOG_FILE);
const entries = (): BackoffEntry[] => readFileSync(file(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as BackoffEntry);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eio-backoff-'));
  lines = [];
  setBackoffLog(backoffLogIn(dir, { print: (l) => lines.push(l) }));
});
afterEach(() => {
  setBackoffLog(undefined);
  rmSync(dir, { recursive: true, force: true });
});

const table = (over: Partial<SourceLimit> = {}): Record<string, SourceLimit> => ({ src: { label: 'src', policy: 'test', minSpacingMs: 0, ...over } });

describe('limiter decisions are recorded', () => {
  it('a 429 with Retry-After writes one entry with trigger, wait, until and host, and one console line', async () => {
    const limiter = new Limiter(new Store(':memory:'), { limits: table({ blockOn: { 429: 60_000 } }), now: () => T0 });
    const fetchMock = vi.fn(async () => new Response('x', { status: 429, headers: { 'retry-after': '120' } }));
    await guardedFetch(limiter, 'src', 'https://api.example.org/v1/x', undefined, { mode: 'poll', fetch: fetchMock as unknown as typeof fetch });
    expect(entries()).toEqual([{
      time: '2026-11-01T10:00:00.000Z', source: 'src', host: 'api.example.org', origin: 'limiter', blockKind: 'rate',
      reason: 'HTTP 429, Retry-After 120 s', waitMs: 120_000, until: '2026-11-01T10:02:00.000Z',
      trigger: { status: 429, retryAfter: '120', failures: 1 },
    }]);
    expect(lines).toEqual(['backoff src (api.example.org): HTTP 429, Retry-After 120 -> wait 2 min until 10:02Z [limiter, rate]']);
  });

  it('a network error that starts the exponential backoff is recorded as a failure block', () => {
    let t = T0;
    const limiter = new Limiter(new Store(':memory:'), { limits: table({ backoff: { baseMs: 60_000, maxMs: 3_600_000 } }), now: () => t });
    limiter.report('src', { networkError: true, host: 'h.example' });
    t += 61_000;
    limiter.report('src', { networkError: true, host: 'h.example' });
    const [a, b] = entries();
    expect(a).toMatchObject({ blockKind: 'failure', host: 'h.example', waitMs: 60_000, trigger: { networkError: true, failures: 1 }, reason: 'backoff after 1 failure' });
    expect(a.previous).toBeUndefined();
    expect(b).toMatchObject({ waitMs: 120_000, trigger: { failures: 2 } });
    expect(b.previous).toBeUndefined(); // the first block had ended before the second failure
  });

  it('records the block that was in force when a longer one replaces it, and nothing when the block does not change', () => {
    const limiter = new Limiter(new Store(':memory:'), { limits: table({ blockOn: { 429: 60_000 } }), now: () => T0 });
    limiter.block('src', 60_000, 'manual');
    limiter.block('src', 10_000, 'shorter, ignored');
    limiter.report('src', { status: 429, headers: new Headers({ 'retry-after': '600' }) });
    const all = entries();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ reason: 'manual', trigger: { note: 'manual' } });
    expect(all[1]).toMatchObject({ waitMs: 600_000, previous: { until: '2026-11-01T10:01:00.000Z' } });
  });

  it('a success, a status without a rule and a source without limits record nothing', () => {
    const limiter = new Limiter(new Store(':memory:'), { limits: table(), now: () => T0 });
    limiter.report('src', { status: 200 });
    limiter.report('src', { status: 500 });
    limiter.report('unknown', { status: 429 });
    expect(existsSync(file())).toBe(false);
  });

  it('uses the real table: a CelesTrak 403 records its 3 h block', () => {
    const limiter = new Limiter(new Store(':memory:'), { limits: LIMITS, now: () => T0 });
    limiter.report('celestrak', { status: 403, host: 'celestrak.org' });
    expect(entries()[0]).toMatchObject({ source: 'celestrak', host: 'celestrak.org', waitMs: 3 * 3600_000, trigger: { status: 403 } });
  });
});

describe('retry gates are recorded', () => {
  it('recordFailure writes the trigger parsed from the message, the wait, and the previous gate', () => {
    const store = new Store(':memory:');
    recordFailure(store, 'celestrak:stations', new Error('HTTP 429 for https://celestrak.org/NORAD/elements/gp.php?GROUP=stations [retry-after=14400; server=cf]'), T0);
    recordFailure(store, 'celestrak:stations', new Error('HTTP 429 for https://celestrak.org/x'), T0 + 1000);
    const [a, b] = entries();
    expect(a).toMatchObject({
      source: 'celestrak:stations', host: 'celestrak.org', origin: 'gate', waitMs: 14_400_000, until: '2026-11-01T14:00:00.000Z',
      trigger: { status: 429, retryAfter: '14400', failures: 1 },
    });
    expect(a.previous).toBeUndefined();
    expect(b).toMatchObject({ waitMs: 6 * 3600_000, trigger: { failures: 2 }, previous: { until: '2026-11-01T14:00:00.000Z', failures: 1 } });
  });

  it('a connect timeout is recorded as a network error on the short schedule', () => {
    recordFailure(new Store(':memory:'), 'celestrak:gps', new Error('fetch failed (UND_ERR_CONNECT_TIMEOUT)'), T0);
    expect(entries()[0]).toMatchObject({ waitMs: 30 * 60_000, trigger: { networkError: true }, reason: 'transient, failure 1' });
  });
});

describe('the log file', () => {
  it('writes nothing until a log is installed', () => {
    setBackoffLog(undefined);
    recordFailure(new Store(':memory:'), 'x', 'HTTP 403', T0);
    expect(existsSync(file())).toBe(false);
  });

  it('rotates to <file>.1 when it passes the size limit, so it stays bounded', () => {
    const log = new BackoffLog(file(), { maxBytes: 600, print: () => {} });
    setBackoffLog(log);
    for (let i = 0; i < 20; i++) recordBackoff({ source: `s${i}`, origin: 'gate', reason: 'r', waitMs: 1000, until: T0 + 1000, trigger: {} }, T0 + i);
    expect(existsSync(`${file()}.1`)).toBe(true);
    expect(readFileSync(file(), 'utf8').length).toBeLessThan(600 + 400);
    expect(log.recent(100).at(-1)?.source).toBe('s19');
  });

  it('recent() returns the newest entries and skips a torn line', () => {
    const log = new BackoffLog(file(), { print: () => {} });
    for (let i = 0; i < 5; i++) log.write({ time: 't', source: `s${i}`, origin: 'gate', reason: 'r', waitMs: 1, until: 'u', trigger: {} });
    writeFileSync(file(), `${readFileSync(file(), 'utf8')}{"torn\n`);
    expect(log.recent(3).map((e) => e.source)).toEqual(['s3', 's4']);
    expect(new BackoffLog(join(dir, 'missing.jsonl')).recent()).toEqual([]);
  });

  it('never throws into the caller when the file cannot be written or the console fails; it warns instead', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(join(dir, 'a-file'), 'x'); // a file where the directory should be
    setBackoffLog(new BackoffLog(join(dir, 'a-file', 'x', BACKOFF_LOG_FILE), { print: () => { throw new Error('closed stdout'); } }));
    expect(() => recordFailure(new Store(':memory:'), 'x', 'HTTP 429', T0)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('describeEntry is one line', () => {
    const e: BackoffEntry = { time: 't', source: 'a', origin: 'gate', reason: 'r', waitMs: 4 * 3600_000, until: '2026-11-01T14:00:00.000Z', trigger: { status: 403 } };
    expect(describeEntry(e)).toBe('backoff a: HTTP 403 -> wait 4 h until 14:00Z [gate]');
  });
});
