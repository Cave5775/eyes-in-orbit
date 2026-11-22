import { SURFACE_SITES, surfaceSiteOf, surfaceSiteRecord, wrapLonDeg, type RoverTraverse, type SurfaceSite } from '@eio/core';
import type { KvStore } from '../store';
import type { Connector, ConnectorContext } from '../scheduler';
import type { NewEntity } from '../hub';
import { LimitedError } from '../net/limiter';

/**
 * Landers, rovers and the Ingenuity helicopter on other bodies (core `SURFACE_SITES`, one cited table) as entities fixed in the
 * body-fixed frame of their body, plus the live position of the two active Mars rovers: the latest waypoint of the layer NASA
 * publishes for its "where is the rover" maps (MMGIS, https://github.com/NASA-AMMOS/MMGIS), one GeoJSON file per mission:
 *   https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json     (Perseverance, 600 kB, last change 2026-10-28)
 *   https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json     (Curiosity, 665 kB, last change 2026-11-13)
 * Each feature is one localization: `site`, `drive`, `sol`, `lat`, `lon` (planetocentric degrees, east, on the Mars 2000 sphere:
 * `radius` = 3396190 m + `elev_radii`), `elev_geoid` (metres above the geoid), tilt, `dist_total_km`. The files grow by a few
 * waypoints per drive, i.e. every few days. The static sites need no network; the rovers are polled every 6 h and keep their
 * landing site until the first answer. The engine store (6 h) holds the TRAVERSE, the one stored form: every localization of the file
 * as `[lat, lon, sol]` (about a tenth of the 600 kB, the images and attitude columns dropped) plus the latest waypoint; the rover's
 * position is the latest waypoint and `readTraverse` returns the points.
 */
export const MMGIS_BASE = 'https://mars.nasa.gov/mmgis-maps';
export const MMGIS_URL: Record<NonNullable<SurfaceSite['live']>, string> = {
  M20: `${MMGIS_BASE}/M20/Layers/json/M20_waypoints.json`,
  MSL: `${MMGIS_BASE}/MSL/Layers/json/MSL_waypoints.json`,
};
const REFRESH_MS = 6 * 3600_000;
const TTL_MS = 6 * 3600_000;
/** `Cache-Control: max-age` the traverse carried when a server served it, seconds: the poll interval */
export const TRAVERSE_MAX_AGE_S = REFRESH_MS / 1000;
/** Part of the cache key: bump on any change of what is read from the file. */
const CACHE_VERSION = 'v2';
const cacheKey = (code: string): string => `surface-sites:${CACHE_VERSION}:${code}`;
/** a run that fell back to the stale copy asks again after this long (a bad answer must not be downloaded, 665 kB, every 5 min) */
const STALE_RETRY_MS = 60 * 60_000;
/** an answer that is not a waypoint layer (an HTML maintenance page with status 200) blocks the source this long, like the dsn connector does for an unreadable answer */
const BAD_ANSWER_BLOCK_MS = 3 * 3600_000;
const NO_VALUE = -9999;

/** The latest localization of a rover. */
export interface Waypoint {
  sol: number;
  site: number | null;
  drive: number | null;
  /** planetocentric, degrees; east longitude */
  latDeg: number;
  lonDeg: number;
  /** metres above the Mars geoid, absent when the file has no value */
  elevGeoidM: number | null;
  /** distance driven so far, km */
  distTotalKm: number | null;
  /** tilt of the rover, degrees */
  tiltDeg: number | null;
  /** localizations in the file */
  count: number;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v !== NO_VALUE ? v : null);

/**
 * The latest waypoint of a MMGIS waypoint layer (GeoJSON FeatureCollection of points): the feature with the highest `sol` (a later
 * feature wins a tie: the file is in drive order). Features without a usable position are skipped. Throws on any other shape.
 */
export const parseMmgisWaypoints = (text: string): Waypoint => parseMmgisTraverse(text).latest;

/** What the cache holds: the latest waypoint and the whole traverse, `[latDeg, lonDeg, sol]` in file order without consecutive repeats. */
export interface MmgisTraverse {
  latest: Waypoint;
  points: [number, number, number][];
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The latest waypoint and the whole traverse of a MMGIS waypoint layer (same shape rules as `parseMmgisWaypoints`). */
export function parseMmgisTraverse(text: string): MmgisTraverse {
  const doc = JSON.parse(text) as { type?: unknown; features?: unknown };
  if (doc?.type !== 'FeatureCollection' || !Array.isArray(doc.features)) throw new Error('MMGIS did not return a GeoJSON FeatureCollection');
  let best: Waypoint | undefined;
  let count = 0;
  const points: [number, number, number][] = [];
  for (const f of doc.features as { properties?: Record<string, unknown>; geometry?: { coordinates?: unknown[] } }[]) {
    const p = f?.properties ?? {};
    const c = f?.geometry?.coordinates;
    const lat = finite(p.lat) ?? finite(c?.[1]), lon = finite(p.lon) ?? finite(c?.[0]), sol = finite(p.sol);
    if (lat === null || lon === null || sol === null || Math.abs(lat) > 90 || Math.abs(lon) > 360) continue;
    count++;
    const prev = points[points.length - 1];
    if (!prev || prev[0] !== round6(lat) || prev[1] !== round6(lon)) points.push([round6(lat), round6(lon), sol]);
    if (best && sol < best.sol) continue;
    best = {
      sol, site: finite(p.site), drive: finite(p.drive), latDeg: lat, lonDeg: lon,
      elevGeoidM: finite(p.elev_geoid) ?? finite(c?.[2]), distTotalKm: finite(p.dist_km), tiltDeg: finite(p.tilt), count: 0,
    };
  }
  if (!best) throw new Error('MMGIS waypoint layer is malformed: no usable waypoint');
  return { latest: { ...best, count }, points };
}

/** The traverse of a rover entity from the cache, or undefined (not a rover with a live layer, or nothing cached yet). Never asks the network. */
export async function readTraverse(store: KvStore, entityId: string): Promise<RoverTraverse | undefined> {
  const site = surfaceSiteOf(entityId);
  if (!site?.live) return undefined;
  const row = await store.get<MmgisTraverse>(cacheKey(site.live));
  if (!row?.value?.points) return undefined;
  return {
    entityId, bodyId: site.bodyId, source: `NASA MMGIS waypoint layer (${MMGIS_URL[site.live]})`,
    fetchedAt: row.fetchedAt, stale: Date.now() - row.fetchedAt >= row.ttlMs, points: row.value.points,
  };
}

/** The rover's entity with its position at `w` (height 0 on the drawn sphere; the geoid elevation is an attribute) and the waypoint attrs. */
export function roverAt(prev: NewEntity, w: Waypoint, fetchedAt: number): NewEntity {
  const { positionNote: _, ...attrs } = prev.attrs ?? {};
  return {
    ...prev,
    provider: { type: 'geodetic', bodyId: prev.bodyId, latDeg: w.latDeg, lonDeg: w.lonDeg, altKm: 0 },
    attrs: {
      ...attrs,
      latDeg: w.latDeg,
      lonEastDeg: Number(wrapLonDeg(w.lonDeg).toFixed(6)),
      ...(w.elevGeoidM !== null ? { elevationM: w.elevGeoidM } : {}),
      waypointSol: w.sol,
      ...(w.site !== null ? { waypointSite: w.site } : {}),
      ...(w.drive !== null ? { waypointDrive: w.drive } : {}),
      ...(w.distTotalKm !== null ? { driveTotalKm: w.distTotalKm } : {}),
      ...(w.tiltDeg !== null ? { tiltDeg: w.tiltDeg } : {}),
      waypointCount: w.count,
      // the position is the latest waypoint, no longer the landing site the table starts from
      ...(typeof prev.attrs?.coordinateSource === 'string' && !prev.attrs.landingSiteSource ? { landingSiteSource: prev.attrs.coordinateSource } : {}),
      coordinateSource: `NASA MMGIS waypoint layer, latest waypoint (sol ${w.sol}${w.site !== null ? `, site ${w.site}` : ''}${w.drive !== null ? `, drive ${w.drive}` : ''}), mars.nasa.gov/mmgis-maps`,
      positionSource: 'NASA MMGIS waypoint layer (mars.nasa.gov/mmgis-maps)',
      positionFetchedAt: new Date(fetchedAt).toISOString(),
    },
  };
}

/** Register every site; an entity already in the hub (the DSN rovers get their link attrs from the dsn connector) keeps its attrs and its newer position. */
function registerSites(ctx: ConnectorContext): number {
  const recs = SURFACE_SITES.map((s) => {
    const rec = surfaceSiteRecord(s);
    const prev = ctx.hub.graph.get(rec.id);
    return prev ? { ...rec, provider: prev.provider ?? rec.provider, attrs: { ...rec.attrs, ...prev.attrs } } : rec;
  });
  ctx.hub.upsert(...recs);
  return recs.length;
}

export const surfaceSites: Connector = {
  id: 'surface-sites',
  intervalMs: REFRESH_MS,
  startDelayMs: 6000,
  start(ctx) {
    ctx.health.note = `${registerSites(ctx)} surface sites`;
  },
  async run(ctx) {
    const failed: string[] = [];
    let n = 0, cached = 0;
    let limited: LimitedError | undefined;
    for (const site of SURFACE_SITES) {
      if (!site.live) continue;
      try {
        let unreadable = false;
        const parse = (text: string): MmgisTraverse => {
          try {
            return parseMmgisTraverse(text);
          } catch (err) {
            unreadable = true;
            throw err;
          }
        };
        // no conditional GET: `cachedFetch` does not hand back the response headers (Last-Modified / ETag) to send them next time
        let res;
        try {
          res = await ctx.cachedFetch(cacheKey(site.live), MMGIS_URL[site.live], TTL_MS, parse, undefined, { source: 'mmgis', mode: 'poll', staleRetryMs: STALE_RETRY_MS });
        } finally {
          // the limiter is async: the block is persisted here, after the (synchronous) parser flagged the answer
          if (unreadable) await ctx.http.limiter.block('mmgis', BAD_ANSWER_BLOCK_MS, 'backoff after an unreadable answer', 'failure');
        }
        const prev = ctx.hub.graph.get(site.id) ?? surfaceSiteRecord(site);
        ctx.hub.upsert(roverAt(prev, res.value.latest, res.fetchedAt));
        n++;
        if (res.fromCache) cached++;
      } catch (err) {
        failed.push(`${site.live}: ${(err as Error).message.slice(0, 100)}`);
        if (err instanceof LimitedError) {
          limited = err;
          break;
        }
      }
    }
    if (!n && limited) throw limited;
    if (!n && failed.length) throw new Error(`no rover waypoints: ${failed[0]}`);
    ctx.health.note = `${SURFACE_SITES.length} surface sites, ${n} live rover${n === 1 ? '' : 's'} (${cached} cached)`;
    if (failed.length) {
      ctx.health.note = `${failed.length} targets failed: ${failed.join('; ')}`;
      ctx.softFail(failed[0], 60 * 60_000);
    }
  },
};
