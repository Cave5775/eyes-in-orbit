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
  /** Origins that may call the relay from another origin ('*' allows any). Unset: same-origin only, no CORS headers.
   *  An array is read on every request, so a host may fill it in after it knows its own address. */
  allowedOrigins?: string[] | '*';
  userAgent?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** total budget of one Space-Track request (login + query + logout) */
  spacetrackBudgetMs?: number;
}

/** Generic, no personal data: says what the client is and nothing about who runs it. */
export const DEFAULT_USER_AGENT = 'EyesInOrbit-relay/0.1 (stateless pass-through)';

// Per upstream call, covering the headers and the whole body. Horizons answers in a few seconds, MAST invoke and a
// large DISCOS page in up to about 20 s; 45 s leaves room for a slow upstream yet stays under the 60 s limit that
// most fetch-handler hosts (edge functions, reverse proxies) put on one request.
export const DEFAULT_TIMEOUT_MS = 45_000;
// Space-Track makes three calls in one request, so they share one budget below the same 60 s host limit; the logout
// gets a short slice of its own so a slow logout can never push the answer past the budget.
export const DEFAULT_SPACETRACK_BUDGET_MS = 55_000;
export const LOGOUT_TIMEOUT_MS = 4_000;
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

const FORWARD_REQUEST_HEADERS = ['content-type'];
// DISCOS refuses a request without its API version; forwarded to discosweb only, with the Authorization header
const DISCOS_ONLY_HEADERS = ['authorization', 'discosweb-apiversion'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'last-modified', 'retry-after'];
const RATE_HEADER = /^x-rate-?limit-/i;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
// An encoded slash, backslash, dot or NUL in a path, or a raw backslash anywhere: parsers disagree on what these mean,
// so a path that has one is refused rather than normalised.
const SMUGGLING = /%2f|%5c|%2e|%00|\\/i;
const SCRIPTABLE_TYPE = /html|xml|svg|xsl/i;
const API_ACCEPT = 'application/json, text/plain;q=0.9, */*;q=0.1';

/** path with a segment boundary: the prefix itself, or the prefix followed by '/' (a prefix ending in '/' already is) */
function underPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  return prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname.startsWith(prefix + '/');
}

/** the raw path part (before ? and #) of an absolute URL string */
function rawPath(raw: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(raw);
  return m ? m[1] : raw;
}

export function matchAllowed(rawUrl: string, method: string): (AllowEntry & { href: string }) | null {
  if (rawUrl.includes('\\') || SMUGGLING.test(rawPath(rawUrl))) return null;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (SMUGGLING.test(u.pathname)) return null;
  for (const e of ALLOW_LIST) {
    if (u.origin === e.origin && underPrefix(u.pathname, e.pathPrefix) && e.methods.includes(method)) {
      return { ...e, href: u.href };
    }
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

/** a type a browser would render or script on the app's origin becomes plain text */
function safeContentType(v: string): string {
  return SCRIPTABLE_TYPE.test(v.split(';')[0]) ? 'text/plain; charset=utf-8' : v;
}

export function createRelay(opts: RelayOptions): (req: Request) => Promise<Response> {
  const base = (opts.base ?? '/relay').replace(/\/+$/, '');
  const ua = opts.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const budgetMs = opts.spacetrackBudgetMs ?? DEFAULT_SPACETRACK_BUDGET_MS;

  function originAllowed(origin: string | null): boolean {
    const allowed = opts.allowedOrigins;
    if (!allowed || !origin) return false;
    return allowed === '*' || allowed.includes(origin);
  }

  function corsHeaders(req: Request): Record<string, string> {
    const allowed = opts.allowedOrigins;
    const out: Record<string, string> = {};
    if (!allowed) return out;
    // a list answers differently per Origin, so caches must key on it even when this answer has no CORS headers
    if (allowed !== '*') out.vary = 'Origin';
    const origin = req.headers.get('origin');
    if (!origin) return out;
    if (allowed === '*') out['access-control-allow-origin'] = '*';
    else if (allowed.includes(origin)) out['access-control-allow-origin'] = origin;
    return out;
  }

  /** CORS plus the headers that keep a relayed body from being treated as a page of the app's own origin */
  function finish(res: Response, req: Request): Response {
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
    if (headers.has('access-control-allow-origin')) {
      const exposed: string[] = [];
      res.headers.forEach((_v, k) => {
        if (FORWARD_RESPONSE_HEADERS.includes(k) || RATE_HEADER.test(k)) exposed.push(k);
      });
      if (exposed.length) headers.set('access-control-expose-headers', exposed.join(', '));
    }
    headers.set('x-content-type-options', 'nosniff');
    headers.set('content-security-policy', "default-src 'none'; sandbox");
    const ct = headers.get('content-type');
    if (ct) headers.set('content-type', safeContentType(ct));
    return new Response(NULL_BODY_STATUS.has(res.status) ? null : res.body, { status: res.status, statusText: res.statusText, headers });
  }

  /** one upstream call with a deadline; the client going away aborts it; `release` ends the timer once the body is done */
  async function call(
    url: string,
    init: RequestInit,
    parent?: AbortSignal,
    ms: number = timeoutMs,
  ): Promise<{ res: Response; release: () => void }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1, ms));
    const onParent = () => ctl.abort();
    if (parent?.aborted) ctl.abort();
    else parent?.addEventListener('abort', onParent, { once: true });
    const release = () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParent);
    };
    try {
      const res = await opts.fetch(url, { ...init, signal: ctl.signal, redirect: 'manual' });
      return { res, release };
    } catch (e) {
      release();
      throw e;
    }
  }

  function filteredResponse(up: Response, body: ResponseBody | null): Response {
    const headers = new Headers();
    up.headers.forEach((v, k) => {
      if (FORWARD_RESPONSE_HEADERS.includes(k) || RATE_HEADER.test(k)) headers.set(k, v);
    });
    // never forward set-cookie; content-encoding and content-length describe bytes the runtime already decoded
    return new Response(NULL_BODY_STATUS.has(up.status) ? null : body, { status: up.status, headers });
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
      } catch (e) {
        return e instanceof TooLarge ? json(413, 'request body too large') : json(400, 'bad request body');
      }
    }

    const sent = new Headers({ 'user-agent': ua });
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = req.headers.get(h);
      if (v) sent.set(h, v);
    }
    // a client that asks for a page gets the API type instead; the answer is also made inert in finish()
    const accept = req.headers.get('accept');
    sent.set('accept', accept && !/html/i.test(accept) ? accept : API_ACCEPT);
    const clientAuth: [string, string][] = [];
    for (const h of DISCOS_ONLY_HEADERS) {
      const v = req.headers.get(h);
      if (v) clientAuth.push([h, v]);
    }

    let current = entry.href;
    let curMethod = method;
    let curBody = body;
    for (let hop = 0; ; hop++) {
      const headers = new Headers(sent);
      if (entry.auth) for (const [k, v] of clientAuth) headers.set(k, v);
      let r: { res: Response; release: () => void };
      try {
        r = await call(current, { method: curMethod, headers, body: curBody }, req.signal);
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
        current = nextEntry.href;
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

  /** a browser POST from another site must be one the operator allowed; a same-origin page or a plain client passes */
  function spacetrackCallerOk(req: Request): boolean {
    const origin = req.headers.get('origin');
    if (origin) {
      if (originAllowed(origin)) return true;
      const host = req.headers.get('host') ?? new URL(req.url).host;
      try {
        return new URL(origin).host === host;
      } catch {
        return false;
      }
    }
    const site = req.headers.get('sec-fetch-site');
    return !site || site === 'same-origin' || site === 'none';
  }

  async function spacetrack(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json(405, 'method not allowed');
    if (!spacetrackCallerOk(req)) return json(403, 'origin not allowed');
    if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) return json(415, 'content-type must be application/json');
    let parsed: { identity?: unknown; password?: unknown; query?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(await readCapped(new Response(req.body), 16 * 1024)));
    } catch (e) {
      return e instanceof TooLarge ? json(413, 'request body too large') : json(400, 'bad request');
    }
    const { identity, password, query } = parsed ?? {};
    if (typeof identity !== 'string' || typeof password !== 'string' || typeof query !== 'string' || !identity || !password) {
      return json(400, 'bad request');
    }
    if (!query.startsWith(SPACETRACK_QUERY_PREFIX)) return json(403, 'query not allowed');
    // the path part must have no encoded or backslash tricks and no dot segments; the query string is the caller's
    if (query.includes('\\') || SMUGGLING.test(rawPath(SPACETRACK_ORIGIN + query)) || /(^|\/)\.\.?(\/|$)/.test(query.split('?')[0])) {
      return json(403, 'query not allowed');
    }
    let queryUrl: URL;
    try {
      queryUrl = new URL(SPACETRACK_ORIGIN + query);
    } catch {
      return json(400, 'bad request');
    }
    if (queryUrl.origin !== SPACETRACK_ORIGIN || !queryUrl.pathname.startsWith(SPACETRACK_QUERY_PREFIX) || SMUGGLING.test(queryUrl.pathname)) {
      return json(403, 'query not allowed');
    }

    const common = { 'user-agent': ua };
    const deadline = Date.now() + budgetMs;
    // login and query share what is left after the logout's own slice
    const left = () => Math.min(timeoutMs, deadline - LOGOUT_TIMEOUT_MS - Date.now());
    let cookie = '';
    let stage: 'login' | 'query' = 'login';
    try {
      const login = await call(
        `${SPACETRACK_ORIGIN}/ajaxauth/login`,
        { method: 'POST', headers: { ...common, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ identity, password }).toString() },
        req.signal,
        left(),
      );
      const setCookies =
        typeof login.res.headers.getSetCookie === 'function'
          ? login.res.headers.getSetCookie()
          : (login.res.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=)/);
      // the cookie is taken before the body is read, so a failing read still gets its logout in the finally below
      cookie = setCookies
        .map((c) => c.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
      let loginBody = '';
      try {
        loginBody = new TextDecoder().decode(await readCapped(login.res, 64 * 1024));
      } finally {
        login.release();
      }
      // a wrong login answers 200 with {"Login":"Failed"} and no session cookie
      if (login.res.status !== 200) return json(502, 'upstream failure', { stage: 'login' });
      // wrong credentials are the caller's to fix, so they are 401 and not an outage
      if (!cookie || /"Login"\s*:\s*"Failed"/i.test(loginBody)) return json(401, 'login failed', { stage: 'login' });
      stage = 'query';

      const q = await call(queryUrl.href, { method: 'GET', headers: { ...common, cookie, accept: 'application/json' } }, req.signal, left());
      let data: Uint8Array;
      try {
        data = await readCapped(q.res, maxBytes);
      } finally {
        q.release();
      }
      return filteredResponse(q.res, data.byteLength ? (data as unknown as ResponseBody) : null);
    } catch (e) {
      if (e instanceof TooLarge) return json(502, 'upstream response too large', { stage });
      const timedOut = e instanceof Error && e.name === 'AbortError';
      return json(timedOut ? 504 : 502, timedOut ? 'upstream timed out' : 'upstream unreachable', { stage });
    } finally {
      if (cookie) {
        try {
          // a client that left must not stop the logout, so no parent signal here
          const out = await call(`${SPACETRACK_ORIGIN}/ajaxauth/logout`, { method: 'GET', headers: { ...common, cookie } }, undefined, Math.min(LOGOUT_TIMEOUT_MS, Math.max(500, deadline - Date.now())));
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
      const headers = new Headers({ allow: 'GET, HEAD, POST, OPTIONS' });
      if (originAllowed(req.headers.get('origin'))) {
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

  // every answer, errors included, carries the CORS and safety headers
  return async (req) => finish(await route(req), req);
}
