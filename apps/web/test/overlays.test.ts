import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EARTH, EntityGraph, MOON, bodyEntityRecords, bodyStateEci, moonPositionEci, norm, type EntityRecord, type Sample, type Vec3 } from '@eio/core';
import { EARTH_CENTRE, bodyCentre, framePathPoint, type Centre } from '../src/lib/frame';
import { refDisplay } from '../src/lib/ref-body';
import { mockLaunches, mockSatellites } from '../src/mock/generators';
import { EntityOverlay } from '../src/scene/overlays';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const bodies = bodyEntityRecords();
const body = (id: string) => bodies.find((b) => b.id === id)!;
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

interface Peek {
  orbit: { n: number; obj: THREE.Line; pos: { world: Float64Array; shift: readonly number[] } };
  trail: { n: number; obj: THREE.Line; pos: { world: Float64Array } };
}
const peek = (o: EntityOverlay) => o as unknown as Peek;
const point = (w: Float64Array, i: number): Vec3 => [w[i * 3], w[i * 3 + 1], w[i * 3 + 2]];
const drawn = (o: EntityOverlay) => peek(o).orbit.obj.geometry.drawRange;

function setup(recs: EntityRecord[]) {
  const graph = new EntityGraph();
  for (const r of recs) graph.upsert(r);
  const overlay = new EntityOverlay(new THREE.Group(), new THREE.Color(0xffffff));
  let wall = 0;
  const update = (rec: EntityRecord, t = NOW, full = false, centre: Centre = EARTH_CENTRE, scale: 'compressed' | 'true' = 'compressed') =>
    overlay.update(graph, rec, t, (wall += 1000), full, centre, scale);
  return { graph, overlay, update };
}

/** A circular Moon orbiter sampled in MOON:inertial (as in frame.test.ts). */
function lroLike(): EntityRecord {
  const R = MOON.radiusKm + 100, w = Math.sqrt(MOON.gm / R ** 3);
  const samples: Sample[] = [];
  for (let t = NOW - 2 * HOUR; t <= NOW + 6 * HOUR; t += 5 * MIN) {
    const a = w * ((t - NOW) / 1000);
    samples.push([t, R * Math.cos(a), R * Math.sin(a), 0, -R * w * Math.sin(a), R * w * Math.cos(a), 0]);
  }
  return { id: 'lro', name: 'LRO', kind: 'probe', bodyId: 'MOON', aliases: {}, provider: { type: 'sampled', frame: 'MOON:inertial', samples }, updatedAt: 0 };
}

describe('EntityOverlay: Earth satellites', () => {
  const iss = mockSatellites(NOW).find((s) => s.id === 'sat-25544')!;

  it('draws a closed orbit line through the satellite in the default frame', () => {
    const { graph, overlay, update } = setup([iss]);
    expect(overlay.hasOrbit).toBe(false);
    update(iss);
    expect(overlay.hasOrbit).toBe(true);
    const o = peek(overlay).orbit;
    expect(o.n).toBeGreaterThan(200);
    expect(drawn(overlay)).toEqual({ start: 0, count: o.n });
    expect(Array.from(o.pos.shift)).toEqual([0, 0, 0]);
    // the first point is the satellite, the last one is back at it after one revolution
    const s = graph.stateIn(iss.id, NOW, 'EARTH:inertial')!;
    expect(norm(sub(point(o.pos.world, 0), s.r))).toBeLessThan(1e-6);
    expect(norm(sub(point(o.pos.world, o.n - 1), s.r))).toBeLessThan(150);
  });

  it('keeps the orbit line round the Earth when the frame is the Moon, the trail follows the frame', () => {
    const def = setup([iss]);
    def.update(iss, NOW, true);
    const moon = setup([iss]);
    moon.update(iss, NOW, true, bodyCentre('MOON'));
    const a = peek(def.overlay), b = peek(moon.overlay);
    expect(moon.overlay.hasOrbit).toBe(true);
    expect(b.orbit.n).toBe(a.orbit.n);
    for (let i = 0; i < a.orbit.n; i += 37) expect(point(b.orbit.pos.world, i)).toEqual(point(a.orbit.pos.world, i));
    expect(Array.from(b.orbit.pos.shift)).toEqual([0, 0, 0]);
    // every orbit point is near the Earth, none is a Moon-frame spiral
    for (let i = 0; i < b.orbit.n; i++) expect(norm(point(b.orbit.pos.world, i))).toBeLessThan(8000);
    // the trail keeps the active frame: its last point is the satellite relative to the Moon at its time, drawn around the Moon now
    expect(b.trail.n).toBeGreaterThan(1);
    const last = b.trail.n - 1;
    const r = point(a.trail.pos.world, last); // default frame: the satellite itself
    expect(point(b.trail.pos.world, last)).toEqual(framePathPoint(r, moonPositionEci(NOW), moonPositionEci(NOW)));
    const first = point(b.trail.pos.world, 0), firstEarth = point(a.trail.pos.world, 0);
    const tFirst = NOW - (iss.render?.trailSeconds ?? 900) * 1000;
    expect(norm(sub(first, framePathPoint(firstEarth, moonPositionEci(tFirst), moonPositionEci(NOW))))).toBeLessThan(1e-6);
    expect(norm(sub(first, firstEarth))).toBeGreaterThan(100); // not the Earth-frame trail
  });

  it('rebuilds only when the period or the orbit frame changes, and follows a moving centre only for a body line', () => {
    const { overlay, update } = setup([iss]);
    update(iss);
    const w0 = point(peek(overlay).orbit.pos.world, 5);
    update(iss, NOW + 1000, false, bodyCentre('SUN')); // the frame changed: the line is not rebuilt (same primary)
    expect(point(peek(overlay).orbit.pos.world, 5)).toEqual(w0);
    expect(Array.from(peek(overlay).orbit.pos.shift)).toEqual([0, 0, 0]);
  });

  it('draws nothing for a satellite beyond the deep-space shell and after hide()', () => {
    const far: EntityRecord = { ...iss, id: 'far', provider: { type: 'sampled', frame: 'EARTH:inertial', samples: [[NOW - HOUR, 3e6, 0, 0, 0, 1, 0], [NOW + HOUR, 3e6, 3600, 0, 0, 1, 0]] } };
    const f = setup([far]);
    f.update(far);
    expect(f.overlay.hasOrbit).toBe(false);
    const { overlay, update } = setup([iss]);
    update(iss);
    expect(overlay.hasOrbit).toBe(true);
    overlay.hide();
    expect(overlay.hasOrbit).toBe(false);
  });
});

describe('EntityOverlay: a Moon orbiter', () => {
  it('is a closed ellipse round the Moon in every frame', () => {
    const lro = lroLike();
    for (const centre of [EARTH_CENTRE, bodyCentre('MOON'), bodyCentre('SUN')]) {
      const { overlay, update } = setup([lro]);
      update(lro, NOW, false, centre);
      expect(overlay.hasOrbit).toBe(true);
      const o = peek(overlay).orbit;
      // a point on the line is ~1837 km from the Moon's centre at the time it was built for (the Moon moves ~1 km/s)
      const c = moonPositionEci(NOW);
      expect(norm(sub(point(o.pos.world, 0), c))).toBeCloseTo(MOON.radiusKm + 100, -1);
      expect(norm(sub(point(o.pos.world, Math.floor(o.n / 4)), c))).toBeLessThan(2000);
      expect(Array.from(o.pos.shift)).toEqual([0, 0, 0]);
    }
  });
});

describe('EntityOverlay: body lines', () => {
  it('the Moon in both scales is the ellipse round the Earth', () => {
    const moon = body('body-moon');
    for (const scale of ['compressed', 'true'] as const) {
      const { overlay, update } = setup([moon]);
      update(moon, NOW, false, EARTH_CENTRE, scale);
      expect(overlay.hasOrbit).toBe(true);
      const o = peek(overlay).orbit;
      expect(drawn(overlay).count).toBe(o.n);
      for (let i = 0; i < o.n; i += 20) expect(norm(point(o.pos.world, i))).toBeGreaterThan(350_000);
      expect(norm(sub(point(o.pos.world, 0), moonPositionEci(NOW)))).toBeLessThan(1e-6);
    }
  });

  it('the Earth in the true scale is the real circle round the Sun through the Earth', () => {
    const earth = body('body-earth');
    const { overlay, update } = setup([earth]);
    update(earth, NOW, false, EARTH_CENTRE, 'true');
    expect(overlay.hasOrbit).toBe(true);
    const o = peek(overlay).orbit;
    const sun = bodyStateEci('SUN', NOW).r;
    const R = norm(sun);
    expect(R).toBeGreaterThan(1.4e8);
    for (let i = 0; i < o.n; i += 10) expect(norm(sub(point(o.pos.world, i), sun)) / R).toBeCloseTo(1, 1);
    expect(norm(point(o.pos.world, 0))).toBeLessThan(1e-3); // through the Earth (the origin)
  });

  it('the Earth in the compressed scale: radius = displayed Sun distance, through the displayed Earth', () => {
    const earth = body('body-earth');
    const { overlay, update } = setup([earth]);
    update(earth, NOW, false, EARTH_CENTRE, 'compressed');
    expect(overlay.hasOrbit).toBe(true);
    const o = peek(overlay).orbit;
    const sun = refDisplay('SUN', NOW, 'compressed');
    expect(sun.k).toBeLessThan(0.05);
    const D = norm(sun.r);
    expect(D).toBeGreaterThan(2.9e6);
    expect(D).toBeLessThan(3.1e6);
    // centred on the displayed Sun: every point is D from it (to the orbit's eccentricity, 1.7 %)
    for (let i = 0; i < o.n; i += 10) {
      const d = norm(sub(point(o.pos.world, i), sun.r));
      expect(Math.abs(d / D - 1)).toBeLessThan(0.03);
    }
    // and it passes through the origin, where the Earth is drawn
    expect(norm(point(o.pos.world, 0))).toBeLessThan(1e-3);
    expect(Array.from(o.pos.shift).every((x) => x === 0)).toBe(true);
    // nothing near the unscaled 1.5e8 km
    for (let i = 0; i < o.n; i++) expect(norm(point(o.pos.world, i))).toBeLessThan(2 * D * 1.05);
  });

  it('the compressed Earth line follows the displayed Sun as time passes, still through the Earth', () => {
    const earth = body('body-earth');
    const { overlay, update } = setup([earth]);
    update(earth, NOW, false, EARTH_CENTRE, 'compressed');
    const later = NOW + 2 * DAY;
    update(earth, later, false, EARTH_CENTRE, 'compressed'); // inside the rebuild interval (a 365 d period / 40): not rebuilt
    const o = peek(overlay).orbit;
    const sunNow = refDisplay('SUN', later, 'compressed');
    // the shifted line is centred on the displayed Sun of the later time to the Sun factor's change in two days (a few km)
    const centreErr = (i: number) => norm(sub(sub(point(o.pos.world, i), [-o.pos.shift[0], -o.pos.shift[1], -o.pos.shift[2]]), sunNow.r));
    const D = norm(sunNow.r);
    for (let i = 0; i < o.n; i += 20) expect(Math.abs(centreErr(i) / D - 1)).toBeLessThan(0.03);
    // the Earth's own position (the origin) is on the shifted line: the sample at `later` is in the loop (the Earth has moved on)
    let best = Infinity;
    for (let i = 0; i < o.n; i++) {
      const p = point(o.pos.world, i);
      best = Math.min(best, norm([p[0] + o.pos.shift[0], p[1] + o.pos.shift[1], p[2] + o.pos.shift[2]]));
    }
    expect(best).toBeLessThan((2 * Math.PI * D) / 240); // within one sample spacing of the origin
  });

  it('Mars has a line in the true scale only; switching scale rebuilds the Earth line', () => {
    const mars = body('body-mars');
    const m = setup([mars]);
    m.update(mars, NOW, false, EARTH_CENTRE, 'compressed');
    expect(m.overlay.hasOrbit).toBe(false);
    m.update(mars, NOW, false, EARTH_CENTRE, 'true');
    expect(m.overlay.hasOrbit).toBe(true);

    const earth = body('body-earth');
    const e = setup([earth]);
    e.update(earth, NOW, false, EARTH_CENTRE, 'true');
    const big = norm(sub(point(peek(e.overlay).orbit.pos.world, 60), [0, 0, 0]));
    e.update(earth, NOW, false, EARTH_CENTRE, 'compressed');
    const small = norm(point(peek(e.overlay).orbit.pos.world, 60));
    expect(big / small).toBeGreaterThan(30);
    e.update(earth, NOW, false, EARTH_CENTRE, 'true');
    expect(norm(point(peek(e.overlay).orbit.pos.world, 60))).toBeCloseTo(big, 0);
  });

  it('a body line has no trail', () => {
    const moon = body('body-moon');
    const { overlay, update } = setup([moon]);
    update(moon, NOW, true);
    expect(peek(overlay).trail.obj.visible).toBe(false);
  });
});

describe('EntityOverlay: a modeled launch orbit', () => {
  const { entities } = mockLaunches(NOW);
  const vehicle = entities.find((e) => e.id === 'launch-mock-m02')!;
  const payload = entities.find((e) => e.id === 'launch-mock-m01-payload')!;
  const net = NOW + 12 * MIN;
  const alts = (o: EntityOverlay): number[] => Array.from({ length: peek(o).orbit.n }, (_, i) => norm(point(peek(o).orbit.pos.world, i)) - EARTH.radiusKm);

  it('draws the closed orbit line of the payload and of the vehicle on orbit', () => {
    for (const [rec, t] of [[payload, NOW], [vehicle, net + HOUR]] as const) {
      const { overlay, update } = setup(entities);
      update(rec, t);
      expect(overlay.hasOrbit, rec.id).toBe(true);
      expect(peek(overlay).orbit.n, rec.id).toBeGreaterThan(200);
      for (const a of alts(overlay)) expect(a).toBeGreaterThan(100);
    }
  });

  it('stops the vehicle line where the modeled orbit ends instead of drawing a leg to the pad marker', () => {
    const orbitEnd = Math.max(...(vehicle.provider as { segments: { toMs: number; spec: { type: string } }[] }).segments.filter((s) => s.spec.type === 'keplerian').map((s) => s.toMs));
    const { overlay, update } = setup(entities);
    update(vehicle, orbitEnd - 10 * MIN); // the next 88 minutes reach past the end of the 12 h
    expect(overlay.hasOrbit).toBe(true);
    const a = alts(overlay);
    expect(a.length).toBeGreaterThan(2);
    expect(a.length).toBeLessThan(40); // about 10 of the 88 minutes
    for (const v of a) expect(v).toBeGreaterThan(100); // no point on the ground
  });
});
