import Fastify from 'fastify';
import { classifyCause, classifyFeed, retryTimeOf, type ConnectorHealth, type FeedReason } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { registerApi } from '../src/api';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { Store } from '../src/store';

const base: ConnectorHealth = { id: 'c', status: 'ok', runs: 3, lastOkAt: 1000 };
const h = (over: Partial<ConnectorHealth>): ConnectorHealth => ({ ...base, ...over });

const HTTP403 = 'HTTP 403 for https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json [server=cloudflare; cf-ray=8a1]: Forbidden';
const HTTP429 = 'HTTP 429 for https://ll.thespacedevs.com/2.2.0/launch/upcoming/ [retry-after=3600]: Request was throttled.';
const HTTP503 = 'HTTP 503 for https://example.test/x: Service Unavailable';

describe('classifyCause (message shapes written by http.ts and the connectors)', () => {
  const table: [string, string, ReturnType<typeof classifyCause>][] = [
    ['connect timeout', 'fetch failed (UND_ERR_CONNECT_TIMEOUT)', 'unreachable'],
    ['connection reset', 'fetch failed (ECONNRESET)', 'unreachable'],
    ['dns', 'fetch failed (ENOTFOUND)', 'unreachable'],
    ['lightstreamer silent', 'no data from Lightstreamer for 20 s', 'unreachable'],
    ['socket closed early', 'socket closed before session was created', 'unreachable'],
    ['http 403 with headers', HTTP403, 'blocked'],
    ['http 403 on websocket upgrade', 'HTTP 403 during WebSocket upgrade', 'blocked'],
    ['http 429 with retry-after', HTTP429, 'rate-limited'],
    ['http 429 plain', 'HTTP 429 for https://x.test/', 'rate-limited'],
    ['the limiter refused a request', 'rate limited until 14:30Z (hourly cap of 7 reached)', 'rate-limited'],
    ['403 that carries retry-after', 'HTTP 403 for https://x.test/ [retry-after=120]', 'rate-limited'],
    ['http 401', 'HTTP 401 for https://x.test/', 'auth'],
    ['space-track login rejected', 'Space-Track login failed (check SPACETRACK_USER / SPACETRACK_PASSWORD)', 'auth'],
    ['space-track no cookie', 'Space-Track login returned no session cookie', 'auth'],
    ['http 503', HTTP503, 'server-error'],
    ['total timeout', 'The operation was aborted due to timeout', 'timeout'],
    ['lightstreamer handshake', 'Lightstreamer handshake timed out', 'timeout'],
    ['no ephemeris', 'M20: no ephemeris in Horizons response: No ephemeris for target "-168" prior to A.D. 2020', 'no-ephemeris'],
    ['celestrak not json', 'CelesTrak did not return a JSON array: <html>', 'invalid'],
    ['ll2 shape', 'unexpected LL2 response: {"detail":"x"}', 'invalid'],
    ['snapi shape', 'unexpected SNAPI response: ', 'invalid'],
    ['iss rest shape', 'unexpected wheretheiss.at response: {}', 'invalid'],
    ['dsn xml', 'not a DSN document: <html>', 'invalid'],
    ['horizons table', 'malformed Horizons vector table', 'invalid'],
    ['json parse', 'Unexpected token < in JSON at position 0', 'invalid'],
    ['offline', 'offline (OFFLINE=1)', 'offline'],
    ['unknown', 'boom', 'error'],
    ['undici without code', 'fetch failed', 'error'],
    ['nothing', '', 'error'],
  ];
  it.each(table)('%s', (_name, message, cause) => expect(classifyCause(message)).toBe(cause));
});

describe('retryTimeOf', () => {
  it('reads the backoff gate and Space-Track retry times', () => {
    expect(retryTimeOf('stations: waiting until 14:30Z (HTTP 403)')).toBe('14:30Z');
    expect(retryTimeOf('earlier failure (next attempt 09:05Z)')).toBe('09:05Z');
    expect(retryTimeOf('HTTP 403')).toBeUndefined();
    expect(retryTimeOf('rate limited until 14:30Z (hourly cap of 7 reached)')).toBe('14:30Z');
  });
});

describe('classifyFeed with the limiter block (health.limit)', () => {
  const NOW = Date.UTC(2026, 10, 1, 12, 0);
  const limit = (blockedUntil?: number) => ({ used: 7, cap: 7, window: 'hour' as const, ...(blockedUntil ? { blockedUntil } : {}) });

  it('a block in force is orange rate-limited with the retry time, for an ok, a failing and a never-ok feed', () => {
    const until = NOW + 90 * 60_000;
    expect(classifyFeed(h({ limit: limit(until) }), NOW)).toMatchObject({ level: 'orange', reason: 'rate-limited', retryUtc: '13:30Z', hasData: true });
    expect(classifyFeed(h({ status: 'error', lastError: 'boom', failures: 5, limit: limit(until) }), NOW)).toMatchObject({ level: 'orange', reason: 'rate-limited', retryUtc: '13:30Z' });
    expect(classifyFeed(h({ status: 'error', lastOkAt: undefined, failures: 9, lastError: 'rate limited until 13:30Z (hourly cap of 7 reached)' }), NOW))
      .toMatchObject({ level: 'orange', reason: 'rate-limited' }); // never red "repeated" for a limit
  });

  it('an ended block, or no block, changes nothing; a rejected login stays red', () => {
    expect(classifyFeed(h({ limit: limit(NOW - 1) }), NOW)).toMatchObject({ level: 'ok', reason: 'ok' });
    expect(classifyFeed(h({ limit: limit() }), NOW)).toMatchObject({ level: 'ok' });
    expect(classifyFeed(h({ status: 'error', lastError: 'Space-Track login failed (check SPACETRACK_USER / SPACETRACK_PASSWORD); next attempt 18:00Z', limit: limit(NOW + 6 * 3600_000) }), NOW))
      .toMatchObject({ level: 'red', reason: 'auth' });
  });

  it('keeps off states off', () => {
    expect(classifyFeed(h({ status: 'stub', note: 'Needs credentials', limit: limit(NOW + 1000) }), NOW).level).toBe('off');
    expect(classifyFeed(h({ status: 'disabled', limit: limit(NOW + 1000) }), NOW).level).toBe('off');
  });
});

describe('classifyFeed', () => {
  type Row = [string, Partial<ConnectorHealth>, 'ok' | 'orange' | 'red' | 'off', FeedReason];
  const table: Row[] = [
    // green
    ['ok', {}, 'ok', 'ok'],
    ['ok with a note only', { note: '4 bodies' }, 'ok', 'ok'],
    // grey
    ['disabled by DISABLED_CONNECTORS', { status: 'disabled', note: 'DISABLED_CONNECTORS', lastOkAt: undefined }, 'off', 'disabled'],
    ['offline and nothing cached', { status: 'disabled', note: 'OFFLINE=1 and nothing cached', lastOkAt: undefined }, 'off', 'offline'],
    ['offline, served from cache', { offline: true, fromCache: true }, 'off', 'offline'],
    ['offline, run failed', { offline: true, status: 'error', lastError: 'offline (OFFLINE=1)', lastOkAt: undefined }, 'off', 'offline'],
    ['stub not implemented', { status: 'stub', note: 'Not implemented. Would read ...', lastOkAt: undefined }, 'off', 'stub'],
    ['stub needing credentials', { status: 'stub', note: 'Needs SPACETRACK_USER and SPACETRACK_PASSWORD', lastOkAt: undefined }, 'off', 'no-credentials'],
    ['not run yet / waiting for subscribers', { status: 'idle', note: 'waiting for subscribers to "iss"', lastOkAt: undefined }, 'off', 'idle'],
    // orange: ok but degraded
    ['celestrak waiting on a backoff gate, using cache', { lastError: 'stations: waiting until 14:30Z (HTTP 403), using cache', note: 'partial: stations: waiting until 14:30Z (HTTP 403), using cache' }, 'orange', 'backoff'],
    ['celestrak partial, one group failed', { lastError: 'gps-ops: HTTP 403', note: 'partial: gps-ops: HTTP 403' }, 'orange', 'partial'],
    ['rate limited, cache served', { lastError: HTTP429 }, 'orange', 'rate-limited'],
    ['stale-cache fallback after a block', { lastError: HTTP403, fromCache: true }, 'orange', 'blocked'],
    ['stale-cache fallback after a connect timeout', { lastError: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)', fromCache: true }, 'orange', 'unreachable'],
    ['stale-cache fallback, unrecognised error', { lastError: 'boom', fromCache: true }, 'orange', 'stale'],
    ['horizons: one target has no ephemeris', { lastError: 'M20: no ephemeris in Horizons response: x', note: '1 targets failed: M20: no ephemeris' }, 'orange', 'no-ephemeris'],
    ['space-track waiting for next attempt', { lastError: 'HTTP 403 (next attempt 09:05Z)' }, 'orange', 'backoff'],
    // orange: error but an earlier run left data / temporary cause
    ['timeout once', { status: 'error', lastError: 'The operation was aborted due to timeout', failures: 1, lastOkAt: undefined }, 'orange', 'timeout'],
    ['server error once', { status: 'error', lastError: HTTP503, failures: 2, lastOkAt: undefined }, 'orange', 'server-error'],
    ['rate limited with nothing yet', { status: 'error', lastError: HTTP429, failures: 1, lastOkAt: undefined }, 'orange', 'rate-limited'],
    ['no ephemeris for the only target, first time', { status: 'error', lastError: 'no ephemerides: M20: no ephemeris', failures: 1, lastOkAt: undefined }, 'orange', 'no-ephemeris'],
    ['blocked, but older data is held', { status: 'error', lastError: HTTP403, failures: 4 }, 'orange', 'blocked'],
    ['unreachable, but older data is held', { status: 'error', lastError: 'fetch failed (ECONNRESET)', failures: 9 }, 'orange', 'unreachable'],
    ['bad response, but older data is held', { status: 'error', lastError: 'unexpected LL2 response: x', failures: 2 }, 'orange', 'invalid'],
    ['unknown error, older data held, many failures', { status: 'error', lastError: 'boom', failures: 12 }, 'orange', 'error'],
    // red: nothing usable
    ['connect timeout, nothing cached', { status: 'error', lastError: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)', failures: 1, lastOkAt: undefined }, 'red', 'unreachable'],
    ['http 403, nothing cached', { status: 'error', lastError: 'stations: HTTP 403; gps-ops: HTTP 403', failures: 1, lastOkAt: undefined }, 'red', 'blocked'],
    ['celestrak all groups waiting, no data', { status: 'error', lastError: 'stations: waiting until 14:30Z (HTTP 403)', failures: 1, lastOkAt: undefined }, 'red', 'blocked'],
    ['login failed', { status: 'error', lastError: 'Space-Track login failed (check SPACETRACK_USER / SPACETRACK_PASSWORD)', failures: 1 }, 'red', 'auth'],
    ['http 401 even with older data', { status: 'error', lastError: 'HTTP 401 for https://x.test/', failures: 1 }, 'red', 'auth'],
    ['unparseable response, no data', { status: 'error', lastError: 'CelesTrak did not return a JSON array: <html>', failures: 1, lastOkAt: undefined }, 'red', 'invalid'],
    ['repeated unknown failures, no data', { status: 'error', lastError: 'boom', failures: 3, lastOkAt: undefined }, 'red', 'repeated'],
    ['repeated timeouts, no data', { status: 'error', lastError: 'The operation was aborted due to timeout', failures: 5, lastOkAt: undefined }, 'red', 'repeated'],
  ];

  it.each(table)('%s', (_name, over, level, reason) => {
    const state = classifyFeed(h(over));
    expect([state.level, state.reason]).toEqual([level, reason]);
  });

  it('carries the note, the retry time and whether data is held', () => {
    expect(classifyFeed(h({ lastError: 'stations: waiting until 14:30Z (HTTP 403)' }))).toEqual({
      level: 'orange', reason: 'backoff', hasData: true, note: 'stations: waiting until 14:30Z (HTTP 403)', retryUtc: '14:30Z',
    });
    expect(classifyFeed(h({ note: '4 bodies' }))).toEqual({ level: 'ok', reason: 'ok', hasData: true, note: '4 bodies' });
    expect(classifyFeed(h({ status: 'stub', lastOkAt: undefined, note: 'x' })).hasData).toBe(false);
  });
});

describe('/api/health payload', () => {
  it('carries feed { level, reason, note } on every connector next to the old fields', async () => {
    const hub = new Hub(0);
    const store = new Store(':memory:');
    const server = Fastify();
    registerApi(server, hub, new Http(store, { offline: false }));
    Object.assign(hub.healthOf('a'), { status: 'ok', lastOkAt: 5, runs: 2, note: '9 things' });
    Object.assign(hub.healthOf('b'), { status: 'error', lastError: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)', failures: 1 });
    Object.assign(hub.healthOf('c'), { status: 'disabled', note: 'DISABLED_CONNECTORS' });

    const body = (await server.inject({ url: '/api/health' })).json();
    expect(body.connectors).toHaveLength(3);
    const by = Object.fromEntries(body.connectors.map((c: any) => [c.id, c]));
    expect(by.a).toMatchObject({ status: 'ok', runs: 2, note: '9 things', feed: { level: 'ok', reason: 'ok', note: '9 things' } });
    expect(by.b).toMatchObject({ status: 'error', lastError: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)', feed: { level: 'red', reason: 'unreachable' } });
    expect(by.c).toMatchObject({ status: 'disabled', feed: { level: 'off', reason: 'disabled' } });
    // the stored records stay plain (the WebSocket push uses the same hub.healthList())
    expect(hub.health.get('a')).not.toHaveProperty('feed');
    store.close();
  });
});
