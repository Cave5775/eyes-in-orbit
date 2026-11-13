/**
 * HTTP pieces that need no SQLite store, so the diagnostic scripts can use them without loading `node:sqlite`.
 * `http.ts` re-exports everything here.
 */
/** Wikimedia's policy asks for a descriptive agent with a contact URL; no personal contact detail is sent. */
export const USER_AGENT = 'EyesInOrbit/0.1 (+https://github.com/Cave5775/eyes-in-orbit)';
export const DEFAULT_ACCEPT = 'application/json, text/xml, */*';
export const TIMEOUT_MS = 20_000;
/** Longest body excerpt kept on an `HttpError`. */
export const BODY_KEEP = 300;
/** Body excerpt that goes into the message (the message ends up in health notes with up to 11 groups in a row). */
const BODY_IN_MESSAGE = 120;

/** The headers every request carries (UA, accept) plus caller extras (lower-case names). */
export const requestHeaders = (extra: Record<string, string> = {}): Record<string, string> =>
  ({ 'user-agent': USER_AGENT, accept: DEFAULT_ACCEPT, ...extra });

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Response headers that say who answered and for how long to stay away. */
export function diagnosticHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['retry-after', 'server', 'cf-ray', 'via']) {
    const v = headers.get(name);
    if (v) out[name] = oneLine(v).slice(0, 80);
  }
  return out;
}

export class HttpError extends Error {
  /** `retry-after`, `server`, `cf-ray`, `via` when the response had them */
  readonly headers: Record<string, string>;
  /** the first 300 characters of the response body, whitespace collapsed */
  readonly body: string;

  constructor(public status: number, url: string, body = '', headers: Record<string, string> = {}) {
    const kept = oneLine(body.slice(0, BODY_KEEP));
    const hdr = Object.entries(headers).map(([k, v]) => `${k}=${v}`).join('; ');
    super(`HTTP ${status} for ${url}${hdr ? ` [${hdr}]` : ''}${kept ? `: ${kept.slice(0, BODY_IN_MESSAGE)}` : ''}`);
    this.headers = headers;
    this.body = kept;
  }
}

/**
 * undici hides why `fetch` failed in `err.cause` ("fetch failed" alone). Returns its `code` (UND_ERR_CONNECT_TIMEOUT,
 * ECONNRESET, ENOTFOUND, ...), looking into the member errors of an AggregateError (dual-stack connect attempts).
 */
export function errorCauseCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (e: unknown, depth: number): string | undefined => {
    if (!e || typeof e !== 'object' || seen.has(e) || depth > 4) return undefined;
    seen.add(e);
    const o = e as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof o.code === 'string' && o.code) return o.code;
    const fromCause = walk(o.cause, depth + 1);
    if (fromCause) return fromCause;
    if (Array.isArray(o.errors)) for (const sub of o.errors) { const c = walk(sub, depth + 1); if (c) return c; }
    return undefined;
  };
  return walk((err as { cause?: unknown } | undefined)?.cause, 0);
}

/** Same error, but with the cause code in the message: `fetch failed (UND_ERR_CONNECT_TIMEOUT)`. */
export function withCauseCode(err: unknown): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  const code = errorCauseCode(base);
  if (!code || base.message.includes(code)) return base;
  const wrapped = new Error(`${base.message} (${code})`, { cause: base });
  wrapped.name = base.name;
  return wrapped;
}
