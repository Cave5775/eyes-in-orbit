// Stateless, allow-listed pass-through for the upstreams that send no CORS headers.
//
// A pure Web-standard `(req: Request) => Promise<Response>` with an injected `fetch`, so the same code runs under
// Node 24 (src/node.ts), the Vite dev server, Cloudflare Workers, Deno and Vercel edge. It keeps no state, stores
// nothing, holds no keys and never logs: there is no console call in this file, and error texts never contain a
// request header, a request body or a credential.
//
// Contract (the browser engine codes to it):
//   GET|HEAD|POST <base>?url=<encodeURIComponent(upstream URL)>   generic pass-through, allow-listed
//   POST <base>/spacetrack  {identity, password, query}           login, one query, logout, in one request
//   OPTIONS                                                         CORS preflight

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RelayOptions {
  /** the fetch used for every upstream call (inject a fake in tests) */
  fetch: FetchLike;
  /** where the handler is mounted; the path after it picks the route */
  base?: string;
  /** Origins that may call the relay from another origin ('*' allows any). Unset: same-origin only, no CORS headers. */
  allowedOrigins?: string[] | '*';
  userAgent?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Generic, no personal data: says what the client is and nothing about who runs it. */
export const DEFAULT_USER_AGENT = 'EyesInOrbit-relay/0.1 (stateless pass-through)';

// Per upstream call, covering the headers and the whole body. Horizons answers in a few seconds, MAST invoke and a
// large DISCOS page in up to about 20 s; 45 s leaves room for a slow upstream yet stays under the 60 s limit that
// most fetch-handler hosts (edge functions, reverse proxies) put on one request.
export const DEFAULT_TIMEOUT_MS = 45_000;
// Cap on one upstream response. The largest legitimate answer is a Space-Track GP group or a MAST product list
// (a few MB, up to ~25 MB for a very large group); 32 MiB covers that and stops a hostile or broken upstream from
// streaming an unbounded body through the host's memory and bandwidth.
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// A request body (MAST invoke JSON, Horizons POST) is small; it is buffered so a redirect can replay it.
export const MAX_REQUEST_BYTES = 1024 * 1024;
// Redirect hops followed, each one re-checked against the allow-list.
export const MAX_REDIRECTS = 4;

interface AllowEntry {
  origin: string;
  pathPrefix: string;
  methods: string[];
  /** the only upstream that receives the client's Authorization header */
  auth?: boolean;
}

// Exact scheme + host (no port), path prefix. POST only where the upstream needs it.
export const ALLOW_LIST: readonly AllowEntry[] = [
  { origin: 'https://ssd.jpl.nasa.gov', pathPrefix: '/api/horizons.api', methods: ['GET', 'HEAD', 'POST'] },
  { origin: 'https://discosweb.esoc.esa.int', pathPrefix: '/api/', methods: ['GET', 'HEAD'], auth: true },
  { origin: 'https://mast.stsci.edu', pathPrefix: '/api/v0/invoke', methods: ['GET', 'HEAD', 'POST'] },
  { origin: 'https://celestrak.org', pathPrefix: '/NORAD/elements/gp.php', methods: ['GET', 'HEAD'] },
];

const SPACETRACK_ORIGIN = 'https://www.space-track.org';
const SPACETRACK_QUERY_PREFIX = '/basicspacedata/query/';

const FORWARD_REQUEST_HEADERS = ['accept', 'content-type'];
// DISCOS refuses a request without its API version; forwarded to discosweb only, with the Authorization header
const DISCOS_ONLY_HEADERS = ['authorization', 'discosweb-apiversion'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'last-modified', 'retry-after'];
const RATE_HEADER = /^x-rate-?limit-/i;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export function matchAllowed(rawUrl: string, method: string): AllowEntry | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  for (const e of ALLOW_LIST) {
    if (u.origin === e.origin && u.pathname.startsWith(e.pathPrefix) && e.methods.includes(method)) return e;
  }
  return null;
}

function json(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

type ResponseBody = ConstructorParameters<typeof Response>[0];

class TooLarge extends Error {}

/** Wraps a body so it errors once more than `max` bytes pass through (the upstream may lie about or omit its length). */
function capStream(body: ReadableStream<Uint8Array>, max: number, done: () => void): ReadableStream<Uint8Array> {
  let n = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        n += chunk.byteLength;
        if (n > max) {
          ctl.error(new TooLarge('response too large'));
          return;
        }
        ctl.enqueue(chunk);
      },
      flush: done,
    }),
  );
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const lenHeader = Number(res.headers.get('content-length'));
  if (lenHeader > max) throw new TooLarge('response too large');
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new TooLarge('response too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export function createRelay(opts: RelayOptions): (req: Request) => Promise<Response> {
  const base = (opts.base ?? '/relay').replace(/\/+$/, '');
  const ua = opts.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  function corsHeaders(req: Request): Record<string, string> {
    const allowed = opts.allowedOrigins;
    const origin = req.headers.get('origin');
    if (!allowed || !origin) return {};
    if (allowed === '*') return { 'access-control-allow-origin': '*' };
    if (allowed.includes(origin)) return { 'access-control-allow-origin': origin, vary: 'Origin' };
    return {};
  }

  function withCors(res: Response, req: Request): Response {
    const cors = corsHeaders(req);
    if (!Object.keys(cors).length) return res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    const exposed: string[] = [];
    res.headers.forEach((_v, k) => {
      if (FORWARD_RESPONSE_HEADERS.includes(k) || RATE_HEADER.test(k)) exposed.push(k);
    });
    if (exposed.length) headers.set('access-control-expose-headers', exposed.join(', '));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  /** one upstream call with a deadline; the timer is released by `release` once the body is finished */
  async function call(url: string, init: RequestInit): Promise<{ res: Response; release: () => void }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await opts.fetch(url, { ...init, signal: ctl.signal, redirect: 'manual' });
      return { res, release: () => clearTimeout(timer) };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  function filteredResponse(up: Response, body: ResponseBody): Response {
    const headers = new Headers();
    up.headers.forEach((v, k) => {
      if (FORWARD_RESPONSE_HEADERS.includes(k) || RATE_HEADER.test(k)) {
        headers.set(k, v);
      }
    });
    // never forward set-cookie; content-encoding and content-length describe bytes the runtime already decoded
    return new Response(body, { status: up.status, headers });
  }

  async function generic(req: Request, url: URL): Promise<Response> {
    const target = url.searchParams.get('url');
    if (!target) return json(400, 'missing url parameter');
    const method = req.method;
    let entry = matchAllowed(target, method);
    if (!entry) return json(403, 'upstream not allowed');

    let body: Uint8Array | null = null;
    if (method === 'POST') {
      try {
        body = await readCapped(new Response(req.body), MAX_REQUEST_BYTES);
      } catch {
        return json(400, 'request body too large');
      }
    }

    const sent = new Headers({ 'user-agent': ua });
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = req.headers.get(h);
      if (v) sent.set(h, v);
    }
    const clientAuth: [string, string][] = [];
    for (const h of DISCOS_ONLY_HEADERS) {
      const v = req.headers.get(h);
      if (v) clientAuth.push([h, v]);
    }

    let current = target;
    let curMethod = method;
    let curBody = body;
    for (let hop = 0; ; hop++) {
      const headers = new Headers(sent);
      if (entry.auth) for (const [k, v] of clientAuth) headers.set(k, v);
      let r: { res: Response; release: () => void };
      try {
        r = await call(current, { method: curMethod, headers, body: curBody });
      } catch (e) {
        const timedOut = e instanceof Error && e.name === 'AbortError';
        return timedOut ? json(504, 'upstream timed out') : json(502, 'upstream unreachable');
      }
      const up = r.res;
      if (REDIRECT_STATUS.has(up.status)) {
        r.release();
        await up.body?.cancel().catch(() => {});
        const loc = up.headers.get('location');
        if (!loc || hop >= MAX_REDIRECTS) return json(502, 'bad upstream redirect');
        let next: string;
        try {
          next = new URL(loc, current).href;
        } catch {
          return json(502, 'bad upstream redirect');
        }
        if (up.status === 303 || ((up.status === 301 || up.status === 302) && curMethod === 'POST')) {
          curMethod = curMethod === 'HEAD' ? 'HEAD' : 'GET';
          curBody = null;
          sent.delete('content-type');
        }
        const nextEntry = matchAllowed(next, curMethod);
        if (!nextEntry) return json(403, 'redirect target not allowed');
        entry = nextEntry;
        current = next;
        continue;
      }
      const len = Number(up.headers.get('content-length'));
      if (len > maxBytes) {
        r.release();
        await up.body?.cancel().catch(() => {});
        return json(502, 'upstream response too large');
      }
      const out = up.body && method !== 'HEAD' ? capStream(up.body, maxBytes, r.release) : null;
      if (!out) r.release();
      return filteredResponse(up, out);
    }
  }

  async function spacetrack(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json(405, 'method not allowed');
    let parsed: { identity?: unknown; password?: unknown; query?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(await readCapped(new Response(req.body), 16 * 1024)));
    } catch {
      return json(400, 'bad request');
    }
    const { identity, password, query } = parsed ?? {};
    if (typeof identity !== 'string' || typeof password !== 'string' || typeof query !== 'string' || !identity || !password) {
      return json(400, 'bad request');
    }
    if (!query.startsWith(SPACETRACK_QUERY_PREFIX)) return json(403, 'query not allowed');
    let queryUrl: URL;
    try {
      queryUrl = new URL(SPACETRACK_ORIGIN + query);
    } catch {
      return json(400, 'bad request');
    }
    // dot segments or an authority trick must not leave the query tree
    if (queryUrl.origin !== SPACETRACK_ORIGIN || !queryUrl.pathname.startsWith(SPACETRACK_QUERY_PREFIX)) {
      return json(403, 'query not allowed');
    }

    const common = { 'user-agent': ua };
    let cookie = '';
    try {
      const login = await call(`${SPACETRACK_ORIGIN}/ajaxauth/login`, {
        method: 'POST',
        headers: { ...common, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ identity, password }).toString(),
      });
      let loginBody = '';
      try {
        loginBody = new TextDecoder().decode(await readCapped(login.res, 64 * 1024));
      } finally {
        login.release();
      }
      const setCookies =
        typeof login.res.headers.getSetCookie === 'function'
          ? login.res.headers.getSetCookie()
          : (login.res.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=)/);
      cookie = setCookies
        .map((c) => c.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
      // a wrong login answers 200 with {"Login":"Failed"} and no session cookie
      if (login.res.status !== 200 || !cookie || /"Login"\s*:\s*"Failed"/i.test(loginBody)) {
        return json(502, 'space-track login failed', { stage: 'login' });
      }

      const q = await call(queryUrl.href, { method: 'GET', headers: { ...common, cookie, accept: 'application/json' } });
      let data: Uint8Array;
      try {
        data = await readCapped(q.res, maxBytes);
      } finally {
        q.release();
      }
      return filteredResponse(q.res, data as unknown as ResponseBody);
    } catch (e) {
      if (e instanceof TooLarge) return json(502, 'upstream response too large', { stage: 'query' });
      const timedOut = e instanceof Error && e.name === 'AbortError';
      return json(timedOut ? 504 : 502, timedOut ? 'upstream timed out' : 'upstream unreachable');
    } finally {
      if (cookie) {
        try {
          const out = await call(`${SPACETRACK_ORIGIN}/ajaxauth/logout`, { method: 'GET', headers: { ...common, cookie } });
          await out.res.body?.cancel().catch(() => {});
          out.release();
        } catch {
          /* the session expires by itself; nothing to report */
        }
      }
    }
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    const sub = path === base ? '' : path.startsWith(base + '/') ? path.slice(base.length) : null;
    if (sub === null) return json(404, 'not found');

    if (req.method === 'OPTIONS') {
      const cors = corsHeaders(req);
      const headers = new Headers({ allow: 'GET, HEAD, POST, OPTIONS' });
      if (Object.keys(cors).length) {
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        headers.set('access-control-allow-methods', 'GET, HEAD, POST, OPTIONS');
        headers.set('access-control-allow-headers', 'accept, content-type, authorization, discosweb-apiversion');
        headers.set('access-control-max-age', '86400');
      }
      return new Response(null, { status: 204, headers });
    }

    try {
      if (sub === '') {
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return json(405, 'method not allowed');
        return await generic(req, url);
      }
      if (sub === '/spacetrack') return await spacetrack(req);
      return json(404, 'not found');
    } catch {
      return json(502, 'relay error');
    }
  }

  // every answer, errors included, carries the CORS headers so the browser engine can read the reason
  return async (req) => withCors(await route(req), req);
}
