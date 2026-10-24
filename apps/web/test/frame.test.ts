import { describe, expect, it } from 'vitest';
import {
  EntityGraph, MOON, bodyEntityRecords, bodyPeriodSec, bodyStateEci, defaultBodies, moonPositionEci, norm,
  type EntityRecord, type Sample, type Vec3,
} from '@eio/core';
import {
  EARTH_CENTRE, bodyCentre, centreKey, centreLabel, centrePositionEci, centreStateEci, entityCentre, entityRelativeToCentre,
  frameChainLabel, frameCrumbs, frameFor, frameForRec, framePathPoint, frameSampler, graphLookup, isEarthCentre, isOrbitableBody,
  relativeState, sameCentre,
} from '../src/lib/frame';
import { orbitPeriodSec } from '../src/lib/orbit';
import { displayPosition, makePathBuffers, samplePath } from '../src/lib/paths';
import { computeTelemetry } from '../src/lib/telemetry';
import { mockSatellites } from '../src/mock/generators';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const MIN = 60_000, HOUR = 3_600_000;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a: Vec3, b: Vec3): number => norm(sub(a, b));

/** A synthetic Moon orbiter: circular, sampled in MOON:inertial every 5 minutes with velocities (like the Horizons fetch). */
function lroLike(radiusKm = MOON.radiusKm + 100, from = NOW - 2 * HOUR, to = NOW + 6 * HOUR): EntityRecord {
  const w = Math.sqrt(MOON.gm / radiusKm ** 3); // rad/s
  const samples: Sample[] = [];
  for (let t = from; t <= to; t += 5 * MIN) {
    const a = w * ((t - NOW) / 1000);
    // a near-polar circle: e1 along x, e2 in the y-z plane (unit vector)
    const n2 = Math.hypot(0.3, 0.95), e2y = 0.3 / n2, e2z = 0.95 / n2;
    samples.push([t, radiusKm * Math.cos(a), radiusKm * Math.sin(a) * e2y, radiusKm * Math.sin(a) * e2z, -radiusKm * w * Math.sin(a), radiusKm * w * Math.cos(a) * e2y, radiusKm * w * Math.cos(a) * e2z]);
  }
  return {
    id: 'lro', name: 'LRO', kind: 'probe', bodyId: 'MOON', aliases: {},
    provider: { type: 'sampled', frame: 'MOON:inertial', samples }, updatedAt: 0,
  };
}

describe('centres', () => {
  const g = new EntityGraph();
  const iss = mockSatellites(NOW).find((s) => s.id === 'sat-25544')!;
  g.upsert(iss);
  const lookup = graphLookup(g);

  it('has the Earth as default and compares centres by kind and id', () => {
    expect(EARTH_CENTRE).toEqual({ kind: 'body', id: 'EARTH' });
    expect(isEarthCentre(EARTH_CENTRE)).toBe(true);
    expect(isEarthCentre(bodyCentre('MOON'))).toBe(false);
    expect(isEarthCentre(entityCentre('EARTH'))).toBe(false);
    expect(sameCentre(bodyCentre('MOON'), bodyCentre('MOON'))).toBe(true);
    expect(sameCentre(bodyCentre('MOON'), entityCentre('MOON'))).toBe(false);
    expect(centreKey(entityCentre('x'))).toBe('entity:x');
  });

  it('knows which bodies can be a frame centre', () => {
    expect(['EARTH', 'MOON', 'SUN', 'MARS'].every(isOrbitableBody)).toBe(true);
    expect(isOrbitableBody('sat-25544')).toBe(false);
    expect(isOrbitableBody('body-moon')).toBe(false); // registry ids, not entity ids
  });

  it('places Mars from the core body state (heliocentric, 5e7 to 4e8 km from the Earth)', () => {
    const mars = centrePositionEci(bodyCentre('MARS'), NOW, lookup)!;
    expect(mars).toEqual(bodyStateEci('MARS', NOW).r);
    expect(norm(mars)).toBeGreaterThan(5e7);
    expect(norm(mars)).toBeLessThan(4e8);
    expect(centreStateEci(bodyCentre('SUN'), NOW, lookup)!.v).toEqual(bodyStateEci('SUN', NOW).v);
  });

  it('places body centres from the same series the scene draws and entity centres from their state', () => {
    expect(centrePositionEci(EARTH_CENTRE, NOW, lookup)).toEqual([0, 0, 0]);
    expect(centrePositionEci(bodyCentre('MOON'), NOW, lookup)).toEqual(moonPositionEci(NOW));
    const sun = centrePositionEci(bodyCentre('SUN'), NOW, lookup)!;
    expect(norm(sun)).toBeGreaterThan(1.45e8);
    expect(centrePositionEci(bodyCentre('NOPE'), NOW, lookup)).toBeNull();
    expect(centrePositionEci(entityCentre(iss.id), NOW, lookup)).toEqual(g.stateIn(iss.id, NOW, 'EARTH:inertial')!.r);
    expect(centrePositionEci(entityCentre('unknown'), NOW, lookup)).toBeNull();
  });

  it('expresses an entity relative to a body or entity centre (translation: velocities subtract)', () => {
    const other = mockSatellites(NOW).find((s) => s.id !== iss.id && s.kind === 'satellite')!;
    g.upsert(other);
    const a = g.stateIn(iss.id, NOW, 'EARTH:inertial')!, b = g.stateIn(other.id, NOW, 'EARTH:inertial')!;
    const rel = entityRelativeToCentre(other.id, entityCentre(iss.id), NOW, lookup)!;
    expect(rel.r).toEqual(sub(b.r, a.r));
    expect(rel.v).toEqual(sub(b.v!, a.v!));
    expect(relativeState({ r: [3, 2, 1] }, { r: [1, 1, 1], v: [1, 1, 1] }).v).toBeUndefined();
    const moonRel = entityRelativeToCentre(iss.id, bodyCentre('MOON'), NOW, lookup)!;
    expect(moonRel.r).toEqual(sub(a.r, moonPositionEci(NOW)));
    expect(entityRelativeToCentre('unknown', EARTH_CENTRE, NOW, lookup)).toBeNull();
  });

  it('draws the entity that is the centre relative to its primary body instead of to itself', () => {
    expect(frameFor(entityCentre('lro'), 'lro', 'MOON')).toEqual(bodyCentre('MOON'));
    expect(frameFor(entityCentre('iss'), 'lro', 'MOON')).toEqual(entityCentre('iss'));
    expect(frameFor(bodyCentre('SUN'), 'lro', 'MOON')).toEqual(bodyCentre('SUN'));
  });

  it('samples a body entity in its parent body frame whatever the active centre is (the Sun keeps the centre)', () => {
    const recs = Object.fromEntries(bodyEntityRecords().map((r) => [r.id, r]));
    for (const centre of [EARTH_CENTRE, bodyCentre('MOON'), bodyCentre('SUN'), entityCentre('body-moon'), entityCentre('sat-1')]) {
      expect(frameForRec(centre, recs['body-moon'])).toEqual(bodyCentre('EARTH'));
      expect(frameForRec(centre, recs['body-earth'])).toEqual(bodyCentre('SUN'));
      expect(frameForRec(centre, recs['body-mars'])).toEqual(bodyCentre('SUN'));
      expect(frameForRec(centre, recs['body-sun'])).toEqual(centre);
    }
    expect(frameFor(entityCentre('body-moon'), 'body-moon', 'EARTH', 'MOON')).toEqual(bodyCentre('EARTH'));
    // ordinary records behave as before
    expect(frameForRec(entityCentre('lro'), lroLike())).toEqual(bodyCentre('MOON'));
    expect(frameForRec(bodyCentre('SUN'), lroLike())).toEqual(bodyCentre('SUN'));
  });

  it('draws the Moon entity path as a closed ellipse around the Earth, Earth and Mars around the Sun', () => {
    const g = new EntityGraph();
    const recs = bodyEntityRecords();
    for (const r of recs) g.upsert(r);
    const lookup = graphLookup(g);
    const moon = recs.find((r) => r.id === 'body-moon')!;
    const period = bodyPeriodSec(defaultBodies.get('MOON'))! * 1000;
    expect(period / 86_400_000).toBeGreaterThan(27);
    expect(period / 86_400_000).toBeLessThan(27.8);
    // an active Moon centre does not change the sampling centre of the Moon's own orbit
    const buf = makePathBuffers();
    const res = samplePath(g, moon.id, { t0: NOW, t1: NOW + period }, moon.provider, buf, 'compressed',
      frameSampler(frameForRec(bodyCentre('MOON'), moon), NOW, lookup));
    expect(res.count).toBeGreaterThan(100);
    // around the Earth's centre (the origin): distances stay in the Moon's 356,000 to 407,000 km range, and the loop closes
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < res.count; i++) {
      const d = Math.hypot(buf.pos[i * 3], buf.pos[i * 3 + 1], buf.pos[i * 3 + 2]);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    expect(lo).toBeGreaterThan(350_000);
    expect(hi).toBeLessThan(410_000);
    const last = res.count - 1;
    expect(dist([buf.pos[0], buf.pos[1], buf.pos[2]], [buf.pos[last * 3], buf.pos[last * 3 + 1], buf.pos[last * 3 + 2]])).toBeLessThan(0.12 * lo);

    // Earth in the Sun's frame: the offset from the Sun is about 1 AU all along (drawn around the Sun's current position)
    const earth = recs.find((r) => r.id === 'body-earth')!;
    const sunLookup = graphLookup(g);
    const sampler = frameSampler(frameForRec(EARTH_CENTRE, earth), NOW, sunLookup)!;
    const sunNow = sampler.ref!;
    expect(norm(sunNow)).toBeGreaterThan(1.45e8);
    const eb = makePathBuffers();
    const er = samplePath(g, earth.id, { t0: NOW, t1: NOW + 100 * 86_400_000 }, earth.provider, eb, 'true', sampler);
    expect(er.count).toBeGreaterThan(10);
    for (let i = 0; i < er.count; i += 5) {
      const d = dist([eb.pos[i * 3], eb.pos[i * 3 + 1], eb.pos[i * 3 + 2]], sunNow);
      expect(d).toBeGreaterThan(1.45e8);
      expect(d).toBeLessThan(1.55e8);
    }
  });
});

describe('framePathPoint', () => {
  it('is r(t_i) - c(t_i) + c(now), and r(t_i) for a centre at the origin', () => {
    expect(framePathPoint([10, 20, 30], [1, 2, 3], [100, 200, 300])).toEqual([109, 218, 327]);
    expect(framePathPoint([10, 20, 30], [0, 0, 0], [0, 0, 0])).toEqual([10, 20, 30]);
  });
});

describe('frame labels', () => {
  const recs = new Map<string, { name: string; bodyId: string }>([
    ['lro', { name: 'LRO', bodyId: 'MOON' }], ['iss', { name: 'ISS (ZARYA)', bodyId: 'EARTH' }],
  ]);
  const rec = (id: string) => recs.get(id);

  it('chains a body centre through the body tree', () => {
    expect(frameChainLabel(EARTH_CENTRE, rec)).toBe('SUN > EARTH');
    expect(frameChainLabel(bodyCentre('MOON'), rec)).toBe('SUN > EARTH > MOON');
    expect(frameChainLabel(bodyCentre('SUN'), rec)).toBe('SUN');
    expect(frameChainLabel(bodyCentre('MARS'), rec)).toBe('SUN > MARS');
    expect(frameChainLabel(bodyCentre('XYZ'), rec)).toBe('XYZ');
  });

  it('shows an entity centre after its primary body chain', () => {
    expect(frameChainLabel(entityCentre('lro'), rec)).toBe('SUN > EARTH > MOON > LRO');
    expect(frameChainLabel(entityCentre('iss'), rec)).toBe('SUN > EARTH > ISS (ZARYA)');
    expect(frameChainLabel(entityCentre('gone'), rec)).toBe('gone');
    const crumbs = frameCrumbs(entityCentre('lro'), rec);
    expect(crumbs.map((c) => c.centre)).toEqual([bodyCentre('SUN'), bodyCentre('EARTH'), bodyCentre('MOON'), entityCentre('lro')]);
  });

  it('has short labels for readouts and the HUD', () => {
    expect(centreLabel(bodyCentre('MOON'), rec)).toBe('Moon');
    expect(centreLabel(entityCentre('iss'), rec)).toBe('ISS (ZARYA)');
    expect(centreLabel(entityCentre('gone'), rec)).toBe('gone');
  });
});

describe('paths sampled in the frame', () => {
  const lro = lroLike();
  const g = new EntityGraph();
  g.upsert(lro);
  const lookup = graphLookup(g);
  const period = 2 * Math.PI * Math.sqrt((MOON.radiusKm + 100) ** 3 / MOON.gm) * 1000;
  const plan = { t0: NOW, t1: NOW + period };

  it('with the Earth centre reproduces the unframed output exactly', () => {
    const plain = makePathBuffers(), framed = makePathBuffers();
    const a = samplePath(g, lro.id, plan, lro.provider, plain);
    const b = samplePath(g, lro.id, plan, lro.provider, framed, 'compressed', frameSampler(EARTH_CENTRE, NOW, lookup));
    expect(b.count).toBe(a.count);
    expect(Array.from(framed.pos.subarray(0, b.count * 3))).toEqual(Array.from(plain.pos.subarray(0, a.count * 3)));
    expect(b.centreRef).toBeNull();
    // and it is what the pre-frame code computed: the Earth-inertial state, display position
    const t = plain.times[7];
    const s = g.stateIn(lro.id, t, 'EARTH:inertial')!;
    expect(Array.from(plain.pos.subarray(21, 24))).toEqual(displayPosition(s.r).r);
  });

  it('draws a Moon orbiter as a closed circle around the Moon in the Moon frame, not in the Earth frame', () => {
    const buf = makePathBuffers();
    const res = samplePath(g, lro.id, plan, lro.provider, buf, 'compressed', frameSampler(bodyCentre('MOON'), NOW, lookup));
    expect(res.count).toBeGreaterThan(400);
    expect(res.centreRef).toEqual(moonPositionEci(NOW));
    const c = res.centreRef!;
    const R = MOON.radiusKm + 100;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < res.count; i++) {
      const d = dist([buf.pos[i * 3], buf.pos[i * 3 + 1], buf.pos[i * 3 + 2]], c);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    expect(lo).toBeGreaterThan(R * 0.999);
    expect(hi).toBeLessThan(R * 1.001);
    // after one revolution it is back where it started
    const last = res.count - 1;
    expect(dist([buf.pos[0], buf.pos[1], buf.pos[2]], [buf.pos[last * 3], buf.pos[last * 3 + 1], buf.pos[last * 3 + 2]])).toBeLessThan(1);
    expect(res.moving).toBe(true);

    // the same samples seen from the Earth are nowhere near a circle around any fixed point
    const earth = makePathBuffers();
    const e = samplePath(g, lro.id, plan, lro.provider, earth);
    const around = (i: number) => dist([earth.pos[i * 3], earth.pos[i * 3 + 1], earth.pos[i * 3 + 2]], c);
    const dEnd = around(e.count - 1);
    expect(dEnd).toBeGreaterThan(R * 1.5); // the Moon moved ~7,000 km in 2 hours: the Earth-frame loop does not close
  });

  it('follows the centre: the stored path is around the centre at build time, the scene shifts it by c(now) - ref', () => {
    const buf = makePathBuffers();
    const built = NOW;
    const res = samplePath(g, lro.id, plan, lro.provider, buf, 'compressed', frameSampler(bodyCentre('MOON'), built, lookup));
    const later = NOW + 20 * MIN;
    const shift = sub(moonPositionEci(later), res.centreRef!);
    expect(norm(shift)).toBeGreaterThan(1000); // the Moon moved ~1.2 km/s
    // the first sample, shifted, is the orbiter's offset from the Moon at t0 around the Moon's position at `later`
    const rel0 = sub(g.stateIn(lro.id, plan.t0, 'EARTH:inertial')!.r, moonPositionEci(plan.t0));
    const drawn: Vec3 = [buf.pos[0] + shift[0], buf.pos[1] + shift[1], buf.pos[2] + shift[2]];
    expect(dist(drawn, moonPositionEci(later))).toBeCloseTo(norm(rel0), 3);
  });

  it('is empty while the centre entity has no state at the build time, and skips samples it cannot place', () => {
    const buf = makePathBuffers();
    const gone = samplePath(g, lro.id, plan, lro.provider, buf, 'compressed', frameSampler(entityCentre('nobody'), NOW, lookup));
    expect(gone.count).toBe(0);
    expect(gone.moving).toBe(false);
  });

  it('an Earth satellite seen from the Moon is the true relative curve', () => {
    const iss = mockSatellites(NOW).find((s) => s.id === 'sat-25544')!;
    const g2 = new EntityGraph();
    g2.upsert(iss);
    const buf = makePathBuffers();
    const res = samplePath(g2, iss.id, { t0: NOW, t1: NOW + 30 * MIN }, undefined, buf, 'compressed', frameSampler(bodyCentre('MOON'), NOW, graphLookup(g2)));
    const t = buf.times[100];
    const r = g2.stateIn(iss.id, t, 'EARTH:inertial')!.r;
    const expected = framePathPoint(r, moonPositionEci(t), moonPositionEci(NOW));
    expect(Array.from(buf.pos.subarray(300, 303))).toEqual(displayPosition(expected).r);
    expect(res.count).toBeGreaterThan(100);
  });
});

describe('primary body physics', () => {
  it('gives a Moon-orbiting circular state the Moon period, not the Earth one', () => {
    const rec = lroLike();
    const g = new EntityGraph();
    g.upsert(rec);
    const R = MOON.radiusKm + 100;
    const v = Math.sqrt(MOON.gm / R);
    const moonState = { frame: 'MOON:inertial' as const, r: [R, 0, 0] as Vec3, v: [0, v, 0] as Vec3 };
    const expected = 2 * Math.PI * Math.sqrt(R ** 3 / MOON.gm);
    expect(orbitPeriodSec(g, rec, moonState)).toBeCloseTo(expected, 3);
    expect(expected / 60).toBeGreaterThan(110); // about 2 hours (Earth's gm would say ~20 minutes)
    expect(expected / 60).toBeLessThan(125);
    // an Earth-inertial state is converted into the Moon's frame first when the time is given
    const eci = g.stateIn(rec.id, NOW, 'EARTH:inertial')!;
    expect(orbitPeriodSec(g, rec, eci, NOW)! / 60).toBeGreaterThan(110);
    expect(orbitPeriodSec(g, rec, eci, NOW)! / 60).toBeLessThan(125);
    // without a time an Earth-frame state cannot be converted
    expect(orbitPeriodSec(g, rec, eci)).toBeNull();
    // a periapsis below the Moon's surface is no orbit; 40 km above it is (the Moon has no atmosphere)
    expect(orbitPeriodSec(g, rec, { ...moonState, r: [MOON.radiusKm - 10, 0, 0], v: [0, Math.sqrt(MOON.gm / (MOON.radiusKm - 10)), 0] })).toBeNull();
    expect(orbitPeriodSec(g, rec, { ...moonState, r: [MOON.radiusKm + 40, 0, 0], v: [0, Math.sqrt(MOON.gm / (MOON.radiusKm + 40)), 0] })).not.toBeNull();
  });

  it('gives body entities the period of their orbit around the parent body, and the Sun none', () => {
    const g = new EntityGraph();
    const recs = Object.fromEntries(bodyEntityRecords().map((r) => [r.id, r]));
    for (const r of Object.values(recs)) g.upsert(r);
    const day = 86_400;
    const period = (id: string) => orbitPeriodSec(g, recs[id], g.stateIn(id, NOW, 'EARTH:inertial')!, NOW);
    expect(period('body-moon')! / day).toBeGreaterThan(27.2);
    expect(period('body-moon')! / day).toBeLessThan(27.6);
    expect(period('body-earth')! / day).toBeGreaterThan(365);
    expect(period('body-earth')! / day).toBeLessThan(365.6);
    expect(period('body-mars')! / day).toBeGreaterThan(680);
    expect(period('body-mars')! / day).toBeLessThan(695);
    expect(period('body-sun')).toBeNull();
    // the satellite limits (closed orbit within 5e5 km of the Earth) do not apply to a body
    expect(period('body-moon')).toBeCloseTo(bodyPeriodSec(defaultBodies.get('MOON'))!, 6);
  });

  it('reports the Moon period and the Moon-relative altitude in the telemetry of a Moon orbiter', () => {
    const rec = lroLike();
    const g = new EntityGraph();
    g.upsert(rec);
    const tel = computeTelemetry(g, rec, NOW)!;
    expect(tel.periodSec! / 60).toBeGreaterThan(110);
    expect(tel.periodSec! / 60).toBeLessThan(125);
    expect(tel.altKm).toBeCloseTo(100, 0); // altitude above the Moon, not above the Earth
    expect(tel.rangeKm).toBeGreaterThan(300_000); // geocentric
  });
});

describe('readouts relative to the frame centre', () => {
  const sats = mockSatellites(NOW);
  const iss = sats.find((s) => s.id === 'sat-25544')!;
  const other = sats.find((s) => s.id !== iss.id && s.kind === 'satellite')!;
  const g = new EntityGraph();
  g.upsert(iss);
  g.upsert(other);

  it('measures range and speed from an entity centre', () => {
    const tel = computeTelemetry(g, other, NOW, entityCentre(iss.id))!;
    const a = g.stateIn(iss.id, NOW, 'EARTH:inertial')!, b = g.stateIn(other.id, NOW, 'EARTH:inertial')!;
    expect(tel.refRangeKm).toBeCloseTo(dist(a.r, b.r), 6);
    expect(tel.refSpeedKmS).toBeCloseTo(dist(a.v!, b.v!), 9);
    // the Earth-based readouts are unchanged
    expect(tel.rangeKm).toBeCloseTo(norm(b.r), 6);
  });

  it('adds no relative readout for the entity that is the centre, or when the centre has no state', () => {
    expect(computeTelemetry(g, iss, NOW, entityCentre(iss.id))!.refRangeKm).toBeUndefined();
    expect(computeTelemetry(g, iss, NOW, entityCentre('unknown'))!.refRangeKm).toBeUndefined();
    expect(computeTelemetry(g, iss, NOW, EARTH_CENTRE)!.refRangeKm).toBeUndefined();
  });
});
