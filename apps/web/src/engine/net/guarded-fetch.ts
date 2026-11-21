import { Limiter, type AcquireResult, type LimitMode } from './limiter';
import { applyUpstream, resolveUpstream, type UpstreamTable } from './upstream';

/**
 * The single choke point for outgoing network traffic of the engine: `guardedFetch` for HTTP and `guardedWebSocket` for the ISS
 * Lightstreamer socket. `test/engine/net-guard.test.ts` fails when `fetch(` or `new WebSocket` appears anywhere else under
 * `apps/web/src/engine`. `net/upstream.ts` decides per source whether the call goes direct, through a relay or to a static file.
 */
export interface GuardOptions {
  mode: LimitMode;
  /** the fetch to use (tests inject one); default global fetch */
  fetch?: typeof fetch;
  /** a `demand` caller may sit out a spacing gap up to this long (follow-up requests of one lookup); default 0 */
  waitMs?: number;
  /** source -> upstream overrides (tests); default the process-wide table of `upstream.ts` */
  upstreams?: UpstreamTable;
  /** whether the browser reports a network (default `navigator.onLine`); offline, a fetch TypeError is never an answer */
  online?: () => boolean;
}

export type Limited = Extract<AcquireResult, { limited: true }>;
export type GuardedResult = { ok: true; response: Response } | Limited;

const defaultOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

/**
 * Ask the limiter, then send. A limited call returns `{ limited, retryAt, reason }` without touching the network. The
 * answer's status and headers (or a network failure) are reported back so blocks (403/429/503, Retry-After,
 * X-Rate-Limit) persist. Network errors are rethrown.
 *
 * Cross-origin caveat: when a CDN in front of a source answers 403/429 without CORS headers, `fetch` rejects with a bare
 * `TypeError` and the status never reaches us. For sources flagged `opaqueIsAnswer` in `limits.ts` (CelesTrak, MPC, Wikimedia)
 * that failure, while the browser is online, is reported as `opaque` and counts as a failed answer for their failure stop and
 * backoff, instead of an ignorable network error that would let the app keep hammering a host that blocks it. Cross-origin
 * `Retry-After` / `X-Rate-Limit-*` headers are readable only when the source exposes them.
 */
export async function guardedFetch(
  limiter: Limiter, source: string, url: string, init: RequestInit | undefined, opts: GuardOptions,
): Promise<GuardedResult> {
  const upstream = resolveUpstream(source, opts.upstreams);
  const doFetch = opts.fetch ?? fetch;
  // a static file is the app's own, not the source: nothing to limit
  if (upstream.kind === 'static') return { ok: true, response: await doFetch(applyUpstream(upstream, url), init) };
  const gate = await limiter.acquire(source, opts.mode, opts.waitMs);
  if ('limited' in gate) return gate;
  const host = hostOf(url);
  try {
    const response = await doFetch(applyUpstream(upstream, url), init);
    await limiter.report(source, { status: response.status, headers: response.headers, host });
    return { ok: true, response };
  } catch (err) {
    const opaque = err instanceof TypeError && !!limiter.limitOf(source)?.opaqueIsAnswer && (opts.online ?? defaultOnline)();
    await limiter.report(source, { networkError: !opaque, opaque, host });
    throw err;
  }
}

const hostOf = (url: string): string | undefined => {
  try { return new URL(url).host; } catch { return undefined; }
};

export type GuardedSocket = { ok: true; ws: WebSocket } | Limited;

/**
 * Open a WebSocket through the limiter (one attempt counts like one request). A browser socket never shows an upgrade
 * refusal's status, so a socket that closes or errors before it opened is reported as a network failure.
 */
export async function guardedWebSocket(
  limiter: Limiter, source: string, url: string, protocol: string, mode: LimitMode = 'poll',
): Promise<GuardedSocket> {
  const gate = await limiter.acquire(source, mode);
  if ('limited' in gate) return gate;
  const ws = new WebSocket(url, protocol);
  let opened = false;
  ws.addEventListener('open', () => { opened = true; });
  ws.addEventListener('close', () => { if (!opened) void limiter.report(source, { networkError: true, host: hostOf(url) }); }, { once: true });
  return { ok: true, ws };
}
