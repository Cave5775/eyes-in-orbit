import { describe, expect, it } from 'vitest';
import {
  BOOSTER_SHAPE, CompositeProvider, DEG, EARTH, FALCON9_BOOSTER, airDensity, boosterLandingPoint, modelBoosterReturn, modelFalcon9Ascent,
  modeledBoosterSegments, providerFromSpec, stateToGeodetic, terminalVelocityKmS, type BoosterPhysics, type ModeledAscent,
} from '../src';

const CAPE = { padLatDeg: 28.5618, padLonDeg: -80.5772 };
const VSFB = { padLatDeg: 34.632, padLonDeg: -120.611 };
const rtls = () => modelFalcon9Ascent({ ...CAPE, inclinationDeg: 51.6, recovery: 'rtls' });
const ship = () => modelFalcon9Ascent({ ...CAPE, inclinationDeg: 53, recovery: 'droneship' });
const west = () => modelFalcon9Ascent({ ...VSFB, inclinationDeg: 70, branch: 'south', recovery: 'droneship' });

const track = (m: ModeledAscent) => m.booster!;

describe('booster return', () => {
  it('exists for recovered boosters only', () => {
    expect(rtls().booster).not.toBeNull();
    expect(ship().booster).not.toBeNull();
    expect(modelFalcon9Ascent({ ...CAPE, inclinationDeg: 51.6, recovery: 'none' }).booster).toBeNull();
  });

  it('starts from the separation state of the vehicle and ends at rest on the surface', () => {
    for (const m of [rtls(), ship(), west()]) {
      const b = track(m);
      const sep = m.events.find((e) => e.name === 'STAGE_SEP')!.tSec;
      const first = b.rows[0], last = b.rows[b.rows.length - 1];
      const veh = m.rows.find((r) => r.tSec === sep)!;
      expect(first.tSec).toBe(sep);
      expect(first.altKm).toBeCloseTo(veh.altKm, 6);
      expect(first.downrangeKm).toBeCloseTo(veh.downrangeKm, 6);
      expect(first.speedKmS).toBeCloseTo(veh.speedKmS, 2);
      expect(last.tSec).toBe(m.events.find((e) => e.name === 'LANDING')!.tSec);
      expect(last.altKm).toBe(0);
      expect(last.speedKmS).toBe(0);
    }
  });

  it('touches down on the target: the landing zone (RTLS) or the droneship distance', () => {
    expect(track(rtls()).landingDownrangeKm).toBe(BOOSTER_SHAPE.rtlsLandingDownrangeKm);
    expect(track(rtls()).rows.at(-1)!.downrangeKm).toBeCloseTo(BOOSTER_SHAPE.rtlsLandingDownrangeKm, 1);
    expect(track(ship()).rows.at(-1)!.downrangeKm).toBeCloseTo(BOOSTER_SHAPE.droneshipDownrangeKm, 1);
    expect(track(west()).rows.at(-1)!.downrangeKm).toBeCloseTo(BOOSTER_SHAPE.droneshipDownrangeKm, 1);
  });

  it('turns back towards the pad on an RTLS flight and keeps going downrange for a droneship landing', () => {
    expect(track(rtls()).vxHoldKmS).toBeLessThan(0);
    const d = track(rtls()).rows.map((r) => r.downrangeKm);
    expect(Math.max(...d)).toBeGreaterThan(d[d.length - 1] + 20); // out and back
    expect(track(ship()).vxHoldKmS).toBeGreaterThan(1);
    expect(track(ship()).vxHoldKmS).toBeLessThan(2.4);
  });

  it('has a plausible shape: apogee, entry altitude, a descent that never climbs again, bounded speed jumps', () => {
    for (const m of [rtls(), ship()]) {
      const b = track(m);
      expect(b.apogeeKm).toBeGreaterThan(95);
      expect(b.apogeeKm).toBeLessThan(170);
      const entry = m.events.find((e) => e.name === 'ENTRY_BURN')!;
      expect(entry.altKm).toBeGreaterThan(40);
      expect(entry.altKm).toBeLessThan(110);
      const rows = b.rows;
      const iApogee = rows.findIndex((r) => r.altKm === b.apogeeKm);
      for (let i = iApogee + 1; i < rows.length; i++) expect(rows[i].altKm, `t=${rows[i].tSec}`).toBeLessThanOrEqual(rows[i - 1].altKm + 1e-6);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].tSec).toBeGreaterThan(rows[i - 1].tSec);
        expect(rows[i].altKm).toBeGreaterThanOrEqual(0);
        expect(Math.abs(rows[i].speedKmS - rows[i - 1].speedKmS), `t=${rows[i].tSec}`).toBeLessThan(0.45);
      }
    }
  });

  it('puts the booster events on the booster track with a state', () => {
    const m = rtls();
    for (const name of ['BOOSTBACK', 'ENTRY_BURN', 'LANDING_BURN', 'LANDING']) {
      const e = m.events.find((x) => x.name === name)!;
      expect(e.track).toBe('booster');
      expect(e.altKm).toBeGreaterThanOrEqual(0);
      expect(e.speedKmS).toBeGreaterThanOrEqual(0);
    }
    expect(m.events.find((e) => e.name === 'LANDING')!.altKm).toBe(0);
    expect(m.events.find((e) => e.name === 'LANDING_BURN')!.altKm).toBeCloseTo((Math.abs(BOOSTER_SHAPE.landingBurnVzKmS) * 25) / 2, 1);
  });

  it('derives the horizontal bleed from drag and entry-burn thrust: a few percent of the held speed is left at the landing burn', () => {
    for (const m of [rtls(), ship(), west()]) {
      expect(track(m).residualHorizontal).toBeGreaterThan(0.02);
      expect(track(m).residualHorizontal).toBeLessThan(0.15);
    }
  });
});

describe('booster descent physics', () => {
  const start = { sepSec: 153, downrangeKm: 83, altKm: 71, vxKmS: 2.2, vzKmS: 0.9 };
  const times = { boostbackSec: 165, entrySec: 365, landingBurnSec: 440, landingSec: 465 };
  const residual = (physics: BoosterPhysics, recovery: 'rtls' | 'droneship' = 'rtls') =>
    modelBoosterReturn(start, { recovery, physics, ...times }).residualHorizontal;

  it('has the standard atmosphere right at the table points and falls off smoothly between them', () => {
    expect(airDensity(0)).toBeCloseTo(1.225, 6);
    expect(airDensity(10)).toBeCloseTo(0.4135, 6);
    expect(airDensity(100)).toBeCloseTo(5.604e-7, 12);
    expect(airDensity(-5)).toBe(airDensity(0));
    const mid = airDensity(7.5);
    expect(mid).toBeLessThan(airDensity(5));
    expect(mid).toBeGreaterThan(airDensity(10));
    expect(mid).toBeCloseTo(Math.sqrt(0.7364 * 0.4135), 3); // log-linear: the geometric mean at the midpoint
    let prev = Infinity;
    for (let z = 0; z <= 140; z += 2.5) {
      const d = airDensity(z);
      expect(d).toBeLessThan(prev);
      prev = d;
    }
  });

  it('puts the terminal velocity at the landing-burn altitude near the assumed landing-burn entry speed', () => {
    const vt = terminalVelocityKmS((Math.abs(BOOSTER_SHAPE.landingBurnVzKmS) * 25) / 2, FALCON9_BOOSTER);
    expect(vt).toBeGreaterThan(0.15);
    expect(vt).toBeLessThan(0.35);
    expect(Math.abs(vt - Math.abs(BOOSTER_SHAPE.landingBurnVzKmS)) / Math.abs(BOOSTER_SHAPE.landingBurnVzKmS)).toBeLessThan(0.5);
  });

  it('bleeds more speed with more drag, less with a heavier stage, and less without the entry burn', () => {
    const base = residual(FALCON9_BOOSTER);
    expect(base).toBeGreaterThan(0);
    expect(base).toBeLessThan(1);
    expect(residual({ ...FALCON9_BOOSTER, cd: FALCON9_BOOSTER.cd * 3 })).toBeLessThan(base);
    expect(residual({ ...FALCON9_BOOSTER, areaM2: FALCON9_BOOSTER.areaM2 * 3 })).toBeLessThan(base);
    expect(residual({ ...FALCON9_BOOSTER, massKg: FALCON9_BOOSTER.massKg * 3 })).toBeGreaterThan(base);
    expect(residual({ ...FALCON9_BOOSTER, entryThrustN: 1 })).toBeGreaterThan(base);
    expect(residual({ ...FALCON9_BOOSTER, entryBurnSec: 40 })).toBeLessThan(base);
  });

  it('still lands on the target whatever the physics says', () => {
    for (const physics of [FALCON9_BOOSTER, { ...FALCON9_BOOSTER, cd: 0.4 }, { ...FALCON9_BOOSTER, massKg: 90_000, entryThrustN: 5e5 }]) {
      for (const recovery of ['rtls', 'droneship'] as const) {
        const t = modelBoosterReturn(start, { recovery, physics, ...times, boostbackSec: recovery === 'rtls' ? 165 : undefined, landingDownrangeKm: recovery === 'rtls' ? 8 : 600 });
        expect(t.rows.at(-1)!.downrangeKm).toBeCloseTo(recovery === 'rtls' ? 8 : 600, 1);
        expect(Number.isFinite(t.vxHoldKmS)).toBe(true);
      }
    }
  });
});

describe('booster entity path', () => {
  const net = Date.parse('2026-10-24T00:00:00Z');
  const pad = { latDeg: CAPE.padLatDeg, lonDeg: CAPE.padLonDeg };

  it('is a pad, ascent, return and landed composite that has a state at every instant', () => {
    const m = rtls();
    const segs = modeledBoosterSegments(net, pad, m)!;
    expect(segs.map((s) => s.phase)).toEqual(['pad', 'stage 1 ascent', 'coast', 'boostback burn', 'coast', 'entry burn', 'landing burn', 'landed']);
    const p = providerFromSpec({ type: 'composite', segments: segs }) as CompositeProvider;
    const landing = m.events.find((e) => e.name === 'LANDING')!.tSec;
    for (let t = -10; t <= landing + 5; t += 0.5) expect(p.stateAt(net + t * 1000), `t=${t}`).not.toBeNull();
    expect(p.segmentAt(net + (landing + 60) * 1000)!.phase).toBe('landed');
  });

  it('parks at the landing point, a few km from the pad for RTLS and about 600 km away for a droneship', () => {
    for (const [m, km] of [[rtls(), 8], [ship(), 600]] as const) {
      const segs = modeledBoosterSegments(net, pad, m)!;
      const p = providerFromSpec({ type: 'composite', segments: segs }) as CompositeProvider;
      const land = boosterLandingPoint(pad, m)!;
      const s = p.stateAt(net + (m.events.find((e) => e.name === 'LANDING')!.tSec + 120) * 1000)!;
      const g = stateToGeodetic(s, net + 1e6, 'EARTH');
      expect(g.lat / DEG).toBeCloseTo(land.latDeg, 3);
      expect(g.lon / DEG).toBeCloseTo(land.lonDeg, 3);
      expect(g.alt).toBeLessThan(0.05);
      // great-circle distance from the pad matches the modeled downrange
      const a1 = pad.latDeg * DEG, a2 = land.latDeg * DEG, dl = (land.lonDeg - pad.lonDeg) * DEG;
      const d = EARTH.radiusKm * Math.acos(Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(dl));
      expect(d).toBeCloseTo(km, 0);
    }
  });

  it('is null for an expended booster', () => {
    const m = modelFalcon9Ascent({ ...CAPE, inclinationDeg: 51.6, recovery: 'none' });
    expect(modeledBoosterSegments(net, pad, m)).toBeNull();
    expect(boosterLandingPoint(pad, m)).toBeNull();
  });
});
