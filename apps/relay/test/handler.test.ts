import { describe, expect, it } from 'vitest';
import { createRelay, matchAllowed, type FetchLike } from '../src/handler';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** a fake upstream: `script` answers each call in order (or by function) and every call is recorded */
function fake(script: Array<(c: Call, signal?: AbortSignal | null) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    const body = init?.body == null ? '' : typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as Uint8Array);
    const c = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(c);
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return step(c, init?.signal);
  };
  return { f, calls };
}

const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api?format=json&COMMAND=499';
const relayUrl = (u: string, base = 'http://app.test/relay') => `${base}?url=${encodeURIComponent(u)}`;
const ok = (body = '{}', init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('relay allow-list', () => {
  it('allows the listed upstreams and methods', () => {
    expect(matchAllowed(HORIZONS, 'GET')).not.toBeNull();
    expect(matchAllowed(HORIZONS, 'POST')).not.toBeNull();
    expect(matchAllowed('https://discosweb.esoc.esa.int/api/objects?filter=x', 'GET')).not.toBeNull();
    expect(matchAllowed('https://mast.stsci.edu/api/v0/invoke', 'POST')).not.toBeNull();
    expect(matchAllowed('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json', 'GET')).not.toBeNull();
    expect(matchAllowed('https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json', 'GET')).not.toBeNull();
    expect(matchAllowed('https://mars.nasa.gov/other/', 'GET')).toBeNull();
    expect(matchAllowed('https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json', 'POST')).toBeNull();
  });

  it('rejects other hosts, schemes, ports, credentials, paths and methods', () => {
    expect(matchAllowed('https://example.com/api/horizons.api', 'GET')).toBeNull();
    expect(matchAllowed('http://ssd.jpl.nasa.gov/api/horizons.api', 'GET')).toBeNull();
    expect(matchAllowed('https://ssd.jpl.nasa.gov:8443/api/horizons.api', 'GET')).toBeNull();
    expect(matchAllowed('https://user:pw@ssd.jpl.nasa.gov/api/horizons.api', 'GET')).toBeNull();
    expect(matchAllowed('https://ssd.jpl.nasa.gov.evil.test/api/horizons.api', 'GET')).toBeNull();
    expect(matchAllowed('https://ssd.jpl.nasa.gov@evil.test/api/horizons.api', 'GET')).toBeNull();
    expect(matchAllowed('https://ssd.jpl.nasa.gov/api/other', 'GET')).toBeNull();
    expect(matchAllowed('https://ssd.jpl.nasa.gov/api/../secret', 'GET')).toBeNull();
    expect(matchAllowed('https://celestrak.org/NORAD/elements/gp.php', 'POST')).toBeNull();
    expect(matchAllowed('https://discosweb.esoc.esa.int/api/objects', 'POST')).toBeNull();
    expect(matchAllowed('https://celestrak.org/NORAD/elements/other.php', 'GET')).toBeNull();
    expect(matchAllowed('not a url', 'GET')).toBeNull();
  });

  it('answers 403 for a non-allow-listed target without calling upstream', async () => {
    const { f, calls } = fake([() => ok()]);
    const relay = createRelay({ fetch: f });
    const res = await relay(new Request(relayUrl('https://example.com/x')));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('answers 400 without a url, 404 elsewhere, 405 for a bad method', async () => {
    const { f } = fake([() => ok()]);
    const relay = createRelay({ fetch: f });
    expect((await relay(new Request('http://app.test/relay'))).status).toBe(400);
    expect((await relay(new Request('http://app.test/other'))).status).toBe(404);
    expect((await relay(new Request('http://app.test/relay/nothing'))).status).toBe(404);
    expect((await relay(new Request(relayUrl(HORIZONS), { method: 'DELETE' }))).status).toBe(405);
  });

  it('honours a different mount point', async () => {
    const { f } = fake([() => ok('x')]);
    const relay = createRelay({ fetch: f, base: '/r' });
    expect((await relay(new Request(relayUrl(HORIZONS, 'http://h/r')))).status).toBe(200);
    expect((await relay(new Request(relayUrl(HORIZONS)))).status).toBe(404);
  });
});

describe('relay pass-through', () => {
  it('streams status, body and the listed response headers; drops the rest and cookies', async () => {
    const { f } = fake([
      () =>
        new Response('hello', {
          status: 429,
          headers: {
            'content-type': 'text/plain',
            'cache-control': 'max-age=5',
            'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
            'retry-after': '120',
            'x-ratelimit-remaining': '0',
            'x-rate-limit-limit': '5',
            'set-cookie': 'sid=secret',
            'x-powered-by': 'php',
            'content-encoding': 'gzip',
          },
        }),
    ]);
    const res = await createRelay({ fetch: f })(new Request(relayUrl(HORIZONS)));
    expect(res.status).toBe(429);
    expect(await res.text()).toBe('hello');
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('retry-after')).toBe('120');
    expect(res.headers.get('cache-control')).toBe('max-age=5');
    expect(res.headers.get('last-modified')).toContain('2025');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(res.headers.get('x-rate-limit-limit')).toBe('5');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('forwards only accept and content-type, sets a generic user agent, never cookies', async () => {
    const { f, calls } = fake([() => ok()]);
    await createRelay({ fetch: f })(
      new Request(relayUrl(HORIZONS), {
        headers: { accept: 'application/json', cookie: 'a=b', authorization: 'Bearer x', 'x-custom': '1', 'user-agent': 'victim-browser', referer: 'http://app.test/' },
      }),
    );
    const h = calls[0].headers;
    expect(h.get('accept')).toBe('application/json');
    expect(h.get('cookie')).toBeNull();
    expect(h.get('authorization')).toBeNull();
    expect(h.get('x-custom')).toBeNull();
    expect(h.get('referer')).toBeNull();
    expect(h.get('user-agent')).toMatch(/^EyesInOrbit-relay/);
  });

  it('forwards authorization to discosweb only', async () => {
    const { f, calls } = fake([() => ok(), () => ok()]);
    const relay = createRelay({ fetch: f });
    const headers = { authorization: 'Bearer tok', 'discosweb-apiversion': '2' };
    await relay(new Request(relayUrl('https://discosweb.esoc.esa.int/api/objects'), { headers }));
    await relay(new Request(relayUrl(HORIZONS), { headers }));
    expect(calls[0].headers.get('authorization')).toBe('Bearer tok');
    expect(calls[0].headers.get('discosweb-apiversion')).toBe('2');
    expect(calls[1].headers.get('authorization')).toBeNull();
    expect(calls[1].headers.get('discosweb-apiversion')).toBeNull();
  });

  it('passes a POST body and content-type to MAST', async () => {
    const { f, calls } = fake([() => ok()]);
    const res = await createRelay({ fetch: f })(
      new Request(relayUrl('https://mast.stsci.edu/api/v0/invoke'), { method: 'POST', body: 'request={"service":"X"}', headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    );
    expect(res.status).toBe(200);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBe('request={"service":"X"}');
    expect(calls[0].headers.get('content-type')).toBe('application/x-www-form-urlencoded');
  });

  it('answers HEAD without a body', async () => {
    const { f, calls } = fake([() => new Response(null, { status: 200, headers: { 'content-type': 'text/csv' } })]);
    const res = await createRelay({ fetch: f })(new Request(relayUrl(HORIZONS), { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(calls[0].method).toBe('HEAD');
  });

  it('maps an unreachable upstream to 502 without leaking the error text', async () => {
    const f: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:443 secret-token');
    };
    const res = await createRelay({ fetch: f })(new Request(relayUrl(HORIZONS)));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toMatch(/10\.1\.2\.3|secret-token/);
  });
});

describe('relay redirects', () => {
  const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

  it('follows a redirect that stays in the allow-list and re-checks each hop', async () => {
    const { f, calls } = fake([() => redirect('/api/horizons.api?x=2'), () => ok('final')]);
    const res = await createRelay({ fetch: f })(new Request(relayUrl(HORIZONS)));
    expect(await res.text()).toBe('final');
    expect(calls[1].url).toBe('https://ssd.jpl.nasa.gov/api/horizons.api?x=2');
  });

  it('refuses a redirect out of the allow-list with 403', async () => {
    const { f, calls } = fake([() => redirect('https://evil.test/steal'), () => ok()]);
    const res = await createRelay({ fetch: f })(new Request(relayUrl(HORIZONS)));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it('refuses a downgrade to http and a hop to another allowed host only with a matching path', async () => {
    const a = fake([() => redirect('http://ssd.jpl.nasa.gov/api/horizons.api')]);
    expect((await createRelay({ fetch: a.f })(new Request(relayUrl(HORIZONS)))).status).toBe(403);
    const b = fake([() => redirect('https://celestrak.org/other')]);
    expect((await createRelay({ fetch: b.f })(new Request(relayUrl(HORIZONS)))).status).toBe(403);
  });

  it('drops the authorization header on a hop to a host that is not discosweb', async () => {
    const { f, calls } = fake([() => redirect('https://celestrak.org/NORAD/elements/gp.php?G=1'), () => ok()]);
    await createRelay({ fetch: f })(
      new Request(relayUrl('https://discosweb.esoc.esa.int/api/objects'), { headers: { authorization: 'Bearer tok' } }),
    );
    expect(calls[0].headers.get('authorization')).toBe('Bearer tok');
    expect(calls[1].headers.get('authorization')).toBeNull();
  });

  it('stops after the hop limit', async () => {
    const { f, calls } = fake([() => redirect(HORIZONS)]);
    const res = await createRelay({ fetch: f })(new Request(relayUrl(HORIZONS)));
    expect(res.status).toBe(502);
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it('turns a 303 after POST into a body-less GET', async () => {
    const { f, calls } = fake([() => redirect('https://mast.stsci.edu/api/v0/invoke?r=1', 303), () => ok()]);
    await createRelay({ fetch: f })(new Request(relayUrl('https://mast.stsci.edu/api/v0/invoke'), { method: 'POST', body: 'a=b' }));
    expect(calls[1].method).toBe('GET');
    expect(calls[1].body).toBe('');
  });
});

describe('relay limits', () => {
  it('refuses a declared oversized response with 502', async () => {
    const { f } = fake([() => ok('x', { headers: { 'content-length': '5000' } })]);
    const res = await createRelay({ fetch: f, maxResponseBytes: 1000 })(new Request(relayUrl(HORIZONS)));
    expect(res.status).toBe(502);
  });

  it('errors the stream when an undeclared body passes the cap', async () => {
    const { f } = fake([() => new Response(new Blob([new Uint8Array(5000)]).stream())]);
    const res = await createRelay({ fetch: f, maxResponseBytes: 1000 })(new Request(relayUrl(HORIZONS)));
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it('passes a body under the cap whole', async () => {
    const { f } = fake([() => new Response(new Uint8Array(900))]);
    const res = await createRelay({ fetch: f, maxResponseBytes: 1000 })(new Request(relayUrl(HORIZONS)));
    expect((await res.arrayBuffer()).byteLength).toBe(900);
  });

  it('answers 504 when the upstream does not answer in time', async () => {
    const f: FetchLike = (_u, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const res = await createRelay({ fetch: f, timeoutMs: 20 })(new Request(relayUrl(HORIZONS)));
    expect(res.status).toBe(504);
  });

  it('rejects an oversized request body with 413', async () => {
    const { f, calls } = fake([() => ok()]);
    const res = await createRelay({ fetch: f })(
      new Request(relayUrl('https://mast.stsci.edu/api/v0/invoke'), { method: 'POST', body: new Uint8Array(1024 * 1024 + 1) }),
    );
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});

describe('relay CORS', () => {
  it('adds no CORS headers by default (same-origin only)', async () => {
    const { f } = fake([() => ok()]);
    const res = await createRelay({ fetch: f })(new Request(relayUrl(HORIZONS), { headers: { origin: 'http://other.test' } }));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes an allowed origin and exposes the forwarded headers, errors included', async () => {
    const { f } = fake([() => ok('{}', { headers: { 'content-type': 'application/json', 'retry-after': '3', 'x-ratelimit-remaining': '9' } })]);
    const relay = createRelay({ fetch: f, allowedOrigins: ['http://localhost:5173'] });
    const res = await relay(new Request(relayUrl(HORIZONS), { headers: { origin: 'http://localhost:5173' } }));
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('vary')).toBe('Origin');
    const exposed = res.headers.get('access-control-expose-headers') ?? '';
    expect(exposed).toContain('retry-after');
    expect(exposed).toContain('x-ratelimit-remaining');
    const denied = await relay(new Request(relayUrl('https://evil.test/'), { headers: { origin: 'http://localhost:5173' } }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const other = await relay(new Request(relayUrl(HORIZONS), { headers: { origin: 'http://evil.test' } }));
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers the preflight without calling upstream', async () => {
    const { f, calls } = fake([() => ok()]);
    const relay = createRelay({ fetch: f, allowedOrigins: '*' });
    const res = await relay(new Request('http://app.test/relay/spacetrack', { method: 'OPTIONS', headers: { origin: 'http://x.test', 'access-control-request-method': 'POST' } }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
    expect(calls).toHaveLength(0);
  });
});

describe('relay space-track', () => {
  const post = (body: unknown, raw = false) =>
    new Request('http://app.test/relay/spacetrack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? (body as string) : JSON.stringify(body) });
  const good = { identity: 'me@example.test', password: 'hunter2-secret', query: '/basicspacedata/query/class/gp/NORAD_CAT_ID/25544/format/json' };
  const loginOk = () => new Response('""', { status: 200, headers: { 'set-cookie': 'chocolatechip=abc123; path=/; HttpOnly' } });

  it('logs in, queries with the cookie, logs out, returns the query response', async () => {
    const { f, calls } = fake([
      loginOk,
      () => new Response('[{"A":1}]', { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '7', 'set-cookie': 'leak=1' } }),
      () => new Response('', { status: 200 }),
    ]);
    const res = await createRelay({ fetch: f })(post(good));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('[{"A":1}]');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('7');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://www.space-track.org/ajaxauth/login',
      'GET https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/25544/format/json',
      'GET https://www.space-track.org/ajaxauth/logout',
    ]);
    expect(new URLSearchParams(calls[0].body).get('identity')).toBe(good.identity);
    expect(new URLSearchParams(calls[0].body).get('password')).toBe(good.password);
    expect(calls[1].headers.get('cookie')).toBe('chocolatechip=abc123');
    expect(calls[2].headers.get('cookie')).toBe('chocolatechip=abc123');
    expect(calls[1].body).toBe('');
  });

  it('keeps no session between requests', async () => {
    const { f, calls } = fake([loginOk, () => ok('[]'), () => ok(''), () => new Response('""', { status: 200 }), () => ok('')]);
    const relay = createRelay({ fetch: f });
    await relay(post(good));
    const second = await relay(post(good));
    expect(second.status).toBe(401);
    expect(calls[3].headers.get('cookie')).toBeNull();
  });

  it('rejects malformed bodies with 400 and calls nothing', async () => {
    const { f, calls } = fake([() => ok()]);
    const relay = createRelay({ fetch: f });
    expect((await relay(post('not json', true))).status).toBe(400);
    expect((await relay(post({ identity: 'a', password: 'b' }))).status).toBe(400);
    expect((await relay(post({ ...good, password: '' }))).status).toBe(400);
    expect((await relay(post({ ...good, identity: 5 }))).status).toBe(400);
    expect((await relay(new Request('http://app.test/relay/spacetrack'))).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it('rejects a query outside /basicspacedata/query/ with 403', async () => {
    const { f, calls } = fake([() => ok()]);
    const relay = createRelay({ fetch: f });
    for (const query of ['/modeldef/class/gp', '/basicspacedata/query', 'https://evil.test/basicspacedata/query/x', '/basicspacedata/query/../../ajaxauth/logout', '//evil.test/basicspacedata/query/']) {
      expect((await relay(post({ ...good, query }))).status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('reports a rejected login as 401 and never queries', async () => {
    const { f, calls } = fake([() => new Response('{"Login":"Failed"}', { status: 200 })]);
    const res = await createRelay({ fetch: f })(post(good));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ stage: 'login', error: 'login failed' });
    expect(calls).toHaveLength(1);
  });

  it('logs out after a failed query and still answers 502', async () => {
    let n = 0;
    const f: FetchLike = async (u) => {
      n++;
      if (u.endsWith('/ajaxauth/login')) return loginOk();
      if (u.includes('/basicspacedata/')) throw new Error('boom hunter2-secret me@example.test');
      return new Response('', { status: 200 });
    };
    const urls: string[] = [];
    const spy: FetchLike = (u, i) => (urls.push(u), f(u, i));
    const res = await createRelay({ fetch: spy })(post(good));
    expect(res.status).toBe(502);
    expect(urls[urls.length - 1]).toBe('https://www.space-track.org/ajaxauth/logout');
    expect(n).toBe(3);
  });

  it('logs out after an oversized query response', async () => {
    const { f, calls } = fake([loginOk, () => new Response(new Uint8Array(5000)), () => ok('')]);
    const res = await createRelay({ fetch: f, maxResponseBytes: 1000 })(post(good));
    expect(res.status).toBe(502);
    expect(calls[calls.length - 1].url).toMatch(/logout$/);
  });

  it('passes an upstream error status of the query through', async () => {
    const { f } = fake([loginOk, () => new Response('slow down', { status: 429, headers: { 'retry-after': '60' } }), () => ok('')]);
    const res = await createRelay({ fetch: f })(post(good));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it('answers 504 on a timeout and still logs out when it had a session', async () => {
    const urls: string[] = [];
    const f: FetchLike = (u, init) => {
      urls.push(u);
      if (u.endsWith('/ajaxauth/login')) return Promise.resolve(loginOk());
      if (u.endsWith('/logout')) return Promise.resolve(new Response('', { status: 200 }));
      return new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
    };
    const res = await createRelay({ fetch: f, timeoutMs: 30 })(post(good));
    expect(res.status).toBe(504);
    expect(urls[urls.length - 1]).toMatch(/logout$/);
  });

  it('never puts the identity, the password or the cookie into an error body', async () => {
    const f: FetchLike = async (u) => {
      if (u.endsWith('/ajaxauth/login')) return loginOk();
      throw new Error(`failed for ${good.identity} ${good.password} chocolatechip=abc123`);
    };
    const res = await createRelay({ fetch: f })(post(good));
    const text = await res.text();
    expect(text).not.toContain(good.password);
    expect(text).not.toContain(good.identity);
    expect(text).not.toContain('abc123');
    const bad = await createRelay({ fetch: f })(post({ ...good, query: '/x' }));
    expect(await bad.text()).not.toContain(good.password);
  });
});
