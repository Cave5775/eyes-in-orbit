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
  /** absolute app root for relative relay bases and static paths (default the one set by `setAppBase`) */
  appBase?: string;
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
 * that failure, while the browser is online, is reported as `opaque`: the limiter backs off for minutes (never toward the
 * 24 h failure stop, since a captive portal or an ad blocker looks the same) and lifts that block when the upstream changes. Cross-origin
 * `Retry-After` / `X-Rate-Limit-*` headers are readable only when the source exposes them.
 */
export async function guardedFetch(
  limiter: Limiter, source: string, url: string, init: RequestInit | undefined, opts: GuardOptions,
): Promise<GuardedResult> {
  const upstream = resolveUpstream(source, opts.upstreams);
  const doFetch = opts.fetch ?? fetch;
  const target = applyUpstream(upstream, url, opts.appBase);
  if (upstream.kind === 'static') {
    // a static file is the app's own, not the source: nothing to limit. A host that answers an unknown path with its SPA
    // page (HTTP 200, text/html) has no such file: report that as a miss, not as data.
    const response = await doFetch(target, init);
    if (/^text\/html/i.test(response.headers.get('content-type') ?? '')) return { ok: true, response: new Response(null, { status: 404, statusText: 'static file missing' }) };
    return { ok: true, response };
  }
  const gate = await limiter.acquire(source, opts.mode, opts.waitMs, upstream.kind);
  if ('limited' in gate) return gate;
  const host = hostOf(url);
  let response: Response;
  try {
    response = await doFetch(target, init);
  } catch (err) {
    const opaque = err instanceof TypeError && !!limiter.limitOf(source)?.opaqueIsAnswer && (opts.online ?? defaultOnline)();
    await reportSafely(limiter, source, { networkError: !opaque, opaque, host, upstream: upstream.kind });
    throw err;
  }
  // a failed write of the limiter state must neither lose the answer nor pose as a network error
  await reportSafely(limiter, source, { status: response.status, headers: response.headers, host, upstream: upstream.kind });
  return { ok: true, response };
}

async function reportSafely(limiter: Limiter, source: string, input: Parameters<Limiter['report']>[1]): Promise<void> {
  try {
    await limiter.report(source, input);
  } catch (err) {
    console.warn(`[net] could not record the answer of ${source}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const hostOf = (url: string): string | undefined => {
  try { return new URL(url).host; } catch { return undefined; }
};

/** `cancel()` closes the socket on the caller's own decision (nobody wants the data any more): before it opened that is not a network failure. */
export type GuardedSocket = { ok: true; ws: WebSocket; cancel(): void } | Limited;

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
  let opened = false, cancelled = false;
  ws.addEventListener('open', () => { opened = true; });
  ws.addEventListener('close', () => { if (!opened && !cancelled) void reportSafely(limiter, source, { networkError: true, host: hostOf(url) }); }, { once: true });
  return { ok: true, ws, cancel: () => { cancelled = true; try { ws.close(); } catch { /* already closed */ } } };
}
