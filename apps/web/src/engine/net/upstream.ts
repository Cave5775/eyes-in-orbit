/**
 * Where a request to a data source really goes. The one plug-in point for upstreams that browsers cannot call directly
 * (no CORS headers, cookies, secrets): connectors never know, `guarded-fetch.ts` asks `resolveUpstream` and rewrites the URL.
 *
 *  - `direct`: the browser calls the source itself (the default for every source)
 *  - `relay`: a stateless relay at `base` forwards the call; the original URL goes after the base as `?url=<encoded>`
 *  - `static`: a file shipped with the app answers instead of the source (`path`, relative to the app root)
 */
export type Upstream =
  | { kind: 'direct' }
  | { kind: 'relay'; base: string }
  | { kind: 'static'; path: string };

const DIRECT: Upstream = { kind: 'direct' };

/** Source id (the keys of `LIMITS`) -> upstream. A source not listed is `direct`. */
export type UpstreamTable = Readonly<Record<string, Upstream>>;

let table: UpstreamTable = {};

/** The upstream of `source`. */
export const resolveUpstream = (source: string, overrides: UpstreamTable = table): Upstream => overrides[source] ?? DIRECT;

/** Replace the process-wide table (the data worker at startup, from the deployment's choice); returns the previous one. */
export function setUpstreams(next: UpstreamTable): UpstreamTable {
  const prev = table;
  table = next;
  return prev;
}

/** The URL to request for `url` under `upstream`. */
export function applyUpstream(upstream: Upstream, url: string): string {
  switch (upstream.kind) {
    case 'direct': return url;
    case 'relay': return `${upstream.base}${upstream.base.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;
    case 'static': return upstream.path;
  }
}
