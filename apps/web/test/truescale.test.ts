import { describe, expect, it } from 'vitest';
import { DEG, EARTH, EntityGraph, bodyEntityRecords, norm, type EntityRecord, type Sample, type Vec3 } from '@eio/core';
import { MAX_DIST_KM, fitDistance, fitDistanceClamped, settleDistance, zoomDistance, boundingSphere } from '../src/lib/camera';
import { OCCLUSION_MARGIN_KM } from '../src/lib/occlusion';
import { liftNearSurface, makePathBuffers, nowIndex, planPathWindow, samplePath } from '../src/lib/paths';
import { NEAR_EARTH_LIMIT_KM, refDisplay, refPositionEci, refRadiusKm, refViewDistKm } from '../src/lib/ref-body';
import { toCameraRelative, spinOf } from '../src/lib/floating-origin';
import { inScope, scopeRadius } from '../src/lib/scope';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const DAY = 86_400_000, MIN = 60_000;
const RE = EARTH.radiusKm;
const VGR: Vec3 = [-1.0e10, 2.2e10, 0.6e10];

describe('display positions are true positions', () => {
  it('the ground nudge leaves far objects exactly where they are', () => {
    expect(liftNearSurface(VGR)).toEqual(VGR);
    for (const r of [[RE + 400, 0, 0], [0, 4.2e4, 0], [3.8e5, 1e5, 0], [1.9e6, 0, 0], [3e6, 0, 0]] as Vec3[]) {
      expect(liftNearSurface(r)).toEqual(r);
    }
  });

  it('bodies are drawn where they are: the Sun at 1 AU, Mars at its real distance, the Moon at 384,400 km', () => {
    const sun = refDisplay('SUN', NOW), mars = refDisplay('MARS', NOW), moon = refDisplay('MOON', NOW);
    expect(norm(sun.r)).toBeGreaterThan(1.45e8);
    expect(norm(sun.r)).toBeLessThan(1.55e8);
    expect(norm(mars.r)).toBeGreaterThan(5e7); // closest approach to the Earth
    expect(norm(mars.r)).toBeLessThan(4.1e8);
    expect(norm(moon.r)).toBeGreaterThan(3.5e5);
    expect(norm(moon.r)).toBeLessThan(4.1e5);
    for (const d of [sun, mars, moon]) expect(d.k).toBe(1);
    expect(sun.r).toEqual(refPositionEci('SUN', NOW));
  });
});

describe('paths at true scale', () => {
  const samples: Sample[] = [];
  const dir = VGR.map((c) => c / norm(VGR)) as Vec3;
  for (let t = NOW - DAY; t <= NOW + 2 * DAY; t += 30 * MIN) samples.push([t, ...(dir.map((c) => c * (2.5e10 + 17 * ((t - NOW) / 1000))) as Vec3)]);
  const rec: EntityRecord = {
    id: 'dsn-VGR1', name: 'Voyager 1', kind: 'probe', bodyId: 'EARTH', aliases: {},
    provider: { type: 'sampled', frame: 'EARTH:inertial', samples }, updatedAt: NOW,
  };
  const graph = new EntityGraph();
  graph.upsert(rec);
  const plan = planPathWindow(rec.provider, NOW)!;

  it('draws the path at the real distance', () => {
    const buf = makePathBuffers();
    const res = samplePath(graph, rec.id, plan, rec.provider, buf);
    expect(res.count).toBeGreaterThan(100);
    for (let k = 0; k < res.count; k++) {
      const r = Math.hypot(buf.pos[k * 3], buf.pos[k * 3 + 1], buf.pos[k * 3 + 2]);
      expect(r).toBeGreaterThan(2.4e10);
      expect(r).toBeLessThan(2.6e10);
    }
  });

  it('matches the marker (same display position at "now") and spans the real 3-day travel', () => {
    const buf = makePathBuffers();
    const res = samplePath(graph, rec.id, plan, rec.provider, buf);
    const marker = liftNearSurface(graph.stateIn(rec.id, NOW, 'EARTH:inertial')!.r);
    const i = nowIndex(buf.times, res.count, NOW);
    expect(Math.hypot(buf.pos[i * 3] - marker[0], buf.pos[i * 3 + 1] - marker[1], buf.pos[i * 3 + 2] - marker[2])).toBeLessThan(2.5e5);
    const first = [buf.pos[0], buf.pos[1], buf.pos[2]], last = [buf.pos[(res.count - 1) * 3], buf.pos[(res.count - 1) * 3 + 1], buf.pos[(res.count - 1) * 3 + 2]];
    const span = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]);
    expect(span).toBeGreaterThan(17 * 3 * 86400 * 0.95); // 17 km/s over ~3 days
    expect(span).toBeLessThan(17 * 3 * 86400 * 1.05);
    expect(res.moving).toBe(true);
  });
});

describe('Mars and its orbiters are drawn in one frame at one scale', () => {
  // A probe in a circular polar orbit about Mars (a keplerian provider with bodyId MARS: the state is MARS:inertial, the graph
  // re-expresses it in EARTH:inertial like any entity). Mars is drawn at refDisplay('MARS'); the probe at its Earth-inertial
  // state through liftNearSurface, both unscaled. Before the compressed scale was removed they were each moved onto the shell by
  // their own, different, geocentric distance, so a probe 3,800 km from Mars was drawn thousands of km (or millions) away from it.
  const orbit = { a: 3800, e: 0, i: 90 * DEG, raan: 0, argp: 0, m0: 0, epochMs: NOW };
  const probe: EntityRecord = {
    id: 'mars-orbiter', name: 'Mars orbiter', kind: 'probe', bodyId: 'MARS', aliases: {},
    provider: { type: 'keplerian', bodyId: 'MARS', elements: orbit }, updatedAt: NOW,
  };
  const graph = new EntityGraph();
  for (const b of bodyEntityRecords()) graph.upsert(b);
  graph.upsert(probe);

  it('stays within its orbit radius of the displayed Mars at several times over a day and across months', () => {
    for (const dt of [0, 17 * MIN, 61 * MIN, 5 * 3600_000, DAY, 40 * DAY, 200 * DAY]) {
      const t = NOW + dt;
      const mars = refDisplay('MARS', t).r;
      const s = graph.stateIn(probe.id, t, 'EARTH:inertial')!;
      const d = norm([s.r[0] - mars[0], s.r[1] - mars[1], s.r[2] - mars[2]]);
      expect(Math.abs(d - orbit.a), `at +${dt / MIN} min`).toBeLessThan(5); // a few km: float64 round-off of 2e8 km coordinates is 1e-8 km
      const drawn = liftNearSurface(s.r);
      expect(norm([drawn[0] - mars[0], drawn[1] - mars[1], drawn[2] - mars[2]])).toBeCloseTo(d, 6);
    }
  });

  it('the orbiter is inside the displayed Mars view (camera at refViewDistKm) and outside the Mars sphere', () => {
    const mars = refDisplay('MARS', NOW).r;
    const s = graph.stateIn(probe.id, NOW, 'EARTH:inertial')!;
    const rel = norm([s.r[0] - mars[0], s.r[1] - mars[1], s.r[2] - mars[2]]);
    expect(rel).toBeGreaterThan(refRadiusKm('MARS'));
    expect(rel).toBeLessThan(refViewDistKm('MARS'));
  });
});

describe('the point shader Earth test with the camera 1.5e8 km out (the Sun frame)', () => {
  // scene/materials.ts earthHides, written with float32 rounding at every step. The camera is 1.5e8 km from the Earth: the old
  // `b * b - c2` form lost every digit there (b^2 ~ 2e16, the Earth's R^2 ~ 4e7), the miss distance |cross(u, o)| does not.
  const f = Math.fround;
  const R = EARTH.radiusKm - OCCLUSION_MARGIN_KM;
  function hides(o: Vec3, rel: Vec3, c2: number): boolean {
    const L = f(Math.hypot(f(rel[0]), f(rel[1]), f(rel[2])));
    const u: Vec3 = [f(rel[0] / L), f(rel[1] / L), f(rel[2] / L)];
    const b = f(f(f(o[0] * u[0]) + f(o[1] * u[1])) + f(o[2] * u[2]));
    if (b >= 0) return false;
    const cx = f(f(o[1] * u[2]) - f(o[2] * u[1])), cy = f(f(o[2] * u[0]) - f(o[0] * u[2])), cz = f(f(o[0] * u[1]) - f(o[1] * u[0]));
    const p = f(Math.hypot(cx, cy, cz));
    if (p >= R) return false;
    return f(c2 / f(-b + f(Math.sqrt(f(f(R - p) * f(R + p)))))) < L;
  }

  it('hides a point behind the Earth and keeps one beside it, for a camera at 1 AU in any direction', () => {
    for (const dir of [[1, 0, 0], [0, 1, 0], [0.6, 0.64, 0.48], [-0.3, 0.1, 0.9486832980505138]] as Vec3[]) {
      const u = dir.map((c) => c / norm(dir)) as Vec3;
      const o = u.map((c) => f(c * 1.4959787e8)) as Vec3; // the camera, float32 like the uniform
      const c2 = f(o[0] ** 2 + o[1] ** 2 + o[2] ** 2 - R * R); // float64 on the CPU, then rounded to the uniform
      // a unit vector across the line of sight
      const a: Vec3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const k = a[0] * u[0] + a[1] * u[1] + a[2] * u[2];
      const s = [a[0] - k * u[0], a[1] - k * u[1], a[2] - k * u[2]];
      const sn = norm(s as Vec3);
      for (const [lateral, expected] of [[0, true], [3000, true], [5000, true], [8000, false], [12000, false], [40000, false]] as const) {
        // the point is 7,000 km behind the Earth's centre as seen from the camera, `lateral` km off the line of sight
        const P = [0, 1, 2].map((i) => -u[i] * 7000 + (s[i] / sn) * lateral);
        const rel = [0, 1, 2].map((i) => P[i] - o[i]) as Vec3; // camera-relative, float64 then rounded by hides()
        expect(hides(o, rel, c2), `${dir} lateral ${lateral}`).toBe(expected);
      }
    }
  });
});

describe('camera limits at true scale', () => {
  it('the zoom-out limit is 1e11 km, far past Voyager 1 (2.5e10 km)', () => {
    expect(MAX_DIST_KM).toBe(1e11);
    expect(MAX_DIST_KM).toBeGreaterThan(3e10);
  });

  it('wheel zoom around a probe 2.5e10 km out steps in proportion to the distance to it, up to the limit', () => {
    const alt = 2.5e10; // height above the Earth: huge, so the step falls back to the target distance
    const opts = { minDist: 0.2, maxDist: MAX_DIST_KM };
    const d = zoomDistance(1e9, 0.9, alt, opts);
    expect(d).toBeCloseTo(0.9e9, -3);
    expect(zoomDistance(9e10, 2, alt, opts)).toBe(MAX_DIST_KM);
    // and the near clamp is unchanged
    expect(zoomDistance(0.25, 0.1, alt, opts)).toBe(0.2);
  });

  it('FIT of everything out to Voyager (2.5e10 km) gets a distance that fits and is within the limit', () => {
    const pts = [0, 0, 0, ...VGR];
    const { r } = boundingSphere(pts);
    const dist = fitDistanceClamped(r, 45, 1.3, 1.3, 0.2);
    expect(dist).toBeGreaterThan(fitDistance(r, 45, 1.3, 1) * 0.99);
    expect(dist).toBeLessThanOrEqual(MAX_DIST_KM);
    expect(dist).toBeGreaterThan(3e7);
    // a request beyond the limit is capped
    expect(fitDistanceClamped(1e12, 45, 1.3, 1.3, 0.2)).toBe(MAX_DIST_KM);
    // a tiny set keeps the minimum
    expect(fitDistanceClamped(0, 45, 1.3, 1.3, 0.2)).toBe(0.2);
  });

  it('a fly-to for a probe at true distance settles at a distance within the zoom limit', () => {
    expect(settleDistance(2.5e10)).toBeLessThan(MAX_DIST_KM);
    expect(settleDistance(2.5e10)).toBeCloseTo(2.5e10 * 0.45, 0);
    expect(settleDistance(7000)).toBe(3200);
    expect(settleDistance(1e6)).toBeCloseTo(6e5, 3);
  });
});

describe('precision far from the origin', () => {
  it('rebasing keeps ~metre accuracy for points 1,000 km from a camera parked at Voyager', () => {
    const origin: [number, number, number] = [-1.0e10 + 0.123456789, 2.2e10 - 0.987654321, 0.6e10];
    const world = new Float64Array([origin[0] + 1000.25, origin[1] - 333.5, origin[2] + 5]);
    const out = new Float32Array(3);
    toCameraRelative(world, out, 1, origin, spinOf(0), false);
    expect(out[0]).toBeCloseTo(1000.25, 3);
    expect(out[1]).toBeCloseTo(-333.5, 3);
    expect(out[2]).toBeCloseTo(5, 3);
    // a float32 world position at this distance is ~1,000 km coarse
    let worst = 0;
    for (let i = 0; i < 50; i++) worst = Math.max(worst, Math.abs(Math.fround(origin[0] + i * 37.3) - (origin[0] + i * 37.3)));
    expect(worst).toBeGreaterThan(100);
  });
});

describe('scope and true scale', () => {
  it('a camera pulled back far enough to see a probe at true scale keeps it in scope', () => {
    expect(inScope({ d: 2.5e10, key: 0, bulk: false, keep: false }, scopeRadius(1.1e10))).toBe(true);
    expect(inScope({ d: 2.5e10, key: 0, bulk: false, keep: false }, scopeRadius(24_000))).toBe(false);
    expect(NEAR_EARTH_LIMIT_KM).toBe(2e6);
  });
});

describe('default view distances of the bodies', () => {
  // a view of the whole body: the Moon, Mars and the Sun are 4 radii away, so each shows as a disc of a quarter of the view
  // height or more (fov 45 degrees: a sphere of radius R at 4R spans 2 * asin(1/4) = 29 degrees)
  it('selecting a body frames it as a clear disc, and the Sun view still reaches the Earth by zooming out', () => {
    const fov = 45;
    for (const body of ['SUN', 'MARS', 'MOON'] as const) {
      const dist = refViewDistKm(body);
      const radius = { SUN: 696_000, MARS: 3_389.5, MOON: 1_737.4 }[body];
      expect(dist).toBeGreaterThan(radius * 3.9);
      const discPx = (900 / 2) * (Math.tan(Math.asin(radius / dist)) / Math.tan((fov / 2) * (Math.PI / 180)));
      expect(discPx).toBeGreaterThan(30);
    }
    expect(refViewDistKm('SUN')).toBeLessThan(1.5e8);
    expect(MAX_DIST_KM).toBeGreaterThan(1.5e8 * 100);
  });
});
