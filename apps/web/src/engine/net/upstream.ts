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

/**
 * The deployment's default table. Horizons, Space-Track, DISCOS, MAST send no CORS headers (and the MMGIS rover waypoint layers were blocked in Edge although curl sees them) (Space-Track also logs in with a cross-site
 * cookie), so they go through the stateless relay at `relayBase` (default `/relay`, same origin): generic calls as `<relayBase>?url=<encoded>`,
 * Space-Track as `POST <relayBase>/spacetrack` (`connectors/spacetrack.ts`). CelesTrak is called directly (its CORS headers are unverified);
 * `celestrakViaRelay` flips it to the relay. Every other source (MPC, Launch Library, DSN, ...) answers CORS and stays direct.
 */
export function defaultUpstreams(opts: { relayBase?: string; celestrakViaRelay?: boolean } = {}): UpstreamTable {
  const relay: Upstream = { kind: 'relay', base: opts.relayBase ?? '/relay' };
  return {
    horizons: relay, mmgis: relay, 'spacetrack:query': relay, 'spacetrack:login': relay, 'spacetrack:logout': relay, discos: relay, mast: relay,
    ...(opts.celestrakViaRelay ? { celestrak: relay } : {}),
  };
}

let table: UpstreamTable = defaultUpstreams();

/** The upstream of `source`. */
export const resolveUpstream = (source: string, overrides: UpstreamTable = table): Upstream => overrides[source] ?? DIRECT;

/** Replace the process-wide table (the data worker at startup, from the deployment's choice); returns the previous one. */
export function setUpstreams(next: UpstreamTable): UpstreamTable {
  const prev = table;
  table = next;
  return prev;
}

let appBase: string | undefined;

/**
 * The absolute URL of the app root (`self.location.origin + import.meta.env.BASE_URL`), which relative relay bases and static
 * paths resolve against. A worker's own location is its script under `/assets/`, and a sub-path deploy is not the origin root, so
 * the data worker must set this at startup. Returns the previous value.
 */
export function setAppBase(base: string | undefined): string | undefined {
  const prev = appBase;
  appBase = base;
  return prev;
}

const resolveAgainst = (path: string, base: string | undefined): string => (base ? new URL(path, base).toString() : path);

/**
 * The URL to request for `url` under `upstream`. A relative relay base (`/relay`) or static path is resolved against `base`
 * (default the one set by `setAppBase`; with none it stays relative).
 */
export function applyUpstream(upstream: Upstream, url: string, base: string | undefined = appBase): string {
  switch (upstream.kind) {
    case 'direct': return url;
    case 'relay': {
      const b = resolveAgainst(upstream.base, base);
      return `${b}${b.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;
    }
    case 'static': return resolveAgainst(upstream.path, base);
  }
}
