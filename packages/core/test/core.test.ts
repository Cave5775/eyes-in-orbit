import { describe, expect, it } from 'vitest';
import {
  Clock, CompositeProvider, EntityGraph, EARTH, GeodeticProvider, KeplerianProvider, RelativeProvider,
  SampledProvider, Sgp4Provider, DEG, convert, deriveMissionState, formatCountdown, fixedToGeodetic,
  geodeticToFixed, gmstRad, missionTimingFor, norm, providerFromSpec, stateToGeodetic, sunDirectionEci, LL2_STATUS, MARS, MOON,
  type Omm, type Sample,
} from '../src';

const ISS_OMM: Omm = {
  OBJECT_NAME: 'ISS (ZARYA)', OBJECT_ID: '1998-067A', EPOCH: '2024-03-01T12:00:00.000000',
  MEAN_MOTION: 15.49, ECCENTRICITY: 0.0005, INCLINATION: 51.64, RA_OF_ASC_NODE: 120.0,
  ARG_OF_PERICENTER: 90.0, MEAN_ANOMALY: 270.0, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: 25544, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 44000, BSTAR: 0.0002, MEAN_MOTION_DOT: 0.0001,
  MEAN_MOTION_DDOT: 0,
};
const T0 = Date.parse('2024-03-01T12:00:00Z');

describe('frames', () => {
  it('GMST at J2000 is 280.4606 deg', () => {
    expect(gmstRad(Date.UTC(2000, 0, 1, 12)) / DEG).toBeCloseTo(280.46061837, 4);
  });

  it('geodetic <-> fixed round trip (Earth)', () => {
    for (const [lat, lon, alt] of [[28.57, -80.65, 0.01], [-45, 170, 400], [89.5, 10, 35786]]) {
      const r = geodeticToFixed({ lat: lat * DEG, lon: lon * DEG, alt }, EARTH);
      const g = fixedToGeodetic(r, EARTH);
      expect(g.lat / DEG).toBeCloseTo(lat, 6);
      expect(g.lon / DEG).toBeCloseTo(lon, 6);
      expect(g.alt).toBeCloseTo(alt, 5);
    }
  });

  it('inertial <-> fixed round trip preserves position and velocity', () => {
    const s = { frame: 'EARTH:inertial' as const, r: [7000, 100, 2000] as [number, number, number], v: [1, 7, 0.5] as [number, number, number] };
    const back = convert(convert(s, 'EARTH:fixed', T0), 'EARTH:inertial', T0);
    s.r.forEach((x, i) => expect(back.r[i]).toBeCloseTo(x, 6));
    s.v.forEach((x, i) => expect(back.v![i]).toBeCloseTo(x, 6));
  });

  it('a point fixed on the surface moves inertially at the surface rotation speed', () => {
    const fixed = { frame: 'EARTH:fixed' as const, r: [6378.137, 0, 0] as [number, number, number], v: [0, 0, 0] as [number, number, number] };
    const inertial = convert(fixed, 'EARTH:inertial', T0);
    expect(norm(inertial.v!)).toBeCloseTo(0.4651, 3);
  });

  it('converts Moon-inertial states into Earth-inertial using the Moon orbit', () => {
    const s = { frame: 'MOON:inertial' as const, r: [0, 0, 0] as [number, number, number] };
    const e = convert(s, 'EARTH:inertial', T0);
    expect(norm(e.r)).toBeGreaterThan(350_000);
    expect(norm(e.r)).toBeLessThan(410_000);
  });

  it('sun direction is a unit vector', () => {
    expect(norm(sunDirectionEci(T0))).toBeCloseTo(1, 6);
  });
});

describe('entity sampled in MARS:inertial (Mars-centred Horizons track of a Mars orbiter)', () => {
  const R = 3700; // km from the Mars centre: ~300 km above the mean radius
  const v = Math.sqrt(MARS.gm / R);
  const w = v / R; // rad/s
  const t0 = T0;
  // near-polar circular orbit in Mars' inertial equatorial axes, with velocities as Horizons returns them (5 min rows)
  const at = (t: number): [number, number, number, number, number, number] => {
    const a = w * ((t - t0) / 1000);
    return [R * Math.cos(a), 0, R * Math.sin(a), -v * Math.sin(a), 0, v * Math.cos(a)];
  };
  const samples: Sample[] = [];
  for (let t = t0 - 3_600_000; t <= t0 + 3_600_000; t += 300_000) samples.push([t, ...at(t)]);
  const g = new EntityGraph();
  g.upsert({ id: 'mro', name: 'MRO', kind: 'probe', bodyId: 'MARS', aliases: {}, provider: { type: 'sampled', frame: 'MARS:inertial', samples }, updatedAt: 0 });

  it('stays a Mars-relative state in MARS:inertial', () => {
    const s = g.stateIn('mro', t0 + 1_234_567, 'MARS:inertial')!;
    expect(s.frame).toBe('MARS:inertial');
    expect(norm(s.r)).toBeCloseTo(R, 0);
    expect(norm(s.v!)).toBeCloseTo(v, 2);
  });

  it('is expressed in EARTH:inertial as Mars (the drawn Mars) plus the Mars-relative sample, at the orbit radius from Mars', () => {
    for (const dt of [0, 777_000, -1_500_000, 2_900_000]) {
      const t = t0 + dt;
      const e = g.stateIn('mro', t, 'EARTH:inertial')!;
      const mars = convert({ frame: 'MARS:inertial', r: [0, 0, 0], v: [0, 0, 0] }, 'EARTH:inertial', t);
      const rel = at(t);
      expect(e.frame).toBe('EARTH:inertial');
      expect(norm(e.r)).toBeGreaterThan(5e7); // millions of km from the Earth
      for (let k = 0; k < 3; k++) {
        expect(e.r[k] - mars.r[k]).toBeCloseTo(rel[k], -0.5); // Hermite error well below 0.5 km at 5 min steps
        expect(e.v![k] - mars.v![k]).toBeCloseTo(rel[3 + k], 2);
      }
      expect(norm([e.r[0] - mars.r[0], e.r[1] - mars.r[1], e.r[2] - mars.r[2]])).toBeCloseTo(R, 0);
    }
  });

  it('gives the altitude above Mars (not the Earth) through stateToGeodetic', () => {
    for (let dt = -3_000_000; dt <= 3_000_000; dt += 411_000) {
      const t = t0 + dt;
      const alt = stateToGeodetic(g.stateOf('mro', t)!, t, 'MARS').alt;
      expect(alt).toBeGreaterThan(R - MARS.radiusKm - 25); // oblate Mars: up to ~20 km lower surface at the poles
      expect(alt).toBeLessThan(R - MARS.radiusKm + 25);
    }
  });
});

describe('entity sampled in MOON:inertial (Moon-centred Horizons track)', () => {
  const R = 1788; // km from the Moon's centre: ~50 km above the mean radius
  const v = Math.sqrt(MOON.gm / R);
  const period = (2 * Math.PI * R) / v; // s
  const w = (2 * Math.PI) / period;
  const t0 = T0;
  // polar circular orbit in the Moon's inertial equatorial axes: x-z plane, with velocities as Horizons returns them
  const at = (t: number): [number, number, number, number, number, number] => {
    const a = w * ((t - t0) / 1000);
    return [R * Math.cos(a), 0, R * Math.sin(a), -v * Math.sin(a), 0, v * Math.cos(a)];
  };
  const samples: Sample[] = [];
  for (let t = t0 - 3_600_000; t <= t0 + 3_600_000; t += 300_000) samples.push([t, ...at(t)]);
  const g = new EntityGraph();
  g.upsert({ id: 'lro', name: 'LRO', kind: 'probe', bodyId: 'MOON', aliases: {}, provider: { type: 'sampled', frame: 'MOON:inertial', samples }, updatedAt: 0 });

  it('stays a Moon-relative state in MOON:inertial', () => {
    const t = t0 + 1_234_567;
    const s = g.stateIn('lro', t, 'MOON:inertial')!;
    expect(s.frame).toBe('MOON:inertial');
    expect(norm(s.r)).toBeCloseTo(R, 0);
    expect(norm(s.v!)).toBeCloseTo(v, 2);
  });

  it('is expressed in EARTH:inertial as the Moon ephemeris position plus the Moon-relative sample', () => {
    for (const dt of [0, 777_000, -1_500_000, 2_900_000]) {
      const t = t0 + dt;
      const e = g.stateIn('lro', t, 'EARTH:inertial')!;
      const moon = MOON.ephemeris!(t);
      const rel = at(t);
      expect(e.frame).toBe('EARTH:inertial');
      for (let k = 0; k < 3; k++) {
        expect(e.r[k]).toBeCloseTo(moon.r[k] + rel[k], -0.5); // Hermite error well below 0.5 km
        expect(e.v![k]).toBeCloseTo(moon.v[k] + rel[3 + k], 2);
      }
      // far from the Earth's surface, near the Moon's distance
      expect(norm(e.r)).toBeGreaterThan(340_000);
      expect(norm(e.r)).toBeLessThan(420_000);
      // and the distance to the Moon is the orbit radius
      expect(norm([e.r[0] - moon.r[0], e.r[1] - moon.r[1], e.r[2] - moon.r[2]])).toBeCloseTo(R, 0);
    }
  });

  it('gives the altitude above the Moon (not the Earth) through stateToGeodetic', () => {
    for (let dt = -3_000_000; dt <= 3_000_000; dt += 411_000) {
      const t = t0 + dt;
      const viaMoon = stateToGeodetic(g.stateOf('lro', t)!, t, 'MOON');
      // ellipsoid flattening 0.0012: 50.6 km over the equator .. 52.7 km over the poles
      expect(viaMoon.alt).toBeGreaterThan(R - MOON.radiusKm - 0.1);
      expect(viaMoon.alt).toBeLessThan(R - MOON.radiusKm * (1 - MOON.flattening) + 0.1);
      // the same result when the state is first brought into Earth-inertial coordinates
      const viaEarth = stateToGeodetic(g.stateIn('lro', t, 'EARTH:inertial')!, t, 'MOON');
      expect(viaEarth.alt).toBeCloseTo(viaMoon.alt, 4);
      expect(Math.abs(viaEarth.lat - viaMoon.lat)).toBeLessThan(1e-9);
      // measured against the Earth the same track would be ~380 000 km up
      expect(stateToGeodetic(g.stateIn('lro', t, 'EARTH:inertial')!, t, 'EARTH').alt).toBeGreaterThan(340_000);
    }
  });

  it('converts to MOON:fixed, changing the speed only by the Moon rotation', () => {
    const t = t0 + 600_000;
    const f = g.stateIn('lro', t, 'MOON:fixed')!;
    expect(f.frame).toBe('MOON:fixed');
    expect(norm(f.r)).toBeCloseTo(R, 0);
    // the Moon spins once per 27.3 d (0.0000027 rad/s), so the fixed-frame speed differs from the orbital speed by < 5 m/s
    expect(Math.abs(norm(f.v!) - v)).toBeLessThan(0.005);
  });
});

describe('providers', () => {
  it('SGP4 yields a plausible ISS orbit', () => {
    const p = new Sgp4Provider(ISS_OMM);
    const s = p.stateAt(T0 + 3600_000)!;
    const g = stateToGeodetic(s, T0 + 3600_000, 'EARTH');
    expect(g.alt).toBeGreaterThan(350);
    expect(g.alt).toBeLessThan(470);
    expect(Math.abs(g.lat / DEG)).toBeLessThanOrEqual(51.7);
    expect(norm(s.v!)).toBeGreaterThan(7.5);
    expect(norm(s.v!)).toBeLessThan(7.8);
    expect(s.confidence).toBe(1);
  });

  it('SGP4 confidence drops for stale elements', () => {
    const p = new Sgp4Provider(ISS_OMM);
    expect(p.stateAt(T0 + 40 * 86400_000)!.confidence).toBeLessThan(1);
  });

  it('sampled provider interpolates linearly and returns null outside range', () => {
    const p = new SampledProvider('EARTH:inertial', [[0, 0, 0, 0], [1000, 10, 20, 30]]);
    expect(p.stateAt(500)!.r).toEqual([5, 10, 15]);
    expect(p.stateAt(-1)).toBeNull();
    expect(p.stateAt(1001)).toBeNull();
  });

  it('sampled provider hermite reproduces a quadratic path', () => {
    // x(t)=t^2 (t in s): v=2t
    const samples = [0, 1, 2, 3].map((s) => [s * 1000, s * s, 0, 0, 2 * s, 0, 0]);
    const p = new SampledProvider('EARTH:inertial', samples);
    const st = p.stateAt(1500)!;
    expect(st.r[0]).toBeCloseTo(2.25, 9);
    expect(st.v![0]).toBeCloseTo(3, 9);
  });

  it('keplerian circular orbit keeps radius and speed', () => {
    const a = 7000;
    const p = new KeplerianProvider('EARTH', { a, e: 0, i: 0.5, raan: 1, argp: 0, m0: 0, epochMs: T0 });
    const s = p.stateAt(T0 + 1234_000)!;
    expect(norm(s.r)).toBeCloseTo(a, 6);
    expect(norm(s.v!)).toBeCloseTo(Math.sqrt(EARTH.gm / a), 6);
  });

  it('geodetic provider is stationary in the fixed frame', () => {
    const s = new GeodeticProvider('MARS', -4.5, 137.4, -4.5).stateAt()!;
    expect(s.frame).toBe('MARS:fixed');
    expect(norm(s.r)).toBeGreaterThan(3380);
  });

  it('specs round-trip through providerFromSpec', () => {
    const p = providerFromSpec(new Sgp4Provider(ISS_OMM).toSpec());
    expect(p.stateAt(T0)).not.toBeNull();
  });

  it('relative ENU provider offsets upward from a surface parent', () => {
    const g = new EntityGraph();
    g.upsert({
      id: 'pad', name: 'pad', kind: 'pad', bodyId: 'EARTH', aliases: {}, updatedAt: 0,
      provider: { type: 'geodetic', bodyId: 'EARTH', latDeg: 28.5, lonDeg: -80.6, altKm: 0 },
    });
    g.upsert({
      id: 'drone', name: 'drone', kind: 'drone', bodyId: 'EARTH', aliases: {}, updatedAt: 0, parentId: 'pad',
      provider: { type: 'relative', parentId: 'pad', mode: 'enu', offsetKm: [0, 0, 0.1] },
    });
    const gd = stateToGeodetic(g.stateOf('drone', T0)!, T0, 'EARTH');
    expect(gd.alt).toBeCloseTo(0.1, 5);
    expect(gd.lat / DEG).toBeCloseTo(28.5, 3);
  });

  it('composite provider hands off between phases (booster: ascent -> landing burn -> landed)', () => {
    const pad = new GeodeticProvider('EARTH', 28.5, -80.6, 0).stateAt().r;
    const c = new CompositeProvider([
      { fromMs: 0, toMs: 100_000, phase: 'ascent', spec: { type: 'sampled', frame: 'EARTH:fixed', samples: [[0, ...pad], [100_000, pad[0] + 70, pad[1], pad[2] + 70]] } },
      { fromMs: 100_001, toMs: 400_000, phase: 'landing', spec: { type: 'sampled', frame: 'EARTH:fixed', samples: [[100_001, pad[0] + 70, pad[1], pad[2] + 70], [400_000, ...pad]] } },
      { fromMs: 400_001, toMs: 9e12, phase: 'landed', spec: { type: 'geodetic', bodyId: 'EARTH', latDeg: 28.5, lonDeg: -80.6, altKm: 0 } },
    ]);
    expect(c.segmentAt(50_000)!.phase).toBe('ascent');
    expect(c.segmentAt(200_000)!.phase).toBe('landing');
    expect(c.segmentAt(1e6)!.phase).toBe('landed');
    expect(c.stateAt(50_000)).not.toBeNull();
    expect(c.stateAt(-5)).toBeNull();
  });
});

describe('mission FSM', () => {
  const net = Date.parse('2026-01-01T00:00:00Z');
  const at = (statusId: number, offsetSec: number) => deriveMissionState({ statusId, netMs: net, nowMs: net + offsetSec * 1000 });

  it('walks SCHEDULED -> COUNTDOWN -> ASCENT -> INSERTION -> ON_ORBIT', () => {
    expect(at(LL2_STATUS.GO, -86400).phase).toBe('SCHEDULED');
    expect(at(LL2_STATUS.GO, -600).phase).toBe('COUNTDOWN');
    expect(at(LL2_STATUS.IN_FLIGHT, 120).phase).toBe('ACTIVE_ASCENT');
    expect(at(LL2_STATUS.IN_FLIGHT, 700).phase).toBe('ORBIT_INSERTION');
    expect(at(LL2_STATUS.IN_FLIGHT, 5000).phase).toBe('ON_ORBIT');
    expect(at(LL2_STATUS.SUCCESS, 9000).phase).toBe('ON_ORBIT');
  });

  it('ends ORBIT_INSERTION with the modeled ascent (T+1110 s) and falls to ON_ORBIT for a late Go or unknown status', () => {
    expect(at(LL2_STATUS.IN_FLIGHT, 1109).phase).toBe('ORBIT_INSERTION');
    expect(at(LL2_STATUS.IN_FLIGHT, 1111).phase).toBe('ON_ORBIT');
    expect(at(LL2_STATUS.GO, 120).phase).toBe('ACTIVE_ASCENT');
    expect(at(LL2_STATUS.GO, 700).phase).toBe('ORBIT_INSERTION');
    expect(at(LL2_STATUS.GO, 1200)).toMatchObject({ phase: 'ON_ORBIT', hold: false });
    expect(at(LL2_STATUS.GO, 86_400).phase).toBe('ON_ORBIT');
    expect(at(9, 1200).phase).toBe('ON_ORBIT'); // a status id this table does not know
    // pre-launch statuses past NET stay scheduled: the launch has not happened
    for (const s of [LL2_STATUS.TBD, LL2_STATUS.TBC, LL2_STATUS.HOLD]) expect(at(s, 1200).phase).toBe('SCHEDULED');
    // vehicle timings come from the profile
    expect(deriveMissionState({ statusId: LL2_STATUS.GO, netMs: net, nowMs: net + 1130_000, ...missionTimingFor({ vehicle: 'Electron', name: 'Electron | X' }) }).phase).toBe('ORBIT_INSERTION');
    expect(deriveMissionState({ statusId: LL2_STATUS.GO, netMs: net, nowMs: net + 1130_000, ...missionTimingFor({ vehicle: 'Falcon 9 Block 5', name: 'Falcon 9 | X' }) }).phase).toBe('ON_ORBIT');
    expect(missionTimingFor({ vehicle: 'Ariane 6', name: 'Ariane 6 | X' })).toEqual({});
  });

  it('reports holds and failures', () => {
    expect(at(LL2_STATUS.HOLD, -300)).toMatchObject({ phase: 'COUNTDOWN', hold: true });
    expect(at(LL2_STATUS.FAILURE, 60).phase).toBe('FAILED');
  });

  it('formats countdowns', () => {
    expect(formatCountdown(3_723_000)).toBe('T-01:02:03');
    expect(formatCountdown(-10_000)).toBe('T+00:00:10');
  });
});

describe('clock', () => {
  it('runs live, pauses, and scrubs at rate', () => {
    let wall = 1_000_000;
    const c = new Clock(() => wall);
    expect(c.now()).toBe(wall);
    c.seek(5_000, 10);
    wall += 1000;
    expect(c.now()).toBe(15_000);
    c.pause();
    wall += 5000;
    expect(c.now()).toBe(15_000);
    c.goLive();
    expect(c.now()).toBe(wall);
  });
});
