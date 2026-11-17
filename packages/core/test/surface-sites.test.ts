import { describe, expect, it } from 'vitest';
import {
  DEG, SURFACE_SITES, convert, defaultBodies, fixedToGeodetic, geodeticToFixed, providerFromSpec, stateToGeodetic, surfaceShape,
  surfaceSiteAttrs, surfaceSiteRecord, surfaceSiteRecords, wrapLonDeg, type EntityRecord, type Vec3,
} from '../src';

const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const T = Date.UTC(2026, 10, 17, 12, 0, 0);
const site = (id: string) => SURFACE_SITES.find((s) => s.id === id)!;
const fixedOf = (id: string): Vec3 => {
  const rec = surfaceSiteRecord(site(id));
  return providerFromSpec(rec.provider!).stateAt(T)!.r;
};

describe('surface shape: the reference a surface coordinate refers to', () => {
  it('the Earth keeps its WGS-84 ellipsoid, every other body is the sphere of its registry radius', () => {
    expect(surfaceShape(defaultBodies.get('EARTH'))).toBe(defaultBodies.get('EARTH'));
    for (const id of ['MOON', 'MARS', 'TITAN', 'IO']) expect(surfaceShape(defaultBodies.get(id)).flattening, id).toBe(0);
    // Mars is registered with 1/169.8, but the scene draws and the sources publish the sphere
    expect(defaultBodies.get('MARS').flattening).toBeGreaterThan(0.005);
  });

  it('a point at height 0 lies on the sphere to the millimetre, whatever the latitude (Moon, Mars, Titan)', () => {
    for (const id of ['MOON', 'MARS', 'TITAN']) {
      const body = defaultBodies.get(id);
      for (const lat of [-89.9, -45, -0.0001, 0, 33.3, 89.9]) {
        const r = providerFromSpec({ type: 'geodetic', bodyId: id, latDeg: lat, lonDeg: 123.456, altKm: 0 }).stateAt(T)!.r;
        expect(Math.abs(norm(r) - body.radiusKm) * 1000, `${id} ${lat}`).toBeLessThan(0.001);
      }
    }
  });

  it('latitude is planetocentric: atan(z / hypot(x, y)) of the placed point is the latitude given', () => {
    const r = providerFromSpec({ type: 'geodetic', bodyId: 'MARS', latDeg: 60, lonDeg: 10, altKm: 0 }).stateAt(T)!.r;
    expect(Math.atan2(r[2], Math.hypot(r[0], r[1])) / DEG).toBeCloseTo(60, 9);
  });

  it('the Earth is unchanged: geodetic latitude on the ellipsoid (the equator-to-pole radius shrinks by 21 km)', () => {
    const e = defaultBodies.get('EARTH');
    const pole = providerFromSpec({ type: 'geodetic', bodyId: 'EARTH', latDeg: 90, lonDeg: 0, altKm: 0 }).stateAt(T)!.r;
    expect(e.radiusKm - norm(pole)).toBeGreaterThan(21);
  });

  it('reading a point back (stateToGeodetic) gives the latitude, east longitude and height that placed it', () => {
    for (const [bodyId, lat, lon, alt] of [['MOON', -41.6385, 206.0148 - 360, 0], ['MARS', 18.44462715, 77.45088572, 0.5], ['TITAN', -10.573, 167.665, 0]] as const) {
      const s = providerFromSpec({ type: 'geodetic', bodyId, latDeg: lat, lonDeg: lon, altKm: alt }).stateAt(T)!;
      const g = stateToGeodetic(s, T, bodyId);
      expect(g.lat / DEG).toBeCloseTo(lat, 9);
      expect(g.lon / DEG).toBeCloseTo(lon, 9);
      expect(g.alt).toBeCloseTo(alt, 9);
    }
  });
});

describe('east longitude', () => {
  it('east of the prime meridian is +y in the body-fixed frame, west is -y (x towards the prime meridian, z the pole)', () => {
    const east = fixedOf('site-apollo-11'); // 23.47 E
    const west = fixedOf('site-apollo-12'); // 336.58 E = 23.42 W
    expect(east[0]).toBeGreaterThan(0);
    expect(east[1]).toBeGreaterThan(0);
    expect(west[0]).toBeGreaterThan(0);
    expect(west[1]).toBeLessThan(0);
    // 0..360 and -180..180 are the same place
    const a = geodeticToFixed({ lat: 10 * DEG, lon: 336.5781 * DEG, alt: 0 }, surfaceShape(defaultBodies.get('MOON')));
    const b = geodeticToFixed({ lat: 10 * DEG, lon: (336.5781 - 360) * DEG, alt: 0 }, surfaceShape(defaultBodies.get('MOON')));
    for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 9);
    expect(wrapLonDeg(336.5781)).toBeCloseTo(-23.4219, 9);
    expect(wrapLonDeg(180)).toBe(-180);
    expect(wrapLonDeg(-190)).toBeCloseTo(170, 12);
  });

  it('the Moon-fixed point of a site rotates with the Moon: the inertial position is the body centre plus R(t) * fixed', () => {
    const rec = surfaceSiteRecord(site('site-apollo-17'));
    const s = providerFromSpec(rec.provider!).stateAt(T)!;
    expect(s.frame).toBe('MOON:fixed');
    const inertial = convert(s, 'MOON:inertial', T);
    expect(norm(inertial.r)).toBeCloseTo(defaultBodies.get('MOON').radiusKm, 6);
    // half a sidereal rotation later the point is on the other side of the Moon
    const later = convert(providerFromSpec(rec.provider!).stateAt(T + 13.66 * 86_400_000)!, 'MOON:inertial', T + 13.66 * 86_400_000);
    const dot = (inertial.r[0] * later.r[0] + inertial.r[1] * later.r[1] + inertial.r[2] * later.r[2]) / (norm(inertial.r) * norm(later.r));
    expect(dot).toBeLessThan(0);
  });
});

describe('a known site against its source', () => {
  it('Apollo 11: LROC 2016 table, mean observed latitude 0.67416, longitude 23.47314 (ME system), planetocentric on the 1737.4 km sphere', () => {
    const s = site('site-apollo-11');
    expect(s).toMatchObject({ bodyId: 'MOON', kind: 'lander', latDeg: 0.67416, lonDeg: 23.47314, status: 'inactive', year: 1969 });
    expect(s.source).toMatch(/LROC/);
    const r = fixedOf('site-apollo-11');
    expect(norm(r)).toBeCloseTo(1737.4, 9);
    const g = fixedToGeodetic(r, surfaceShape(defaultBodies.get('MOON')));
    expect(g.lat / DEG).toBeCloseTo(0.67416, 9);
    expect(g.lon / DEG).toBeCloseTo(23.47314, 9);
    // the point itself, to the metre: R (cos lat cos lon, cos lat sin lon, sin lat)
    const R = 1737.4, la = 0.67416 * DEG, lo = 23.47314 * DEG;
    expect(Math.abs(r[0] - R * Math.cos(la) * Math.cos(lo)) * 1000).toBeLessThan(1);
    expect(Math.abs(r[1] - R * Math.cos(la) * Math.sin(lo)) * 1000).toBeLessThan(1);
    expect(Math.abs(r[2] - R * Math.sin(la)) * 1000).toBeLessThan(1);
  });

  it("Chang'e 6: the LROC page prints 206.0148 E, the Wikipedia list 153.9852 W: the same point", () => {
    const s = site('site-change-6');
    expect(s.lonDeg).toBe(206.0148);
    expect(wrapLonDeg(s.lonDeg)).toBeCloseTo(-153.9852, 9);
    expect(s.latDeg).toBe(-41.6385);
  });

  it('Perseverance and Curiosity start at their landing sites: the first waypoint of the NASA MMGIS layers', () => {
    expect(site('dsn-M20')).toMatchObject({ latDeg: 18.44462715, lonDeg: 77.45088572, placeholder: true, live: 'M20', dsn: 'M20', horizons: '-168' });
    expect(site('dsn-MSL')).toMatchObject({ latDeg: -4.589467, lonDeg: 137.441633, placeholder: true, live: 'MSL', dsn: 'MSL', horizons: '-76' });
  });
});

describe('the table', () => {
  it('has unique ids, a known body, valid coordinates and a named source for every row', () => {
    expect(new Set(SURFACE_SITES.map((s) => s.id)).size).toBe(SURFACE_SITES.length);
    for (const s of SURFACE_SITES) {
      expect(defaultBodies.has(s.bodyId), s.id).toBe(true);
      expect(s.bodyId, s.id).not.toBe('EARTH');
      expect(Math.abs(s.latDeg), s.id).toBeLessThanOrEqual(90);
      expect(s.lonDeg, s.id).toBeGreaterThanOrEqual(-180);
      expect(s.lonDeg, s.id).toBeLessThanOrEqual(360);
      expect(s.source.length, s.id).toBeGreaterThan(20);
      expect(['lander', 'rover', 'drone']).toContain(s.kind);
      expect(s.year, s.id).toBeGreaterThan(1965);
    }
  });

  it('has the Apollo landings, the Mars landers and the one aircraft; two rovers and little else are active', () => {
    for (const n of [11, 12, 14, 15, 16, 17]) expect(site(`site-apollo-${n}`).bodyId).toBe('MOON');
    for (const k of ['viking-1', 'viking-2', 'pathfinder', 'spirit', 'opportunity', 'phoenix', 'insight', 'zhurong']) expect(site(`site-${k}`).bodyId).toBe('MARS');
    expect(SURFACE_SITES.filter((s) => s.kind === 'drone').map((s) => s.id)).toEqual(['site-ingenuity']);
    const active = SURFACE_SITES.filter((s) => s.status === 'active').map((s) => s.id);
    expect(active).toEqual(expect.arrayContaining(['dsn-M20', 'dsn-MSL']));
    expect(SURFACE_SITES.filter((s) => s.bodyId === 'MARS' && s.status === 'inactive').length).toBeGreaterThanOrEqual(8);
  });

  it('is on the Moon, Mars and Titan only (no Venus site: the coordinates found carry no citation)', () => {
    expect([...new Set(SURFACE_SITES.map((s) => s.bodyId))].sort()).toEqual(['MARS', 'MOON', 'TITAN']);
  });
});

describe('the entity of a site', () => {
  const recs = surfaceSiteRecords(5);

  it('is a geodetic point on its body, listed under it (bodyId), with the rover colour for rovers and the aircraft colour for the helicopter', () => {
    const by = Object.fromEntries(recs.map((r) => [r.id, r])) as Record<string, EntityRecord>;
    expect(by['site-apollo-11']).toMatchObject({
      kind: 'lander', bodyId: 'MOON', group: 'surface', updatedAt: 5,
      provider: { type: 'geodetic', bodyId: 'MOON', latDeg: 0.67416, lonDeg: 23.47314, altKm: 0 },
      attrs: { status: 'inactive', landedYear: 1969, agency: 'NASA', elevationM: -1926 },
    });
    expect(by['site-lunokhod-1'].render?.colorKey).toBe('rover');
    expect(by['site-ingenuity']).toMatchObject({ kind: 'drone', render: { colorKey: 'aircraft' } });
    for (const r of recs) expect(r.provider).toMatchObject({ type: 'geodetic', bodyId: r.bodyId, altKm: 0 });
  });

  it('the DSN rovers keep their ids, their group and their DSN and Horizons aliases: ONE entity, not a duplicate', () => {
    const m20 = recs.find((r) => r.id === 'dsn-M20')!;
    expect(m20).toMatchObject({ kind: 'rover', bodyId: 'MARS', group: 'dsn', aliases: { dsn: 'M20', horizons: '-168' } });
    expect(m20.attrs?.positionNote).toMatch(/landing site/i);
    expect(recs.filter((r) => r.aliases.dsn === 'M20' || r.name.includes('Perseverance'))).toHaveLength(1);
  });

  it('attrs carry the cited source and the east longitude in [-180, 180)', () => {
    const a = surfaceSiteAttrs(site('site-apollo-12'));
    expect(a.lonEastDeg).toBeCloseTo(-23.4219, 9);
    expect(String(a.coordinateSource)).toMatch(/LROC/);
  });
});
