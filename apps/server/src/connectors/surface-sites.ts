import { SURFACE_SITES, surfaceSiteRecord, wrapLonDeg, type SurfaceSite } from '@eio/core';
import type { Connector, ConnectorContext } from '../connector';
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
 * waypoints per drive, i.e. every few days. The static sites need no network; the rovers are polled every 6 h (cache 6 h in the
 * SQLite store: only the latest waypoint is cached, not the 600 kB file) and keep their landing site until the first answer.
 */
export const MMGIS_BASE = 'https://mars.nasa.gov/mmgis-maps';
export const MMGIS_URL: Record<NonNullable<SurfaceSite['live']>, string> = {
  M20: `${MMGIS_BASE}/M20/Layers/json/M20_waypoints.json`,
  MSL: `${MMGIS_BASE}/MSL/Layers/json/MSL_waypoints.json`,
};
const REFRESH_MS = 6 * 3600_000;
const TTL_MS = 6 * 3600_000;
/** Part of the cache key: bump on any change of what is read from the file. */
const CACHE_VERSION = 'v1';
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
export function parseMmgisWaypoints(text: string): Waypoint {
  const doc = JSON.parse(text) as { type?: unknown; features?: unknown };
  if (doc?.type !== 'FeatureCollection' || !Array.isArray(doc.features)) throw new Error('MMGIS did not return a GeoJSON FeatureCollection');
  let best: Waypoint | undefined;
  let count = 0;
  for (const f of doc.features as { properties?: Record<string, unknown>; geometry?: { coordinates?: unknown[] } }[]) {
    const p = f?.properties ?? {};
    const c = f?.geometry?.coordinates;
    const lat = finite(p.lat) ?? finite(c?.[1]), lon = finite(p.lon) ?? finite(c?.[0]), sol = finite(p.sol);
    if (lat === null || lon === null || sol === null || Math.abs(lat) > 90 || Math.abs(lon) > 360) continue;
    count++;
    if (best && sol < best.sol) continue;
    best = {
      sol, site: finite(p.site), drive: finite(p.drive), latDeg: lat, lonDeg: lon,
      elevGeoidM: finite(p.elev_geoid) ?? finite(c?.[2]), distTotalKm: finite(p.dist_km), tiltDeg: finite(p.tilt), count: 0,
    };
  }
  if (!best) throw new Error('MMGIS waypoint layer is malformed: no usable waypoint');
  return { ...best, count };
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
        const parse = (text: string): Waypoint => {
          try {
            return parseMmgisWaypoints(text);
          } catch (err) {
            ctx.http.limiter.block('mmgis', BAD_ANSWER_BLOCK_MS, 'backoff after an unreadable answer', 'failure');
            throw err;
          }
        };
        // no conditional GET: `cachedFetch` does not hand back the response headers (Last-Modified / ETag) to send them next time
        const res = await ctx.cachedFetch(`surface-sites:${CACHE_VERSION}:${site.live}`, MMGIS_URL[site.live], TTL_MS, parse, undefined, { source: 'mmgis', mode: 'poll', staleRetryMs: STALE_RETRY_MS });
        const prev = ctx.hub.graph.get(site.id) ?? surfaceSiteRecord(site);
        ctx.hub.upsert(roverAt(prev, res.value, res.fetchedAt));
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
