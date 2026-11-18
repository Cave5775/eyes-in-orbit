import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_SITES, convert, providerFromSpec, surfaceSiteOf } from '@eio/core';
import { loadConfig } from '../src/config';
import { Scheduler, type Connector } from '../src/connector';
import { dsn } from '../src/connectors/dsn';
import { DSN_SURFACE_CODES, DSN_TARGETS, dsnCodes, probeEntity } from '../src/connectors/dsn-targets';
import { registerApi } from '../src/api';
import { MMGIS_URL, parseMmgisTraverse, parseMmgisWaypoints, readTraverse, roverAt, surfaceSites } from '../src/connectors/surface-sites';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { Limiter } from '../src/net/limiter';
import { LIMITS, sourceForUrl } from '../src/net/limits';
import { Store } from '../src/store';

const fx = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const H = 3600_000;

describe('MMGIS waypoint parser (trimmed real files, read 2026-11-17)', () => {
  it('Perseverance: the latest waypoint, sol 2022 site 93 (the end-of-drive localization wins over the mid-drive one of the same sol)', () => {
    const w = parseMmgisWaypoints(fx('mmgis-m20-waypoints.json'));
    expect(w).toMatchObject({ sol: 2022, site: 93, drive: 0, latDeg: 18.43559434, lonDeg: 77.23322287, elevGeoidM: -1936.366943, distTotalKm: 45.25, tiltDeg: 7.289319877 });
    expect(w.count).toBe(5);
  });

  it('Curiosity: sol 5073, site 125, drive 2490; the file has no elev_radii and a different property set', () => {
    const w = parseMmgisWaypoints(fx('mmgis-msl-waypoints.json'));
    expect(w).toMatchObject({ sol: 5073, site: 125, drive: 2490, latDeg: -4.82602331, lonDeg: 137.388886, elevGeoidM: -3472.085, distTotalKm: 38.32 });
  });

  it('reads the landing waypoint of each mission as the table has it (first waypoint: sol 13 / sol 3)', () => {
    for (const [code, file] of [['M20', 'mmgis-m20-waypoints.json'], ['MSL', 'mmgis-msl-waypoints.json']] as const) {
      const first = JSON.parse(fx(file)).features[0].properties;
      const s = SURFACE_SITES.find((x) => x.live === code)!;
      expect(s.latDeg, code).toBe(first.lat);
      expect(s.lonDeg, code).toBe(first.lon);
    }
  });

  it('Ingenuity: the table position is the last waypoint (flight 72, sol 1036) of the helicopter layer', () => {
    const doc = JSON.parse(fx('mmgis-m20-heli-waypoints.json'));
    const last = doc.features[doc.features.length - 1].properties;
    expect(last).toMatchObject({ Flight: 72, Sol: 1036 });
    expect(surfaceSiteOf('site-ingenuity')).toMatchObject({ latDeg: last.Lat, lonDeg: last.Lon, elevationM: last.Elev_Geoid });
  });

  it('skips features without a usable position and the -9999 "no value" marker', () => {
    const doc = { type: 'FeatureCollection', features: [
      { properties: { sol: 5, lat: 1, lon: 2, elev_geoid: -9999 }, geometry: { coordinates: [2, 1, -100] } },
      { properties: { sol: 9, lat: -9999, lon: -9999 }, geometry: { coordinates: [-9999, -9999] } },
      { properties: { sol: 7, lon: 4 }, geometry: { coordinates: [4, 3, 12] } },
    ] };
    const w = parseMmgisWaypoints(JSON.stringify(doc));
    expect(w).toMatchObject({ sol: 7, latDeg: 3, lonDeg: 4, elevGeoidM: 12, count: 2 });
  });

  it('throws on a wrong shape and on a layer with no usable waypoint', () => {
    expect(() => parseMmgisWaypoints('{"type":"Feature"}')).toThrow(/GeoJSON FeatureCollection/);
    expect(() => parseMmgisWaypoints('[]')).toThrow(/GeoJSON FeatureCollection/);
    expect(() => parseMmgisWaypoints('<html>')).toThrow();
    expect(() => parseMmgisWaypoints('{"type":"FeatureCollection","features":[]}')).toThrow(/no usable waypoint/);
  });

  it('roverAt puts the rover on the waypoint at height 0 and keeps its other attrs', () => {
    const base = { ...providerlessRover(), attrs: { dish: 'DSS-14', positionNote: 'Landing site' } };
    const rec = roverAt(base, parseMmgisWaypoints(fx('mmgis-msl-waypoints.json')), Date.UTC(2026, 10, 17));
    expect(rec.provider).toEqual({ type: 'geodetic', bodyId: 'MARS', latDeg: -4.82602331, lonDeg: 137.388886, altKm: 0 });
    expect(rec.attrs).toMatchObject({ dish: 'DSS-14', waypointSol: 5073, waypointSite: 125, driveTotalKm: 38.32, elevationM: -3472.085, positionFetchedAt: '2026-11-17T00:00:00.000Z' });
    expect(rec.attrs?.positionNote).toBeUndefined();
  });
});

function providerlessRover() {
  const s = surfaceSiteOf('dsn-MSL')!;
  return { id: s.id, name: s.name, kind: s.kind, bodyId: s.bodyId, aliases: {}, group: 'dsn' };
}

describe('DSN targets: the rovers are surface sites, not Horizons targets', () => {
  it('MSL and M20 are no longer in the Horizons table (it would draw them as free-floating points again) but still get the DSN link attrs', () => {
    expect(DSN_TARGETS.MSL).toBeUndefined();
    expect(DSN_TARGETS.M20).toBeUndefined();
    expect(DSN_SURFACE_CODES.slice().sort()).toEqual(['M20', 'MSL']);
    expect(dsnCodes()).toEqual(expect.arrayContaining(['MSL', 'M20', 'VGR1']));
    // the table has exactly one entity per code: no probe entity is built for a surface rover
    for (const c of Object.keys(DSN_TARGETS)) expect(probeEntity(c).id).not.toMatch(/MSL|M20/);
  });
});

describe('surface-sites connector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(answer: (url: string) => Response, opts: { offline?: boolean; store?: Store } = {}, connectors: Connector[] = [surfaceSites]) {
    const hub = new Hub(0);
    const store = opts.store ?? new Store(':memory:');
    const limiter = new Limiter(store, { limits: LIMITS });
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      calls.push(String(input));
      return answer(String(input));
    });
    const http = new Http(store, { fetch: fetchMock, offline: !!opts.offline, limiter });
    const scheduler = new Scheduler({ hub, config: loadConfig({}), store, http }, connectors, 0);
    return { hub, store, limiter, calls, scheduler };
  }
  const serve = (url: string): Response =>
    url === MMGIS_URL.M20 ? new Response(fx('mmgis-m20-waypoints.json')) : url === MMGIS_URL.MSL ? new Response(fx('mmgis-msl-waypoints.json')) : new Response('', { status: 404 });

  it('the URLs are the NASA MMGIS layers and belong to the `mmgis` source', () => {
    expect(MMGIS_URL.M20).toBe('https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json');
    expect(MMGIS_URL.MSL).toBe('https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json');
    expect(sourceForUrl(MMGIS_URL.M20)).toBe('mmgis');
    expect(LIMITS.mmgis.perHour).toBeLessThanOrEqual(8);
  });

  it('registers every site at startup with no request (offline first), the rovers at their landing sites', async () => {
    const { hub, calls, scheduler } = setup(serve);
    await scheduler.start();
    scheduler.stop();
    expect(calls).toHaveLength(0);
    expect(hub.graph.get('site-apollo-11')).toMatchObject({ kind: 'lander', bodyId: 'MOON', provider: { type: 'geodetic', bodyId: 'MOON' } });
    expect(hub.graph.get('dsn-M20')).toMatchObject({ kind: 'rover', bodyId: 'MARS', provider: { type: 'geodetic', latDeg: 18.44462715, lonDeg: 77.45088572 } });
    expect(hub.healthOf('surface-sites').note).toBe(`${SURFACE_SITES.length} surface sites`);
  });

  it('the first run moves each rover to its latest waypoint, in ONE entity that keeps the DSN attrs; two requests, 1.5 s apart', async () => {
    const { hub, calls, scheduler } = setup(serve);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();
    expect(calls.sort()).toEqual([MMGIS_URL.M20, MMGIS_URL.MSL].sort());
    const m20 = hub.graph.get('dsn-M20')!;
    expect(m20.provider).toEqual({ type: 'geodetic', bodyId: 'MARS', latDeg: 18.43559434, lonDeg: 77.23322287, altKm: 0 });
    expect(m20.attrs).toMatchObject({ waypointSol: 2022, status: 'active' });
    expect(m20.group).toBe('dsn');
    expect(m20.aliases).toMatchObject({ dsn: 'M20', horizons: '-168' });
    expect(hub.graph.get('dsn-MSL')!.provider).toMatchObject({ latDeg: -4.82602331, lonDeg: 137.388886 });
    expect(hub.healthOf('surface-sites').note).toMatch(/2 live rovers \(0 cached\)/);
    // on the planet: its position hops from MARS:fixed into the Earth-inertial scene frame, 1e8 km away (Mars), not near the Earth
    const s = hub.graph.stateIn('dsn-M20', Date.parse('2026-11-17T12:00:00Z'), 'EARTH:inertial')!;
    expect(Math.hypot(...s.r)).toBeGreaterThan(5e7);
    const marsFixed = convert(s, 'MARS:fixed', Date.parse('2026-11-17T12:00:00Z'));
    expect(Math.hypot(...marsFixed.r)).toBeCloseTo(3396.19, 3);
  });

  it('a DSN link attr refresh and the surface-site run do not overwrite each other', async () => {
    const { hub, scheduler } = setup(serve);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const rover = hub.graph.get('dsn-MSL')!;
    hub.upsert({ ...rover, attrs: { ...rover.attrs, dish: 'DSS-43', rangeKm: 2.4e8 } }); // what the dsn connector does
    await vi.advanceTimersByTimeAsync(6 * H + 60_000);
    scheduler.stop();
    expect(hub.graph.get('dsn-MSL')!.attrs).toMatchObject({ dish: 'DSS-43', waypointSol: 5073 });
  });

  it('a fresh cache (6 h) makes no second request; after the TTL the next run asks again', async () => {
    const { calls, scheduler } = setup(serve);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * H);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2 * H);
    scheduler.stop();
    expect(calls).toHaveLength(4);
  });

  it('OFFLINE with a cached answer serves it; without one it ends in an error, the static sites stay', async () => {
    const store = new Store(':memory:');
    const first = setup(serve, { store });
    await first.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    first.scheduler.stop();
    const second = setup(serve, { store, offline: true });
    await second.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    second.scheduler.stop();
    expect(second.calls).toHaveLength(0);
    expect(second.hub.graph.get('dsn-M20')!.provider).toMatchObject({ latDeg: 18.43559434 });

    const bare = setup(serve, { offline: true });
    await bare.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    bare.scheduler.stop();
    expect(bare.hub.graph.get('site-apollo-11')).toBeDefined();
    expect(bare.hub.graph.get('dsn-M20')!.provider).toMatchObject({ latDeg: 18.44462715 });
  });

  it('a 403 (a missing key on the NASA bucket answers 403) blocks the source: no further request in the window, the landing site stays', async () => {
    const { calls, hub, limiter, scheduler } = setup(() => new Response('<html>Forbidden</html>', { status: 403 }));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(5);
    const n = calls.length;
    await vi.advanceTimersByTimeAsync(2 * H);
    scheduler.stop();
    expect(calls).toHaveLength(n);
    expect(limiter.status('mmgis')).toBeDefined();
    expect(hub.graph.get('dsn-M20')!.provider).toMatchObject({ latDeg: 18.44462715 });
    expect(hub.healthOf('surface-sites').lastError).toMatch(/403/);
  });

  it('a 200 with an HTML maintenance page blocks the source for hours: no download storm (one request per 3 h block, at most 5 in 12 h instead of one every 5 min)', async () => {
    const { calls, hub, scheduler } = setup(() => new Response('<html><body>Down for maintenance</body></html>'));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(12 * H);
    scheduler.stop();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(hub.graph.get('dsn-M20')!.provider).toMatchObject({ latDeg: 18.44462715 });
  });

  it('with a stale cache and a bad answer it asks again after an hour at the earliest (staleRetryMs), not every 5 minutes', async () => {
    const store = new Store(':memory:');
    const good = setup(serve, { store });
    await good.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    good.scheduler.stop();
    vi.setSystemTime(Date.now() + 7 * H); // the cached rows are past their 6 h TTL
    const bad = setup(() => new Response('<html>maintenance</html>'), { store });
    await bad.scheduler.start();
    await vi.advanceTimersByTimeAsync(2 * H);
    bad.scheduler.stop();
    expect(bad.calls.length).toBeLessThanOrEqual(1);
    expect(bad.hub.graph.get('dsn-M20')!.provider).toMatchObject({ latDeg: 18.43559434 }); // the stale waypoint is still served
  });

  it('the live attrs say the position is the latest waypoint and keep the landing-site citation apart; the longitude is in [-180, 180)', () => {
    const rec = roverAt({ ...providerlessRover(), attrs: { coordinateSource: 'landing waypoint' } }, { sol: 7, site: 1, drive: 2, latDeg: 1, lonDeg: 200, elevGeoidM: null, distTotalKm: null, tiltDeg: null, count: 3 }, 0);
    expect(rec.attrs).toMatchObject({ landingSiteSource: 'landing waypoint', lonEastDeg: -160 });
    expect(String(rec.attrs?.coordinateSource)).toMatch(/latest waypoint \(sol 7, site 1, drive 2\)/);
  });

  it('with the surface-sites connector disabled the dsn connector still registers the two rovers at their landing sites (one table)', async () => {
    const { hub, scheduler } = setup(serve, {}, [dsn]);
    await scheduler.start();
    scheduler.stop();
    expect(hub.graph.get('dsn-M20')).toMatchObject({ kind: 'rover', bodyId: 'MARS', provider: { type: 'geodetic', latDeg: 18.44462715 } });
    expect(hub.graph.get('dsn-MSL')).toMatchObject({ provider: { type: 'geodetic', latDeg: -4.589467 } });
  });

  it('an unreadable answer is an error naming the shape, and the other rover still moves', async () => {
    const { hub, scheduler } = setup((url) => (url === MMGIS_URL.M20 ? new Response('{"type":"Nope"}') : serve(url)));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();
    expect(hub.graph.get('dsn-M20')!.provider).toMatchObject({ latDeg: 18.44462715 });
    expect(hub.graph.get('dsn-MSL')!.provider).toMatchObject({ latDeg: -4.82602331 });
    expect(hub.healthOf('surface-sites').note).toMatch(/1 targets failed: M20: .*GeoJSON FeatureCollection/);
    void providerFromSpec;
  });

  it('the cache holds the whole traverse (the one stored form), served by readTraverse and GET /api/traverse/:id; the latest waypoint comes from it', async () => {
    const { hub, store, scheduler } = setup(serve);
    expect(readTraverse(store, 'dsn-M20')).toBeUndefined(); // nothing cached yet, and no request is made to find out
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();
    const t = readTraverse(store, 'dsn-M20')!;
    expect(t).toMatchObject({ entityId: 'dsn-M20', bodyId: 'MARS', stale: false });
    expect(t.source).toContain(MMGIS_URL.M20);
    expect(t.points[0]).toEqual([18.444627, 77.450886, 13]);
    expect(t.points[t.points.length - 1]).toEqual([18.435594, 77.233223, 2022]);
    expect(hub.graph.get('dsn-M20')!.provider).toMatchObject({ latDeg: 18.43559434 });
    expect(readTraverse(store, 'dsn-MSL')!.points).toHaveLength(4); // the two identical landing rows are one point
    expect(readTraverse(store, 'site-apollo-11')).toBeUndefined();

    const app = Fastify();
    registerApi(app, hub, new Http(store, { fetch: vi.fn<typeof fetch>(), offline: true, limiter: new Limiter(store, { limits: LIMITS }) }), store);
    const ok = await app.inject({ url: '/api/traverse/dsn-M20' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ entityId: 'dsn-M20', bodyId: 'MARS', points: t.points });
    expect(ok.headers['cache-control']).toBe('max-age=21600');
    expect((await app.inject({ url: '/api/traverse/site-apollo-11' })).statusCode).toBe(404); // a site with no live layer
    expect((await app.inject({ url: '/api/traverse/nope' })).statusCode).toBe(404); // unknown
    expect((await app.inject({ url: '/api/traverse/dsn-MSL' })).statusCode).toBe(200);
    await app.close();
  });

  it('a traverse is marked stale once its cache entry is past the TTL and the refresh failed; the old answer is still served', async () => {
    const store = new Store(':memory:');
    const good = setup(serve, { store });
    await good.scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    good.scheduler.stop();
    vi.setSystemTime(Date.now() + 7 * H);
    expect(readTraverse(store, 'dsn-MSL')).toMatchObject({ stale: true });
    expect(readTraverse(store, 'dsn-MSL')!.points.length).toBeGreaterThan(1);
  });
});

describe('MMGIS traverse parser (trimmed real files)', () => {
  it('keeps every localization in file order, 6 decimals, without consecutive repeats; the latest waypoint is the same as before', () => {
    const t = parseMmgisTraverse(fx('mmgis-m20-waypoints.json'));
    expect(t.points.map((p) => p[2])).toEqual([13, 14, 2009, 2022, 2022]);
    expect(t.latest).toEqual(parseMmgisWaypoints(fx('mmgis-m20-waypoints.json')));
    expect(parseMmgisTraverse(fx('mmgis-msl-waypoints.json')).points.map((p) => p[2])).toEqual([3, 5069, 5070, 5073]);
  });
  it('skips the points without a usable position', () => {
    const doc = { type: 'FeatureCollection', features: [
      { properties: { sol: 1, lat: 1, lon: 2 }, geometry: { coordinates: [2, 1] } },
      { properties: { sol: 2, lat: -9999, lon: -9999 }, geometry: { coordinates: [-9999, -9999] } },
      { properties: { sol: 3, lat: 1.0000004, lon: 2 }, geometry: { coordinates: [2, 1] } },
      { properties: { sol: 4, lat: 3, lon: 4 }, geometry: { coordinates: [4, 3] } },
    ] };
    expect(parseMmgisTraverse(JSON.stringify(doc)).points).toEqual([[1, 2, 1], [3, 4, 4]]);
  });
});
