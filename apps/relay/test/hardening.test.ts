import { describe, expect, it } from 'vitest';
import { createRelay, matchAllowed, type FetchLike } from '../src/handler';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function fake(script: Array<(c: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const body = init?.body == null ? '' : typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as Uint8Array);
    const c = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body };
    calls.push(c);
    return script[Math.min(calls.length - 1, script.length - 1)](c);
  };
  return { f, calls };
}

const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api?format=json';
const relayUrl = (u: string) => `http://app.test/relay?url=${encodeURIComponent(u)}`;
const ok = (b = '{}') => new Response(b, { status: 200, headers: { 'content-type': 'application/json' } });
const abortable = (init?: RequestInit) =>
  new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));

describe('path hardening', () => {
  it('refuses encoded slashes, dots, NUL and backslashes', () => {
    for (const p of [
      '/api/horizons.api%2f..%2f..%2fother',
      '/api/horizons.api%2F..%2Fother',
      '/api/horizons.api%5c..%5cother',
      '/api/horizons.api/%2e%2e/other',
      '/api/horizons.api/%2E%2E/other',
      '/api/horizons.api%00',
      '/api/horizons.api\\..\\other',
    ]) {
      expect(matchAllowed('https://ssd.jpl.nasa.gov' + p, 'GET'), p).toBeNull();
    }
    expect(matchAllowed('https://ssd.jpl.nasa.gov\\@evil.test/api/horizons.api', 'GET')).toBeNull();
    expect(matchAllowed('https://discosweb.esoc.esa.int/api/objects%2f..%2fx', 'GET')).toBeNull();
  });

  it('needs a segment boundary after the prefix', () => {
    expect(matchAllowed('https://ssd.jpl.nasa.gov/api/horizons.apiX', 'GET')).toBeNull();
    expect(matchAllowed('https://celestrak.org/NORAD/elements/gp.phpx', 'GET')).toBeNull();
    expect(matchAllowed('https://mast.stsci.edu/api/v0/invokeX', 'POST')).toBeNull();
    expect(matchAllowed('https://discosweb.esoc.esa.int/apix', 'GET')).toBeNull();
    expect(matchAllowed('https://ssd.jpl.nasa.gov/api/horizons.api', 'GET')).not.toBeNull();
    expect(matchAllowed('https://ssd.jpl.nasa.gov/api/horizons.api/', 'GET')).not.toBeNull();
  });

  it('normalises an uppercase host and :443, refuses a trailing dot, IPv6 and other ports', () => {
    expect(matchAllowed('https://SSD.JPL.NASA.GOV/api/horizons.api?x=1', 'GET')?.href).toBe('https://ssd.jpl.nasa.gov/api/horizons.api?x=1');
    expect(matchAllowed('https://ssd.jpl.nasa.gov:443/api/horizons.api', 'GET')?.href).toBe('https://ssd.jpl.nasa.gov/api/horizons.api');
    expect(matchAllowed('https://ssd.jpl.nasa.gov./api/horizons.api', 'GET')).toBeNull();
    expect(matchAllowed('https://[::1]/api/horizons.api', 'GET')).toBeNull();
    expect(matchAllowed('https://ssd.jpl.nasa.gov:444/api/horizons.api', 'GET')).toBeNull();
  });

  it('fetches the parsed URL, not the raw string', async () => {
    const { f, calls } = fake([() => ok()]);
    await createRelay({ fetch: f })(new Request(relayUrl('https://SSD.JPL.NASA.GOV:443/api/horizons.api?a=b')));
    expect(calls[0].url).toBe('https://ssd.jpl.nasa.gov/api/horizons.api?a=b');
  });

  it('applies the same checks to the Space-Track query path', async () => {
    const { f, calls } = fake([() => ok()]);
    const relay = createRelay({ fetch: f });
    for (const query of ['/basicspacedata/query/class%2f..%2fx', '/basicspacedata/query/a%5cb', '/basicspacedata/query/%2e%2e/x', '/basicspacedata/query/a\\b', '/basicspacedata/query/%00']) {
      const res = await relay(
        new Request('http://app.test/relay/spacetrack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: 'a', password: 'b', query }) }),
      );
      expect(res.status, query).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('response safety', () => {
  it('sets nosniff and a locked-down CSP on every answer, errors included', async () => {
    const { f } = fake([() => ok()]);
    const relay = createRelay({ fetch: f });
    for (const r of [await relay(new Request(relayUrl(HORIZONS))), await relay(new Request(relayUrl('https://evil.test/'))), await relay(new Request('http://app.test/relay/nope'))]) {
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    }
  });

  it('rewrites scriptable content types to text/plain and keeps JSON', async () => {
    for (const t of ['text/html; charset=utf-8', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml']) {
      const { f } = fake([() => new Response('<script>1</script>', { headers: { 'content-type': t } })]);
      const res = await createRelay({ fetch: f })(new Request(relayUrl(HORIZONS)));
      expect(res.headers.get('content-type'), t).toBe('text/plain; charset=utf-8');
    }
    const { f } = fake([() => new Response('{}', { headers: { 'content-type': 'application/json;charset=UTF-8' } })]);
    expect((await createRelay({ fetch: f })(new Request(relayUrl(HORIZONS)))).headers.get('content-type')).toBe('application/json;charset=UTF-8');
  });

  it('rewrites the content type of a Space-Track answer too', async () => {
    const { f } = fake([
      () => new Response('""', { status: 200, headers: { 'set-cookie': 'c=1' } }),
      () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      () => ok(''),
    ]);
    const res = await createRelay({ fetch: f })(
      new Request('http://app.test/relay/spacetrack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: 'a', password: 'b', query: '/basicspacedata/query/x' }) }),
    );
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('does not forward an Accept that asks for HTML', async () => {
    const { f, calls } = fake([() => ok(), () => ok()]);
    const relay = createRelay({ fetch: f });
    await relay(new Request(relayUrl(HORIZONS), { headers: { accept: 'text/html,application/xhtml+xml' } }));
    await relay(new Request(relayUrl(HORIZONS)));
    expect(calls[0].headers.get('accept')).not.toMatch(/html/);
    expect(calls[1].headers.get('accept')).not.toMatch(/html/);
  });
});

describe('disconnect, Vary, preflight and redirects with a body', () => {
  it('aborts the upstream fetch when the client request is aborted', async () => {
    let aborted = false;
    const f: FetchLike = (_u, init) => abortable(init).catch((e) => ((aborted = true), Promise.reject(e)));
    const ctl = new AbortController();
    const p = createRelay({ fetch: f })(new Request(relayUrl(HORIZONS), { signal: ctl.signal }));
    setTimeout(() => ctl.abort(), 10);
    await p;
    expect(aborted).toBe(true);
  });

  it('always sets Vary: Origin in list mode', async () => {
    const { f } = fake([() => ok()]);
    const relay = createRelay({ fetch: f, allowedOrigins: ['http://a.test'] });
    expect((await relay(new Request(relayUrl(HORIZONS)))).headers.get('vary')).toBe('Origin');
    expect((await relay(new Request(relayUrl(HORIZONS), { headers: { origin: 'http://b.test' } }))).headers.get('vary')).toBe('Origin');
  });

  it('gives no CORS permission in a preflight from a disallowed origin', async () => {
    const { f, calls } = fake([() => ok()]);
    const res = await createRelay({ fetch: f, allowedOrigins: ['http://a.test'] })(
      new Request('http://app.test/relay', { method: 'OPTIONS', headers: { origin: 'http://evil.test', 'access-control-request-method': 'POST' } }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('replays a POST body on 307/308 and re-checks the target', async () => {
    for (const status of [307, 308]) {
      const { f, calls } = fake([() => new Response(null, { status, headers: { location: 'https://mast.stsci.edu/api/v0/invoke?r=2' } }), () => ok()]);
      await createRelay({ fetch: f })(new Request(relayUrl('https://mast.stsci.edu/api/v0/invoke'), { method: 'POST', body: 'a=b', headers: { 'content-type': 'text/plain' } }));
      expect(calls[1].method).toBe('POST');
      expect(calls[1].body).toBe('a=b');
      const bad = fake([() => new Response(null, { status, headers: { location: 'https://evil.test/x' } }), () => ok()]);
      const res = await createRelay({ fetch: bad.f })(new Request(relayUrl('https://mast.stsci.edu/api/v0/invoke'), { method: 'POST', body: 'a=b' }));
      expect(res.status).toBe(403);
      expect(bad.calls).toHaveLength(1);
    }
  });
});

describe('space-track caller checks, login outcome and edge cases', () => {
  const body = JSON.stringify({ identity: 'a', password: 'b', query: '/basicspacedata/query/x' });
  const mk = (headers: Record<string, string>) => new Request('http://app.test/relay/spacetrack', { method: 'POST', headers, body });
  const json = { 'content-type': 'application/json' };
  const login = () => new Response('""', { status: 200, headers: { 'set-cookie': 'c=1' } });

  it('requires application/json', async () => {
    const { f, calls } = fake([login, () => ok(), () => ok('')]);
    expect((await createRelay({ fetch: f })(mk({ 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await createRelay({ fetch: f })(mk({}))).status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it('refuses a cross-site POST but accepts same-origin, allowed origins and plain clients', async () => {
    const f: FetchLike = async (u) => (u.endsWith('/login') ? login() : ok('[]'));
    const relay = createRelay({ fetch: f, allowedOrigins: ['http://dev.test'] });
    expect((await relay(mk({ ...json, origin: 'http://evil.test' }))).status).toBe(403);
    expect((await relay(mk({ ...json, 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await relay(mk({ ...json, origin: 'http://app.test' }))).status).toBe(200);
    expect((await relay(mk({ ...json, origin: 'http://dev.test' }))).status).toBe(200);
    expect((await relay(mk(json))).status).toBe(200);
  });

  it('a wrong login is 401, no cookie is 401, an upstream outage is 502 or 504, each with a stage', async () => {
    const failed = fake([() => new Response('{"Login":"Failed"}', { status: 200 })]);
    const a = await createRelay({ fetch: failed.f })(mk(json));
    expect(a.status).toBe(401);
    expect(await a.json()).toEqual({ stage: 'login', error: 'login failed' });
    const nocookie = fake([() => new Response('""', { status: 200 })]);
    expect((await createRelay({ fetch: nocookie.f })(mk(json))).status).toBe(401);
    const down = fake([() => new Response('', { status: 503 })]);
    const b = await createRelay({ fetch: down.f })(mk(json));
    expect(b.status).toBe(502);
    expect(await b.json()).toMatchObject({ stage: 'login' });
    const throws: FetchLike = async (u) => {
      if (u.endsWith('/login')) return login();
      throw new Error('net');
    };
    const c = await createRelay({ fetch: throws })(mk(json));
    expect(c.status).toBe(502);
    expect(await c.json()).toMatchObject({ stage: 'query' });
  });

  it('answers an empty query result without a body error', async () => {
    const a = fake([login, () => new Response(null, { status: 204 }), () => ok('')]);
    expect((await createRelay({ fetch: a.f })(mk(json))).status).toBe(204);
    const b = fake([login, () => new Response('', { status: 200 }), () => ok('')]);
    const res = await createRelay({ fetch: b.f })(mk(json));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('still logs out when reading the login body fails after a cookie was set', async () => {
    const urls: string[] = [];
    const f: FetchLike = async (u) => {
      urls.push(u);
      if (u.endsWith('/login')) {
        return new Response(new ReadableStream({ pull: (c) => c.error(new Error('reset')) }), { status: 200, headers: { 'set-cookie': 'c=1' } });
      }
      return new Response('', { status: 200 });
    };
    const res = await createRelay({ fetch: f })(mk(json));
    expect(res.status).toBe(502);
    expect(urls[urls.length - 1]).toMatch(/logout$/);
  });

  it('keeps the whole request inside the budget when the query and the logout hang', async () => {
    const f: FetchLike = (u, init) => (u.endsWith('/login') ? Promise.resolve(login()) : abortable(init));
    const t0 = Date.now();
    const res = await createRelay({ fetch: f, timeoutMs: 10_000, spacetrackBudgetMs: 4_600 })(mk(json));
    expect(res.status).toBe(504);
    expect(Date.now() - t0).toBeLessThan(5_400);
  });
});
