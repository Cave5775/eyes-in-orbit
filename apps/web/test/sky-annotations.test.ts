import { describe, expect, it } from 'vitest';
import {
  EARTH, bodyEntityId, bodyEntityRecords, bodyStateEci, moonPositionEci, sunPositionEci, type EntityRecord,
} from '@eio/core';
import {
  behindEarth, belowHorizon, declutter, epochOf, groundObserver, lookDirTo, nearestMarker, selectBodies,
  skyRank, topocentricRaDec, type Placed, type SkyMarker, type SkyObserver,
} from '../src/lib/sky-annotations';
import { LABEL_H } from '../src/lib/labels';
import { dirToRaDec, precessFromJ2000, precessToJ2000, raDecToDir, zenithRaDec, type RaDec } from '../src/lib/sky-frame';
import type { V3 } from '../src/lib/camera';

const DEG = Math.PI / 180;
const hms = (h: number, m: number, s: number) => (h + m / 60 + s / 3600) * 15;
const dms = (sign: number, d: number, m: number, s: number) => sign * (d + m / 60 + s / 3600);
/** angle between two directions, degrees */
const sep = (a: RaDec, b: RaDec) => {
  const u = raDecToDir(a.raDeg, a.decDeg), v = raDecToDir(b.raDeg, b.decDeg);
  const cx = u[1] * v[2] - u[2] * v[1], cy = u[2] * v[0] - u[0] * v[2], cz = u[0] * v[1] - u[1] * v[0];
  return Math.atan2(Math.hypot(cx, cy, cz), u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / DEG; // atan2 keeps the precision of tiny angles
};
const angleBetween = (a: V3, b: V3) => {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, d / (Math.hypot(...a) * Math.hypot(...b))))) / DEG;
};
const GEO: V3 = [0, 0, 0];

describe('epochOf', () => {
  it('every body is of date in the scene since the heliocentric hop is in the axes of date (docs/frames.md)', () => {
    // Changed on purpose: planets, dwarf planets and moons used to be 'j2000' (a J2000 orbit against the of-date Earth).
    for (const id of ['SUN', 'MOON', 'MARS', 'JUPITER', 'NEPTUNE', 'CERES', 'PLUTO', 'IO', 'TITAN', 'CHARON']) expect(epochOf(id)).toBe('date');
  });
});

describe('topocentricRaDec: the Sun (low-precision model, ~0.01 deg)', () => {
  // Tolerance 0.02 deg: core `sunDirectionEci` is documented as ~0.01 deg; the apparent places below also carry nutation (up to
  // 0.005 deg) and aberration (0.0057 deg), which the model leaves out.
  const TOL = 0.02;

  it('Meeus, Astronomical Algorithms 2nd ed., example 25.a: 1992 Oct 13 0h, apparent RA 13h13m31.4s, Dec -7d47m06s (of date)', () => {
    const t = Date.UTC(1992, 9, 13); // 0h TD; Delta T was ~59 s = 0.0007 deg of solar motion
    const date = dirToRaDec(sunPositionEci(t));
    expect(Math.abs(date.raDeg - hms(13, 13, 31.4))).toBeLessThan(TOL);
    expect(Math.abs(date.decDeg - dms(-1, 7, 47, 6))).toBeLessThan(TOL);
    // the distance is the example's R = 0.99766 AU
    expect(Math.hypot(...sunPositionEci(t)) / 149_597_870.7).toBeCloseTo(0.99766, 4);
    // and the J2000 answer is that place precessed back (8 years before J2000 -> a little under 0.2 deg of RA, the other way)
    const j = topocentricRaDec(sunPositionEci(t), GEO, t, 'date');
    expect(sep(j, precessToJ2000(date.raDeg, date.decDeg, t))).toBeLessThan(1e-9);
    expect(sep(j, date)).toBeGreaterThan(0.1);
  });

  it('the 2025 March equinox (USNO table: 09:01 UTC): the Sun is on the celestial equator at RA 0h of date', () => {
    const date = dirToRaDec(sunPositionEci(Date.UTC(2025, 2, 20, 9, 1)));
    expect(Math.min(date.raDeg, 360 - date.raDeg)).toBeLessThan(TOL);
    expect(Math.abs(date.decDeg)).toBeLessThan(TOL);
    // seen from J2000 axes, 25.2 years of precession (50.3 arcsec/yr along the ecliptic) move that point by ~0.35 deg
    const j = topocentricRaDec(sunPositionEci(Date.UTC(2025, 2, 20, 9, 1)), GEO, Date.UTC(2025, 2, 20, 9, 1), 'date');
    expect(sep(j, date)).toBeGreaterThan(0.3);
    expect(sep(j, date)).toBeLessThan(0.4);
  });

  it('the 2025 December solstice (USNO table: 15:03 UTC): RA 18h of date, Dec = minus the obliquity', () => {
    const date = dirToRaDec(sunPositionEci(Date.UTC(2025, 11, 21, 15, 3)));
    expect(Math.abs(date.raDeg - 270)).toBeLessThan(TOL);
    // mean obliquity of date, Meeus eq. 22.2: 23.4392911 deg - 0.0130042 deg per Julian century (T = 0.2597 in 2025.97)
    expect(Math.abs(date.decDeg + (23.4392911 - 0.0130042 * 0.2597))).toBeLessThan(TOL);
  });
});

describe('topocentricRaDec: the Moon and parallax', () => {
  it('Meeus example 47.a, 1992 Apr 12 0h: apparent RA 134.688470, Dec +13.768368, distance 368 409.7 km (series: ~0.3 deg, 0.5 percent)', () => {
    const t = Date.UTC(1992, 3, 12);
    const r = moonPositionEci(t);
    const date = dirToRaDec(r);
    expect(sep(date, { raDeg: 134.68847, decDeg: 13.768368 })).toBeLessThan(0.4);
    expect(Math.abs(Math.hypot(...r) / 368_409.7 - 1)).toBeLessThan(0.006);
  });

  it('for an observer where the Moon is on the horizon the shift is atan(R / distance): the horizontal parallax, 0.9-1.03 deg', () => {
    const t = Date.UTC(1992, 3, 12);
    const r = moonPositionEci(t);
    const dist = Math.hypot(...r);
    // an observer at the Earth's equatorial radius, on the perpendicular to the Moon's direction: the Moon is at his horizon
    const u = [r[0] / dist, r[1] / dist, r[2] / dist];
    const p = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const dp = p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
    const q = [p[0] - dp * u[0], p[1] - dp * u[1], p[2] - dp * u[2]];
    const ql = Math.hypot(q[0], q[1], q[2]);
    const obs: V3 = [(q[0] / ql) * EARTH.radiusKm, (q[1] / ql) * EARTH.radiusKm, (q[2] / ql) * EARTH.radiusKm];
    const geo = topocentricRaDec(r, GEO, t, 'date');
    const topo = topocentricRaDec(r, obs, t, 'date');
    const shift = sep(geo, topo);
    expect(shift).toBeCloseTo(Math.atan(EARTH.radiusKm / dist) / DEG, 6);
    // bounded by the horizontal parallax asin(R / d) and by the perigee/apogee range of the distance (356,400 - 406,700 km, Meeus ch. 47)
    expect(shift).toBeLessThanOrEqual(Math.asin(EARTH.radiusKm / dist) / DEG);
    expect(shift).toBeGreaterThan(Math.asin(EARTH.radiusKm / 406_700) / DEG);
    expect(shift).toBeLessThan(Math.asin(EARTH.radiusKm / 356_400) / DEG);
    // Meeus' mean horizontal parallax of the Moon is 0.9507 deg (57' 02.7"; its mean distance 384,400 km)
    expect(shift).toBeGreaterThan(0.9);
    expect(shift).toBeLessThan(1.03);
    // an observer under the Moon sees it exactly where the geocentre does
    const under: V3 = [u[0] * EARTH.radiusKm, u[1] * EARTH.radiusKm, u[2] * EARTH.radiusKm];
    expect(sep(geo, topocentricRaDec(r, under, t, 'date'))).toBeLessThan(1e-6);
  });

  it('a far body (Jupiter, > 4 AU) moves by under 0.01 deg when the observer is on the Earth instead of at its centre', () => {
    for (const t of [Date.UTC(2026, 0, 1), Date.UTC(2026, 6, 1), Date.UTC(2026, 11, 1)]) {
      const r = bodyStateEci('JUPITER', t).r;
      const dist = Math.hypot(...r);
      expect(dist).toBeGreaterThan(4 * 149_597_870.7); // Jupiter is never nearer than 4.2 AU
      for (const obs of [[EARTH.radiusKm, 0, 0], [0, -EARTH.radiusKm, 0], [0, 0, EARTH.radiusKm]] as V3[]) {
        const shift = sep(topocentricRaDec(r, GEO, t, 'date'), topocentricRaDec(r, obs, t, 'date'));
        expect(shift).toBeLessThan(0.01);
        expect(shift).toBeLessThanOrEqual(Math.asin(EARTH.radiusKm / dist) / DEG + 1e-9);
      }
    }
  });
});

describe('planets are of date in the scene, like the Sun and the Moon (no correction before the direction is taken)', () => {
  it('Venus, Meeus example 33.a, 1992 Dec 20 0h TD: apparent RA 21h04m41.454s, Dec -18d53m16.84s (of date), to 0.02 deg', () => {
    // The offline orbit is Standish's table 1 (arcmin level) and Meeus' place is apparent (light time 7.6 min, aberration 20 arcsec,
    // nutation) while ours is geometric: 0.02 deg bounds all of that. The scene vector is used as it is (it is of date); the old
    // `j2000Geocentric` correction would now double-count, and without either the place was 0.07 deg off (J2000 orbit, of-date Sun).
    const t = Date.UTC(1992, 11, 20);
    const expected = { raDeg: hms(21, 4, 41.454), decDeg: dms(-1, 18, 53, 16.84) };
    const venus = bodyStateEci('VENUS', t).r;
    const j = topocentricRaDec(venus, GEO, t, epochOf('VENUS'));
    expect(sep(precessFromJ2000(j.raDeg, j.decDeg, t), expected)).toBeLessThan(0.02);
    // and it is the same place the marker list gives
    const ofDate = dirToRaDec(venus);
    expect(sep(ofDate, expected)).toBeLessThan(0.02);
  });
});

describe('belowHorizon and behindEarth', () => {
  const obs: V3 = [EARTH.radiusKm, 0, 0]; // on the equator, the vertical is +x
  it('elevation sign with the vertical, and without it (geocentric)', () => {
    expect(belowHorizon([1e5, 0, 0], obs, [1, 0, 0])).toBe(false);
    expect(belowHorizon([-1e5, 0, 0], obs, [1, 0, 0])).toBe(true);
    expect(belowHorizon([EARTH.radiusKm, 1e5, 0], obs, [1, 0, 0])).toBe(false); // exactly on the horizon: not below
    expect(belowHorizon([EARTH.radiusKm - 1, 1e5, 0], obs, [1, 0, 0])).toBe(true);
    expect(belowHorizon([1e5, 5, 0], obs)).toBe(false);
    expect(belowHorizon([0, 5, 0], obs)).toBe(true);
  });

  it('a tilted vertical (geodetic) changes the answer for a target near the horizon', () => {
    const up: V3 = [Math.cos(95 * DEG), Math.sin(95 * DEG), 0]; // the vertical 95 deg from +x: the horizon plane is tilted 5 deg
    expect(belowHorizon([obs[0] + 1e6, 0, 0], obs, up)).toBe(true); // along +x: 5 deg below that horizon
    expect(belowHorizon([obs[0] + 1e6, 0, 0], obs, [1, 0, 0])).toBe(false); // and at the zenith of the plain one
  });

  it('the Earth hides what is behind it from a space observer, and only that', () => {
    const geo: V3 = [42_164, 0, 0]; // geostationary radius, Vallado/standard value
    expect(behindEarth([-384_400, 0, 0], geo)).toBe(true); // straight through the Earth
    expect(behindEarth([384_400, 0, 0], geo)).toBe(false); // away from it
    expect(behindEarth([0, 384_400, 0], geo)).toBe(false); // sideways
    expect(behindEarth([-1e5, 1e5, 0], geo)).toBe(false); // the line passes far outside the limb
    // a target between the observer and the Earth is in front of it
    expect(behindEarth([20_000, 0, 0], geo)).toBe(false);
    // the grazing angle from GEO: asin(R / r) = 8.7 deg off the Earth's centre direction
    const limb = Math.asin(EARTH.radiusKm / 42_164) / DEG;
    const at = (deg: number): V3 => [geo[0] - 1e6 * Math.cos(deg * DEG), 1e6 * Math.sin(deg * DEG), 0];
    expect(behindEarth(at(limb - 0.05), geo)).toBe(true);
    expect(behindEarth(at(limb + 0.05), geo)).toBe(false);
  });

  it('a target short of the Earth along the line is not behind it, a ground observer never is', () => {
    expect(behindEarth([-EARTH.radiusKm - 100, 0, 0], [-EARTH.radiusKm - 1000, 0, 0])).toBe(false);
    expect(behindEarth([-3000, 0, 0], [-EARTH.radiusKm - 1000, 0, 0])).toBe(true); // a target inside the sphere is past its near surface
    expect(behindEarth([-1e5, 0, 0], obs)).toBe(false); // on the surface: use belowHorizon
    expect(behindEarth([5, 5, 5], [5, 5, 5])).toBe(false);
  });

  it('the Moon behind the Earth from a point on the Earth-Sun-line side far side: LEO observer, opposite the Moon', () => {
    const t = Date.UTC(2026, 5, 1);
    const m = moonPositionEci(t);
    const d = Math.hypot(...m);
    const leo: V3 = [(-m[0] / d) * 6778, (-m[1] / d) * 6778, (-m[2] / d) * 6778]; // 400 km up, on the side away from the Moon
    expect(behindEarth(m, leo)).toBe(true);
    expect(behindEarth(m, [-leo[0], -leo[1], -leo[2]])).toBe(false);
  });
});

describe('groundObserver', () => {
  it('the vertical points at RA = local sidereal time, Dec = geodetic latitude (the zenith of sky-frame), and the radius is the geodetic one', () => {
    const t = Date.UTC(2026, 5, 1, 3);
    const o = groundObserver(-24.62722, -70.40389, 2.635, t);
    const z = zenithRaDec(t, -24.62722, -70.40389);
    expect(sep(dirToRaDec(o.up!), z)).toBeLessThan(1e-9);
    expect(Math.hypot(...o.up!)).toBeCloseTo(1, 12);
    // a ground site sits between the polar and the equatorial radius plus its height
    const r = Math.hypot(...o.r);
    expect(r).toBeGreaterThan(6356.752 + 2.635 - 1);
    expect(r).toBeLessThan(6378.137 + 2.635 + 1);
    // the vertical is not the geocentric direction (geodetic latitude differs by up to 0.19 deg)
    expect(angleBetween(o.up!, o.r)).toBeGreaterThan(0.1);
    expect(angleBetween(o.up!, o.r)).toBeLessThan(0.2);
    // the equator at the Greenwich meridian at the right sidereal time is on +x of the inertial axes
    const eq = groundObserver(0, 0, 0, Date.UTC(2000, 0, 1, 12)); // GMST at J2000 is 280.46 deg
    expect(dirToRaDec(eq.r).raDeg).toBeCloseTo(280.46, 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const records = bodyEntityRecords();
const rec = (id: string): EntityRecord => records.find((r) => r.id === bodyEntityId(id))!;
const T = Date.UTC(2026, 10, 15, 3);

describe('selectBodies', () => {
  const ground = groundObserver(19.8222, -155.4749, 4.205, T);
  const none = () => false;
  const noStream = () => false;

  it('annotates the Sun, the Moon, the planets and the dwarf planets; not the Earth, other moons or non-bodies', () => {
    const sat: EntityRecord = { id: 'sat-1', name: 'ISS', kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0 } as EntityRecord;
    const out = selectBodies([...records, sat], { tMs: T, observer: ground, isHidden: none, isStreamed: noStream });
    const ids = out.map((m) => m.id);
    expect(ids).toContain('body-sun');
    expect(ids).toContain('body-moon');
    for (const p of ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'ceres', 'pluto', 'eris', 'haumea', 'makemake']) expect(ids).toContain(`body-${p}`);
    expect(ids).not.toContain('body-earth');
    expect(ids).not.toContain('sat-1');
    // 1 Sun + the Moon + 7 planets (Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune) + 5 dwarf planets + 11 asteroids
    expect(out).toHaveLength(25);
    expect(out.filter((m) => m.kind === 'asteroid').map((m) => m.id).sort()).toEqual(['body-apophis', 'body-arrokoth', 'body-bennu', 'body-didymos', 'body-eros', 'body-hygiea', 'body-itokawa', 'body-pallas', 'body-psyche', 'body-ryugu', 'body-vesta']);
    // an unstreamed asteroid is flagged approximate (an old osculating epoch); Dimorphos, a moon, is dropped unless streamed
    expect(out.find((m) => m.id === 'body-vesta')!.approx).toBe(true);
    expect(out.map((m) => m.id)).not.toContain('body-dimorphos');
    const withDimorphos = selectBodies(records, { tMs: T, observer: ground, isHidden: none, isStreamed: (id) => id === 'DIMORPHOS' });
    expect(withDimorphos.find((m) => m.id === 'body-dimorphos')).toMatchObject({ kind: 'moon', approx: false });
    for (const m of out) {
      expect(Number.isFinite(m.raDeg + m.decDeg + m.distKm)).toBe(true);
      expect(m.raDeg).toBeGreaterThanOrEqual(0);
      expect(m.raDeg).toBeLessThan(360);
      expect(Math.abs(m.decDeg)).toBeLessThanOrEqual(90);
    }
  });

  it('the Sun and the Moon are at the distances of the ephemeris series, within the observer offset', () => {
    const out = selectBodies(records, { tMs: T, observer: ground, isHidden: none, isStreamed: noStream });
    const sun = out.find((m) => m.id === 'body-sun')!, moon = out.find((m) => m.id === 'body-moon')!;
    expect(Math.abs(sun.distKm - Math.hypot(...sunPositionEci(T)))).toBeLessThan(EARTH.radiusKm + 5);
    expect(Math.abs(moon.distKm - Math.hypot(...moonPositionEci(T)))).toBeLessThan(EARTH.radiusKm + 5);
    expect(sun.kind).toBe('star');
    expect(moon.kind).toBe('moon');
  });

  it('drops what the query hides, through the injected predicate', () => {
    const out = selectBodies(records, { tMs: T, observer: ground, isStreamed: noStream, isHidden: (r) => r.id === 'body-mars' || r.kind === 'dwarf_planet' });
    const ids = out.map((m) => m.id);
    expect(ids).not.toContain('body-mars');
    expect(ids).not.toContain('body-pluto');
    expect(ids).toContain('body-venus');
    expect(out).toHaveLength(19); // Sun, Moon, six planets and 11 asteroids
  });

  it('drops a body with no position (null or not finite)', () => {
    const out = selectBodies(records, {
      tMs: T, observer: ground, isHidden: none, isStreamed: noStream,
      positionOf: (id, t) => (id === 'JUPITER' ? null : id === 'SATURN' ? [NaN, 0, 0] : bodyStateEci(id, t).r),
    });
    const ids = out.map((m) => m.id);
    expect(ids).not.toContain('body-jupiter');
    expect(ids).not.toContain('body-saturn');
    expect(ids).toContain('body-mars');
  });

  it('moons: only the Moon and those whose position is streamed now (the offline phase of the others is arbitrary)', () => {
    const opts = { tMs: T, observer: ground, isHidden: none };
    const off = selectBodies(records, { ...opts, isStreamed: noStream }).filter((m) => m.kind === 'moon');
    expect(off.map((m) => m.id)).toEqual(['body-moon']);
    const on = selectBodies(records, { ...opts, isStreamed: (id) => id === 'IO' || id === 'TITAN' });
    expect(on.filter((m) => m.kind === 'moon').map((m) => m.id).sort()).toEqual(['body-io', 'body-moon', 'body-titan']);
    // a streamed moon is no longer approximate, the planet and the unstreamed Moon (a 0.3 deg series) are
    expect(on.find((m) => m.id === 'body-io')!.approx).toBe(false);
    expect(on.find((m) => m.id === 'body-jupiter')!.approx).toBe(true);
    expect(on.find((m) => m.id === 'body-moon')!.approx).toBe(true);
    // Io is within a few arcmin of its planet (a = 421,800 km at 4-6 AU: at most 0.03 deg)
    expect(sep(on.find((m) => m.id === 'body-io')!, on.find((m) => m.id === 'body-jupiter')!)).toBeLessThan(0.04);
  });

  it('marks, not drops, what a ground observer cannot see: the Sun and the Moon have opposite halves of the day; the flag matches the elevation', () => {
    const out = selectBodies(records, { tMs: T, observer: ground, isHidden: none, isStreamed: noStream });
    expect(out.some((m) => m.hidden)).toBe(true);
    expect(out.some((m) => !m.hidden)).toBe(true);
    // the hidden flag is the elevation sign: recompute it with sky-frame's own horizontal conversion (of date)
    for (const m of out) {
      const j = precessFromJ2000(m.raDeg, m.decDeg, T);
      const up = ground.up!;
      const dir = raDecToDir(j.raDeg, j.decDeg);
      const el = Math.asin(dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2]) / DEG;
      if (Math.abs(el) > 0.3) expect(m.hidden, `${m.id} el ${el.toFixed(2)}`).toBe(el < 0);
    }
  });

  it('a space observer: a body behind the Earth is marked, the same body is clear from the other side', () => {
    const m = moonPositionEci(T);
    const d = Math.hypot(...m);
    const behind: SkyObserver = { r: [(-m[0] / d) * 7000, (-m[1] / d) * 7000, (-m[2] / d) * 7000] };
    const clear: SkyObserver = { r: [(m[0] / d) * 7000, (m[1] / d) * 7000, (m[2] / d) * 7000] };
    const only = (o: SkyObserver) => selectBodies([rec('MOON')], { tMs: T, observer: o, isHidden: none, isStreamed: noStream });
    expect(only(behind)[0].hidden).toBe(true);
    expect(only(clear)[0].hidden).toBe(false);
    // the geocentric direction of the Moon is its J2000 RA/Dec seen from far away (from the Earth's centre)
    const centre = selectBodies([rec('MOON')], { tMs: T, observer: { r: [0, 0, 0] }, isHidden: none, isStreamed: noStream })[0];
    expect(sep(centre, topocentricRaDec(m, GEO, T, 'date'))).toBeLessThan(1e-9);
  });

  it('the observer own body is whatever the observer says, and a planet is placed like the Sun and the Moon (of date)', () => {
    // an observer on the Moon: the Moon is its own body and dropped, the Earth (a planet, 384,000 km away) is shown
    const out = selectBodies(records, { tMs: T, observer: { r: moonPositionEci(T), bodyId: 'MOON' }, isHidden: none, isStreamed: noStream });
    expect(out.map((m) => m.id)).not.toContain('body-moon');
    expect(Math.abs(out.find((m) => m.id === 'body-earth')!.distKm - Math.hypot(...moonPositionEci(T)))).toBeLessThan(1e-6);
    // a planet from the geocentre equals topocentricRaDec of the scene position (no correction since the scene is of date)
    const geo = selectBodies(records, { tMs: T, observer: { r: [0, 0, 0] }, isHidden: none, isStreamed: noStream });
    const mars = geo.find((m) => m.id === 'body-mars')!;
    expect(sep(mars, topocentricRaDec(bodyStateEci('MARS', T).r, GEO, T, 'date'))).toBeLessThan(1e-9);
  });
});

describe('skyRank and declutter', () => {
  const mk = (id: string, kind: string, ra: number, dist = 1e8): SkyMarker => ({ id, name: id, kind, raDeg: ra, decDeg: 0, distKm: dist, hidden: false, approx: false });
  // a toy projector: 1 px per 0.1 deg along x, y = 100
  const project = (ra: number, dec: number, out: [number, number]) => { out[0] = ra * 10; out[1] = 100 + dec * 10; return ra < 300; };

  it('ranks Sun > Moon > planets > dwarf planets > asteroids > moons', () => {
    const order = [mk('body-sun', 'star', 0), mk('body-moon', 'moon', 0), mk('body-mars', 'planet', 0), mk('body-pluto', 'dwarf_planet', 0), mk('body-vesta', 'asteroid', 0), mk('body-io', 'moon', 0)];
    expect(order.map(skyRank)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps the higher-ranked of two markers closer than LABEL_H px, whatever the input order', () => {
    const sun = mk('body-sun', 'star', 10), mars = mk('body-mars', 'planet', 10 + (LABEL_H - 1) / 10);
    for (const input of [[sun, mars], [mars, sun]]) {
      const kept = declutter(input, 60, 800, 600, project);
      expect(kept.map((p) => p.marker.id)).toEqual(['body-sun']);
    }
    // exactly LABEL_H apart is clear
    const far = mk('body-mars', 'planet', 10 + LABEL_H / 10);
    expect(declutter([sun, far], 60, 800, 600, project)).toHaveLength(2);
  });

  it('among equals the nearer wins; a planet beats a moon of another planet; the loser does not shadow others', () => {
    const a = mk('body-venus', 'planet', 20, 5e7), b = mk('body-mars', 'planet', 20.5, 2e8), io = mk('body-io', 'moon', 20.2, 6e8);
    const c = mk('body-saturn', 'planet', 40, 1.4e9);
    const kept = declutter([io, b, c, a], 60, 800, 600, project);
    expect(kept.map((p) => p.marker.id)).toEqual(['body-venus', 'body-saturn']);
    expect(kept[0].x).toBe(200);
  });

  it('drops what the projector rejects or what is off screen, reuses the output array and ignores an unset view', () => {
    const out: Placed[] = [];
    const m = [mk('a', 'planet', 10), mk('b', 'planet', 310), mk('c', 'planet', 70), mk('d', 'planet', -10)]; // c at x=700 (inside 800), d at x=-100 (outside), b rejected
    const kept = declutter(m, 60, 650, 600, project, out);
    expect(kept).toBe(out);
    expect(kept.map((p) => p.marker.id)).toEqual(['a']);
    expect(declutter(m, 0, 800, 600, project, out)).toHaveLength(0);
    expect(declutter(m, NaN, 800, 600, project, out)).toHaveLength(0);
    expect(declutter(m, 60, 800, 600, project, out).map((p) => p.marker.id)).toEqual(['a', 'c']);
    // a point just outside the viewport but within LABEL_H still counts (its label can reach in)
    expect(declutter([mk('e', 'planet', -LABEL_H / 10 + 0.1)], 60, 800, 600, project)).toHaveLength(1);
  });
});

describe('nearestMarker', () => {
  const pts = [{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 14, y: 10 }, { id: 'c', x: 100, y: 100 }];
  it('returns the nearest id within the radius, null outside, the first on a tie', () => {
    expect(nearestMarker(pts, 12, 10, 5)).toBe('a');
    expect(nearestMarker(pts, 13, 10, 5)).toBe('b');
    expect(nearestMarker(pts, 12, 10, 1)).toBe(null); // 2 px from each, radius 1
    expect(nearestMarker(pts, 12, 10, 2)).toBe('a'); // inclusive, tie goes to the first
    expect(nearestMarker(pts, 101, 99, 2)).toBe('c');
    expect(nearestMarker([], 0, 0, 10)).toBe(null);
  });
});

describe('lookDirTo', () => {
  it('is the unit direction of date of a J2000 place: back to J2000 gives the input', () => {
    const t = Date.UTC(2026, 10, 15);
    for (const [ra, dec] of [[0, 0], [83.8, -5.4], [266.41684, -29.00781], [200, 89], [310, -70]]) {
      const d = lookDirTo(ra, dec, t);
      expect(Math.hypot(...d)).toBeCloseTo(1, 12);
      const back = precessToJ2000(dirToRaDec(d).raDeg, dirToRaDec(d).decDeg, t);
      expect(sep(back, { raDeg: ra, decDeg: dec })).toBeLessThan(1e-9);
      expect(sep(dirToRaDec(d), precessFromJ2000(ra, dec, t))).toBeLessThan(1e-9);
    }
  });

  it('the J2000 equinox is at RA ~ 0.31 deg of date in 2026 (precession 50.3 arcsec/yr * 26.9 yr = 0.376 deg along the ecliptic)', () => {
    const d = dirToRaDec(lookDirTo(0, 0, Date.UTC(2026, 10, 15)));
    expect(d.raDeg).toBeGreaterThan(0.3);
    expect(d.raDeg).toBeLessThan(0.4);
    expect(d.decDeg).toBeGreaterThan(0.12);
    expect(d.decDeg).toBeLessThan(0.18);
  });

  it('fills the given array and allocates nothing else', () => {
    const out: V3 = [0, 0, 0];
    expect(lookDirTo(10, 20, Date.UTC(2026, 0, 1), out)).toBe(out);
  });

  it('the Moon clicked on the map is looked at: topocentric J2000 -> look direction == topocentric direction of date', () => {
    const t = T;
    const o = groundObserver(19.8222, -155.4749, 4.205, t);
    const r = moonPositionEci(t);
    const j = topocentricRaDec(r, o.r, t, 'date');
    const look = lookDirTo(j.raDeg, j.decDeg, t);
    const d: V3 = [r[0] - o.r[0], r[1] - o.r[1], r[2] - o.r[2]];
    expect(angleBetween(look, d)).toBeLessThan(1e-6);
  });
});
