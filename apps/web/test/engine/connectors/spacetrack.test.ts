import { describe, expect, it, vi } from 'vitest';
import { readBackoff, recordFailure } from '../../../src/engine/backoff';
import { CLEAR_BLOCK_EVERY_MS, Credentials } from '../../../src/engine/credentials';
import { FAILED_LOGIN_WAIT_MS, NEEDS_CREDENTIALS, SPACETRACK_SOURCE, STARLINK_QUERY, createSpacetrack, fetchSpaceTrackGp, isSafeRelayBase } from '../../../src/engine/connectors/spacetrack';
import type { CredentialSource } from '../../../src/engine/connectors/types';
import { Hub } from '../../../src/engine/hub';
import { Http } from '../../../src/engine/http';
import { LimitedError, Limiter } from '../../../src/engine/net/limiter';
import { LIMITS } from '../../../src/engine/net/limits';
import { defaultUpstreams } from '../../../src/engine/net/upstream';
import { engineConfig } from '../../../src/engine/config';
import { MemoryKv } from '../../../src/engine/store';

const T0 = Date.parse('2026-11-01T10:00:00Z');
/** the real Space-Track limits on a fixed clock */
const lim = (now = () => T0, store = new MemoryKv()) => new Limiter(store, { limits: LIMITS, now });
const upstreams = defaultUpstreams({ relayBase: '/relay' });

const ROW = {
  OBJECT_NAME: 'STARLINK-1007', OBJECT_ID: '2019-074A', EPOCH: '2026-10-20T12:00:00.000000', MEAN_MOTION: '15.06',
  ECCENTRICITY: '0.0001', INCLINATION: '53.0', RA_OF_ASC_NODE: '10.0', ARG_OF_PERICENTER: '90.0', MEAN_ANOMALY: '270.0',
  EPHEMERIS_TYPE: '0', CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: '44713', ELEMENT_SET_NO: '999', REV_AT_EPOCH: '1000',
  BSTAR: '0.0001', MEAN_MOTION_DOT: '0.0001', MEAN_MOTION_DDOT: '0',
};

/** A fake relay that records requests: the answer is the relay contract's (query response status and body). */
function fakeRelay(answer: { status?: number; body?: string } = {}) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: { identity: string; password: string; query: string } }[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(String(init.body)) });
    return new Response(answer.body ?? JSON.stringify([ROW]), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch & { mock: unknown };
  return { impl, calls };
}

describe('fetchSpaceTrackGp (through the relay)', () => {
  it('posts { identity, password, query } to <relayBase>/spacetrack once and returns the OMM rows; no cookie, no login or logout from the browser', async () => {
    const f = fakeRelay();
    const omms = await fetchSpaceTrackGp(lim(), 'me@example.com', 'secret', { fetch: f.impl, upstreams });
    expect(omms).toHaveLength(1);
    expect(omms[0]).toMatchObject({ OBJECT_NAME: 'STARLINK-1007', NORAD_CAT_ID: 44713, MEAN_MOTION: 15.06 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ url: '/relay/spacetrack', method: 'POST' });
    expect(f.calls[0].body).toEqual({ identity: 'me@example.com', password: 'secret', query: STARLINK_QUERY });
    expect(f.calls[0].body.query.startsWith('/basicspacedata/query/')).toBe(true);
    expect(f.calls[0].headers['content-type']).toBe('application/json');
    expect(f.calls[0].headers.cookie).toBeUndefined();
  });

  it('uses the relay base from the upstream table, trailing slash or not', async () => {
    const f = fakeRelay();
    await fetchSpaceTrackGp(lim(), 'a', 'b', { fetch: f.impl, upstreams: defaultUpstreams({ relayBase: 'https://relay.example/r/' }) });
    expect(f.calls[0].url).toBe('https://relay.example/r/spacetrack');
  });

  it('refuses to send credentials anywhere but a relay', async () => {
    const f = fakeRelay();
    await expect(fetchSpaceTrackGp(lim(), 'a', 'b', { fetch: f.impl, upstreams: {} })).rejects.toThrow(/only reachable through the relay/);
    expect(f.calls).toHaveLength(0);
  });

  it('turns the relay rejected-login answer (401, stage "login") into an error without the password, and blocks for 6 h', async () => {
    for (const answer of [{ status: 401, body: '{"stage":"login","error":"login failed"}' }]) {
      let t = T0;
      const l = lim(() => t);
      const f = fakeRelay(answer);
      const err = await fetchSpaceTrackGp(l, 'me', 'hunter2', { fetch: f.impl, upstreams }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/login failed/);
      expect((err as Error).message).not.toContain('hunter2');
      expect((await l.status('spacetrack:query'))!.blockedUntil).toBe(T0 + FAILED_LOGIN_WAIT_MS);
      t += 5 * 3600_000;
      await expect(fetchSpaceTrackGp(l, 'me', 'hunter2', { fetch: f.impl, upstreams })).rejects.toBeInstanceOf(LimitedError);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('only a 401 with stage "login" is a bad login: other 401s, 502 and 504 are transient errors that do not block for 6 h', async () => {
    for (const answer of [
      { status: 401, body: 'unauthorised' }, { status: 401, body: '{"stage":"query","error":"x"}' },
      { status: 502, body: '{"stage":"login","error":"upstream failure"}' }, { status: 504, body: '{"stage":"query","error":"upstream timed out"}' },
    ]) {
      const l = lim();
      const err = (await fetchSpaceTrackGp(l, 'me', 'secret', { fetch: fakeRelay(answer).impl, upstreams }).catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(new RegExp(`HTTP ${answer.status} for Space-Track query`));
      expect(err.message).not.toMatch(/login failed/);
      expect((await l.status('spacetrack:query'))!.blockedUntil).toBeUndefined();
      expect((await l.status('spacetrack:login'))?.blockedUntil).toBeUndefined();
    }
  });

  it('refuses a cross-origin http: relay and accepts a same-origin path or https:', async () => {
    expect(isSafeRelayBase('/relay')).toBe(true);
    expect(isSafeRelayBase('https://relay.example/r')).toBe(true);
    for (const bad of ['http://relay.example/r', '//relay.example/r', 'ftp://x', 'relay']) expect(isSafeRelayBase(bad)).toBe(false);
    const f = fakeRelay();
    await expect(fetchSpaceTrackGp(lim(), 'a', 'b', { fetch: f.impl, upstreams: defaultUpstreams({ relayBase: 'http://relay.example/r' }) })).rejects.toThrow(/same-origin or https/);
    expect(f.calls).toHaveLength(0);
  });

  it('an upstream failure (502) is an error naming the status, with the password scrubbed from the excerpt', async () => {
    const f = fakeRelay({ status: 502, body: 'upstream said hunter2 is wrong somehow' });
    const err = (await fetchSpaceTrackGp(lim(), 'me', 'hunter2', { fetch: f.impl, upstreams }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/HTTP 502 for Space-Track query/);
    expect(err.message).not.toContain('hunter2');
  });

  it('a non-array body is not accepted as element sets', async () => {
    await expect(fetchSpaceTrackGp(lim(), 'a', 'b', { fetch: fakeRelay({ body: '{"error":"x"}' }).impl, upstreams })).rejects.toThrow(/JSON array/);
  });
});

describe('Space-Track limits', () => {
  it('counts the relay call on the query source: one per 2 h, 12 a day', async () => {
    const l = lim();
    await fetchSpaceTrackGp(l, 'me', 'secret', { fetch: fakeRelay().impl, upstreams });
    expect(await l.status('spacetrack:query')).toMatchObject({ used: 1, cap: 12, window: 'day', nextAllowedAt: T0 + 2 * 3600_000 });
  });

  it('a second fetch inside the 2 h gap sends nothing', async () => {
    let t = T0;
    const l = lim(() => t);
    const f = fakeRelay();
    await fetchSpaceTrackGp(l, 'me', 'secret', { fetch: f.impl, upstreams });
    t += 3600_000;
    await expect(fetchSpaceTrackGp(l, 'me', 'secret', { fetch: f.impl, upstreams })).rejects.toBeInstanceOf(LimitedError);
    expect(f.calls).toHaveLength(1);
    t += 3600_000 + 1;
    await fetchSpaceTrackGp(l, 'me', 'secret', { fetch: f.impl, upstreams });
    expect(f.calls).toHaveLength(2);
  });
});

describe('spacetrack connector', () => {
  const creds = (v: Record<string, string>): CredentialSource => ({ get: async (k) => v[k] });
  function setup(c: CredentialSource, answer?: { status?: number; body?: string }, over: { offline?: boolean } = {}) {
    const f = fakeRelay(answer);
    const store = new MemoryKv();
    const hub = new Hub(0);
    const http = new Http(store, { fetch: f.impl, limiter: new Limiter(store, { limits: LIMITS }), offline: over.offline });
    const health: { note?: string; fromCache?: boolean } = {};
    const soft: string[] = [];
    const ctx = { hub, store, http, health, config: engineConfig(), log: () => {}, softFail: (m: string) => void soft.push(m) };
    return { connector: createSpacetrack({ credentials: c, fetch: f.impl, upstreams }), f, ctx, store, hub, health, soft };
  }

  it('without credentials the run says what is needed and sends nothing', async () => {
    const s = setup(creds({ spacetrackUser: 'u' }));
    await expect(s.connector.run!(s.ctx as never)).rejects.toThrow(NEEDS_CREDENTIALS);
    expect(s.f.calls).toHaveLength(0);
  });

  it('downloads Starlink element sets, upserts them as starlink satellites and caches them for 3 h', async () => {
    const s = setup(creds({ spacetrackUser: 'u', spacetrackPassword: 'p' }));
    await s.connector.run!(s.ctx as never);
    expect(s.f.calls).toHaveLength(1);
    expect(s.hub.graph.get('sat-44713')).toMatchObject({ group: 'starlink', provider: { type: 'sgp4' } });
    expect(s.health.note).toBe('1 Starlink element sets');
    expect((await s.store.get('spacetrack:starlink'))!.ttlMs).toBe(3 * 3600_000);
    // the fresh copy answers the next run without a request
    await s.connector.run!(s.ctx as never);
    expect(s.f.calls).toHaveLength(1);
    expect(s.health.fromCache).toBe(true);
  });

  it('a failed download with a cached copy serves the copy as a soft failure and closes the gate', async () => {
    const s = setup(creds({ spacetrackUser: 'u', spacetrackPassword: 'p' }), { status: 502, body: 'bad gateway' });
    await s.store.put('spacetrack:starlink', [{ ...ROW, NORAD_CAT_ID: 44713, MEAN_MOTION: 15.06, ECCENTRICITY: 0.0001, BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0 }], 1, 0);
    await s.connector.run!(s.ctx as never);
    expect(s.hub.graph.get('sat-44713')).toBeDefined();
    expect(s.soft[0]).toMatch(/HTTP 502/);
    expect(await readBackoff(s.store, 'spacetrack')).toMatchObject({ failures: 1 });
    // the gate keeps the next run off the network
    await s.connector.run!(s.ctx as never);
    expect(s.f.calls).toHaveLength(1);
  });

  it('with nothing cached a failed download throws', async () => {
    const s = setup(creds({ spacetrackUser: 'u', spacetrackPassword: 'p' }), { status: 502, body: 'bad gateway' });
    await expect(s.connector.run!(s.ctx as never)).rejects.toThrow(/HTTP 502/);
  });
});

describe('saving Space-Track credentials', () => {
  it('lifts the failed-login block and the connector gate, but a second save inside the hour leaves a new block in place', async () => {
    const c = { t: T0 };
    const store = new MemoryKv();
    const limiter = new Limiter(store, { limits: LIMITS, now: () => c.t });
    const creds = new Credentials({ store, limiter });
    const blockBoth = async () => { for (const s of ['spacetrack:login', SPACETRACK_SOURCE]) await limiter.block(s, 6 * 3600_000, 'failed login', 'failure'); };
    await blockBoth();
    await recordFailure(store, 'spacetrack', new Error('HTTP 502 for Space-Track query'), c.t);
    expect(await readBackoff(store, 'spacetrack')).toBeDefined();
    // the keys the credentials module clears are the ones the connector uses
    await creds.update({ spacetrackPassword: 'one' });
    for (const s of ['spacetrack:login', SPACETRACK_SOURCE]) expect((await limiter.state(s)).blockedUntil).toBeUndefined();
    expect(await readBackoff(store, 'spacetrack')).toBeUndefined();
    await blockBoth(); // the bad account failed again
    c.t += 10 * 60_000;
    await creds.update({ spacetrackPassword: 'two' });
    expect((await limiter.state('spacetrack:login')).blockedUntil).toBeGreaterThan(c.t);
    c.t += CLEAR_BLOCK_EVERY_MS;
    await creds.update({ spacetrackPassword: 'three' });
    expect((await limiter.state('spacetrack:login')).blockedUntil).toBeUndefined();
    expect((await limiter.state(SPACETRACK_SOURCE)).blockedUntil).toBeUndefined();
  });
});
