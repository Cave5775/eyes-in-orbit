import { WebSocket } from 'ws';
import { Limiter, type AcquireResult, type LimitMode } from './limiter';

/**
 * The single choke point for outgoing network traffic of the server and its scripts: `guardedFetch` for HTTP and
 * `guardedWebSocket` for the ISS Lightstreamer socket. `test/net-guard.test.ts` fails when `fetch(` or `new WebSocket`
 * appears anywhere else (apart from a short allow-list).
 */
export interface GuardOptions {
  mode: LimitMode;
  /** the fetch to use (tests inject one); default global fetch */
  fetch?: typeof fetch;
  /** a `demand` caller may sit out a spacing gap up to this long (follow-up requests of one lookup); default 0 */
  waitMs?: number;
}

export type Limited = Extract<AcquireResult, { limited: true }>;
export type GuardedResult = { ok: true; response: Response } | Limited;

/**
 * Ask the limiter, then send. A limited call returns `{ limited, retryAt, reason }` without touching the network. The
 * answer's status and headers (or a network failure) are reported back so blocks (403/429/503, Retry-After,
 * X-Rate-Limit) persist. Network errors are rethrown.
 */
export async function guardedFetch(
  limiter: Limiter, source: string, url: string, init: RequestInit | undefined, opts: GuardOptions,
): Promise<GuardedResult> {
  const gate = await limiter.acquire(source, opts.mode, opts.waitMs);
  if ('limited' in gate) return gate;
  try {
    const response = await (opts.fetch ?? fetch)(url, init);
    limiter.report(source, { status: response.status, headers: response.headers });
    return { ok: true, response };
  } catch (err) {
    limiter.report(source, { networkError: true });
    throw err;
  }
}

export type GuardedSocket = { ok: true; ws: WebSocket } | Limited;

/** Open a WebSocket through the limiter (one attempt counts like one request). An upgrade refusal is reported as its status. */
export async function guardedWebSocket(
  limiter: Limiter, source: string, url: string, protocol: string, mode: LimitMode = 'poll',
): Promise<GuardedSocket> {
  const gate = await limiter.acquire(source, mode);
  if ('limited' in gate) return gate;
  const ws = new WebSocket(url, protocol);
  ws.on('unexpected-response', (_req, res) => limiter.report(source, { status: res.statusCode, headers: { get: (n) => { const v = res.headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; } } }));
  return { ok: true, ws };
}
