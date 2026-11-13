import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { FAILED_LOGIN_WAIT_MS, STARLINK_QUERY, fetchSpaceTrackGp, spacetrack } from '../src/connectors/spacetrack';
import { Limiter, LimitedError } from '../src/net/limiter';
import { LIMITS } from '../src/net/limits';
import { Store } from '../src/store';

const T0 = Date.parse('2026-11-01T10:00:00Z');
/** the real Space-Track limits on a fixed clock (the table is the default; tests that fire many requests turn limits off) */
const lim = (now = () => T0, store = new Store(':memory:')) => new Limiter(store, { limits: LIMITS, now });

const ROW = {
  OBJECT_NAME: 'STARLINK-1007', OBJECT_ID: '2019-074A', EPOCH: '2026-10-20T12:00:00.000000', MEAN_MOTION: '15.06',
  ECCENTRICITY: '0.0001', INCLINATION: '53.0', RA_OF_ASC_NODE: '10.0', ARG_OF_PERICENTER: '90.0', MEAN_ANOMALY: '270.0',
  EPHEMERIS_TYPE: '0', CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: '44713', ELEMENT_SET_NO: '999', REV_AT_EPOCH: '1000',
  BSTAR: '0.0001', MEAN_MOTION_DOT: '0.0001', MEAN_MOTION_DDOT: '0',
};

/** A fake fetch that records requests and answers by path. */
function fakeFetch(opts: { loginBody?: string; cookie?: boolean; dataStatus?: number } = {}) {
  const calls: { url: string; method: string; body?: string; cookie?: string }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url, method: init.method ?? 'GET', body: init.body?.toString(),
      cookie: (init.headers as Record<string, string> | undefined)?.cookie,
    });
    if (url.endsWith('/ajaxauth/login')) {
      const headers = new Headers();
      if (opts.cookie !== false) headers.append('set-cookie', 'chocolatechip=abc123; path=/; HttpOnly');
      return new Response(opts.loginBody ?? '""', { status: 200, headers });
    }
    if (url.endsWith('/ajaxauth/logout')) return new Response('', { status: 200 });
    return new Response(opts.dataStatus && opts.dataStatus !== 200 ? 'nope' : JSON.stringify([ROW]), { status: opts.dataStatus ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('fetchSpaceTrackGp', () => {
  it('logs in, queries with the session cookie, logs out and returns OMM rows', async () => {
    const f = fakeFetch();
    const omms = await fetchSpaceTrackGp(lim(), 'me@example.com', 'secret', { fetch: f.impl });
    expect(omms).toHaveLength(1);
    expect(omms[0]).toMatchObject({ OBJECT_NAME: 'STARLINK-1007', NORAD_CAT_ID: 44713, MEAN_MOTION: 15.06 });
    expect(f.calls.map((c) => `${c.method} ${c.url.replace('https://www.space-track.org', '')}`)).toEqual([
      'POST /ajaxauth/login', `GET ${STARLINK_QUERY}`, 'GET /ajaxauth/logout',
    ]);
    expect(new URLSearchParams(f.calls[0].body).get('identity')).toBe('me@example.com');
    expect(f.calls[1].cookie).toBe('chocolatechip=abc123');
  });

  it('turns a failed login into an error that does not contain the password', async () => {
    const f = fakeFetch({ loginBody: '{"Login":"Failed"}' });
    const err = await fetchSpaceTrackGp(lim(), 'me', 'hunter2', { fetch: f.impl }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/login failed/);
    expect((err as Error).message).not.toContain('hunter2');
    expect(f.calls).toHaveLength(1); // no query without a session
  });

  it('fails when no session cookie comes back', async () => {
    await expect(fetchSpaceTrackGp(lim(), 'a', 'b', { fetch: fakeFetch({ cookie: false }).impl })).rejects.toThrow(/no session cookie/);
  });

  it('logs out even when the query fails', async () => {
    const f = fakeFetch({ dataStatus: 500 });
    await expect(fetchSpaceTrackGp(lim(), 'a', 'b', { fetch: f.impl })).rejects.toThrow(/HTTP 500/);
    expect(f.calls.at(-1)!.url).toMatch(/logout$/);
  });
});

describe('Space-Track limits', () => {
  it('counts the three requests on their own sources: login, query and logout', async () => {
    const l = lim();
    await fetchSpaceTrackGp(l, 'me', 'secret', { fetch: fakeFetch().impl });
    expect(l.status('spacetrack:login')).toMatchObject({ used: 1, cap: 4, window: 'hour' });
    expect(l.status('spacetrack:query')).toMatchObject({ used: 1, cap: 12, window: 'day', nextAllowedAt: T0 + 2 * 3600_000 });
    expect(l.status('spacetrack:logout')).toMatchObject({ used: 1, cap: 8 });
  });

  it('one GP query per 2 h: a second fetch inside the gap sends nothing, not even a login', async () => {
    let t = T0;
    const l = lim(() => t);
    const f = fakeFetch();
    await fetchSpaceTrackGp(l, 'me', 'secret', { fetch: f.impl });
    t += 3600_000;
    await expect(fetchSpaceTrackGp(l, 'me', 'secret', { fetch: f.impl })).rejects.toBeInstanceOf(LimitedError);
    expect(f.calls).toHaveLength(3);
    t += 3600_000 + 1;
    await fetchSpaceTrackGp(l, 'me', 'secret', { fetch: f.impl });
    expect(f.calls).toHaveLength(6);
  });

  it('a failed login blocks login and query for 6 h; nothing is sent in that time', async () => {
    let t = T0;
    const l = lim(() => t);
    const f = fakeFetch({ loginBody: '{"Login":"Failed"}' });
    await expect(fetchSpaceTrackGp(l, 'me', 'wrong', { fetch: f.impl })).rejects.toThrow(/login failed/);
    expect(l.status('spacetrack:query')!.blockedUntil).toBe(T0 + FAILED_LOGIN_WAIT_MS);
    t += 5 * 3600_000;
    await expect(fetchSpaceTrackGp(l, 'me', 'wrong', { fetch: f.impl })).rejects.toBeInstanceOf(LimitedError);
    expect(f.calls).toHaveLength(1);
  });
});

describe('spacetrack connector', () => {
  it('reports a stub note until both credentials are set, then runs', () => {
    expect(spacetrack.stub!(loadConfig({}))).toMatch(/SPACETRACK_USER and SPACETRACK_PASSWORD/);
    expect(spacetrack.stub!(loadConfig({ SPACETRACK_USER: 'u' }))).toMatch(/SPACETRACK_PASSWORD/);
    expect(spacetrack.stub!(loadConfig({ SPACETRACK_USER: 'u', SPACETRACK_PASSWORD: 'p' }))).toBeUndefined();
  });
});
