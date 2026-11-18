import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { defaultBodies, bodyStateEci } from '@eio/core';
import {
  EARTH_BODY, MIN_ALT_KM, advanceSurfaceFrame, altitudeOf, basisFromUp, blendPosition, elevationAbout, ellipsoidUp, minElevation, moveOnSphere, surfaceRadius,
  type SurfaceBody, type V3,
} from '../src/lib/camera';
import {
  FLOOR_SAG_FACTOR, MIN_FLOOR_KM, altitudeFloorKm, groundPointWorld, hasSurface, surfaceBodyAt, worldToGround,
} from '../src/lib/surface-body';
import { bodyAxes } from '../src/lib/traverse';
import { OrbitRig } from '../src/scene/controls';

const T0 = Date.UTC(2026, 5, 1, 12);
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: V3): V3 => a.map((x) => x / len(a)) as V3;
const norm = (a: V3): V3 => unit(a);

/** a made-up body: far from the origin, a tilted pole, a sphere of 1737.4 km (the Moon's size) */
const POLE = norm([0.3, -0.5, 0.8]);
const BODY: SurfaceBody = { c: [3.8e5, -1.2e5, 4.4e4], radiusKm: 1737.4, flattening: 0, pole: POLE, floorKm: 2.1 };

/** point at latitude/longitude on a body (prime meridian toward +X projected on the equator), with its own east/north/up */
function onBody(latDeg: number, lonDeg: number, alt: number, b: SurfaceBody = BODY): { p: V3; e: V3; n: V3; u: V3 } {
  const north = b.pole;
  const px = unit([1 - north[0] * north[0], -north[0] * north[1], -north[0] * north[2]] as V3);
  const py: V3 = [north[1] * px[2] - north[2] * px[1], north[2] * px[0] - north[0] * px[2], north[0] * px[1] - north[1] * px[0]];
  const la = (latDeg * Math.PI) / 180, lo = (lonDeg * Math.PI) / 180;
  const u: V3 = [0, 1, 2].map((i) => Math.cos(la) * (Math.cos(lo) * px[i] + Math.sin(lo) * py[i]) + Math.sin(la) * north[i]) as V3;
  const e: V3 = [0, 1, 2].map((i) => -Math.sin(lo) * px[i] + Math.cos(lo) * py[i]) as V3;
  const n: V3 = [0, 1, 2].map((i) => -Math.sin(la) * (Math.cos(lo) * px[i] + Math.sin(lo) * py[i]) + Math.cos(la) * north[i]) as V3;
  const r = b.radiusKm + alt;
  return { p: [b.c[0] + u[0] * r, b.c[1] + u[1] * r, b.c[2] + u[2] * r], e, n, u };
}

describe('the ground of any body: vertical, altitude, north', () => {
  it('the local vertical of a point is its direction from the body centre, whatever the pole and the centre', () => {
    for (const [la, lo] of [[0, 0], [37, 121], [-62, -170], [89.9, 20]]) {
      const s = onBody(la, lo, 150);
      expect(dot(ellipsoidUp(s.p, BODY), s.u)).toBeGreaterThan(1 - 1e-12);
      expect(altitudeOf(s.p, BODY)).toBeCloseTo(150, 6);
      expect(surfaceRadius(s.p, BODY)).toBeCloseTo(1737.4, 9);
    }
  });

  it('the north-up basis has north toward the body pole and east perpendicular to both, east-pointing', () => {
    for (const [la, lo] of [[10, 0], [-45, 80], [70, -120]]) {
      const s = onBody(la, lo, 20);
      const b = basisFromUp(ellipsoidUp(s.p, BODY), BODY.pole);
      expect(dot(b.e, s.e)).toBeGreaterThan(1 - 1e-12);
      expect(dot(b.n, s.n)).toBeGreaterThan(1 - 1e-12);
      expect(dot(b.n, BODY.pole)).toBeGreaterThan(0);
      expect(Math.abs(dot(b.e, BODY.pole))).toBeLessThan(1e-12);
    }
  });

  it('a pole direction keeps a valid orthonormal basis (east is arbitrary there)', () => {
    const b = basisFromUp(BODY.pole, BODY.pole);
    expect(len(b.e)).toBeCloseTo(1, 12);
    expect(Math.abs(dot(b.e, b.u))).toBeLessThan(1e-12);
    expect(Math.abs(dot(b.n, b.u))).toBeLessThan(1e-12);
    // the Earth's own default stays the old one: pole +Z, east +Y at the pole
    expect(basisFromUp([0, 0, 1]).e).toEqual([0, 1, 0]);
  });

  it('a flattened body: the vertical is the ellipsoid normal about ITS pole, not +Z', () => {
    const oblate: SurfaceBody = { ...BODY, flattening: 0.1 };
    const s = onBody(45, 30, 0, { ...oblate, radiusKm: 1000 });
    const up = ellipsoidUp(s.p, oblate);
    // the geodetic latitude of an oblate body is above its geocentric one: the normal leans toward the pole
    expect(dot(up, oblate.pole)).toBeGreaterThan(dot(unit(sub(s.p, oblate.c)), oblate.pole));
    // and with no flattening the radial direction is the vertical
    expect(dot(ellipsoidUp(s.p, BODY), unit(sub(s.p, BODY.c)))).toBeGreaterThan(1 - 1e-12);
  });

  it('the Earth default is unchanged: centre at the origin, pole +Z, the 3 km floor', () => {
    expect(EARTH_BODY).toMatchObject({ c: [0, 0, 0], pole: [0, 0, 1], floorKm: MIN_ALT_KM });
    expect(ellipsoidUp([0, 0, 7000])).toEqual(ellipsoidUp([0, 0, 7000], EARTH_BODY));
  });
});

describe('surface frame about an arbitrary pole', () => {
  it('walking a great circle through the pole turns the frame by less than the walk, never spinning', () => {
    let f = advanceSurfaceFrame(null, onBody(80, 0, 0).u, POLE);
    let worst = 0;
    // 10-degree-per-step walk over the pole along one meridian, then down the other side
    for (let lat = 80; lat < 270; lat += 2) {
      const over = lat > 90 ? 180 - lat : lat;
      const lon = lat > 90 ? 180 : 0;
      const next = advanceSurfaceFrame(f, onBody(over, lon, 0).u, POLE);
      worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, dot(f.e, next.e)))));
      f = next;
    }
    expect(worst).toBeLessThan(0.2);
  });

  it('starts north-up: its north is toward the pole', () => {
    const f = advanceSurfaceFrame(null, onBody(30, 40, 0).u, POLE);
    expect(dot(f.n, POLE)).toBeGreaterThan(0);
    expect(f.psi).toBe(0);
  });
});

describe('moving on a body that is not at the origin', () => {
  it('a pan along the ground keeps the radius about the body centre and is translation invariant', () => {
    const s = onBody(20, 10, 0);
    const moved = moveOnSphere(s.p, [s.e[0] * 300, s.e[1] * 300, s.e[2] * 300], BODY.c);
    expect(len(sub(moved, BODY.c))).toBeCloseTo(1737.4, 6);
    const at0 = onBody(20, 10, 0, { ...BODY, c: [0, 0, 0] });
    const m0 = moveOnSphere(at0.p, [at0.e[0] * 300, at0.e[1] * 300, at0.e[2] * 300]);
    expect(sub(moved, BODY.c).map((x, i) => x - m0[i])).toSatisfy((d: number[]) => len(d as V3) < 1e-6);
    // 300 km on a 1737.4 km sphere is 300 / 1737.4 rad of arc
    expect(Math.acos(dot(unit(sub(moved, BODY.c)), s.u))).toBeCloseTo(300 / 1737.4, 9);
  });

  it('a zero move returns the point', () => {
    const s = onBody(0, 0, 0);
    expect(moveOnSphere(s.p, [0, 0, 0], BODY.c)).toEqual(s.p);
  });
});

describe('altitude floor of a body', () => {
  it('is the Earth 3 km, and for every other body 4 times the sag of its 128 x 64 sphere, with a 10 m lower bound', () => {
    expect(altitudeFloorKm('EARTH', 6378.137)).toBe(MIN_ALT_KM);
    const sag = (r: number) => r * (1 - Math.cos(Math.PI / 128));
    expect(altitudeFloorKm('MOON', 1737.4)).toBeCloseTo(FLOOR_SAG_FACTOR * sag(1737.4), 12);
    expect(altitudeFloorKm('MOON', 1737.4)).toBeCloseTo(2.09, 2);
    expect(altitudeFloorKm('MARS', 3396.19)).toBeCloseTo(4.09, 2);
    expect(altitudeFloorKm('X', 1)).toBe(MIN_FLOOR_KM);
  });

  it('is above the facet sag of the mesh it stands over, and scales with the body', () => {
    for (const b of defaultBodies.all()) {
      if (!hasSurface(b.id) || b.id === 'EARTH') continue;
      const f = altitudeFloorKm(b.id, b.radiusKm);
      expect(f).toBeGreaterThanOrEqual(b.radiusKm * (1 - Math.cos(Math.PI / 128)));
      expect(f).toBeGreaterThanOrEqual(MIN_FLOOR_KM);
    }
    expect(altitudeFloorKm('MARS', 3396.19)).toBeGreaterThan(altitudeFloorKm('MOON', 1737.4));
  });

  it('the elevation limit follows the floor: a ground target needs a camera above the horizon, a high one may go lower', () => {
    expect(minElevation(100, 2.1, 0)).toBeCloseTo(Math.asin(2.1 / 100), 12);
    expect(minElevation(100, 2.1, 50)).toBeLessThan(0);
  });
});

describe('which bodies have a ground, and where it is', () => {
  it('every registry body with a radius but the Sun', () => {
    expect(hasSurface('SUN')).toBe(false);
    for (const id of ['EARTH', 'MOON', 'MARS', 'JUPITER', 'TITAN', 'CERES']) expect(hasSurface(id), id).toBe(true);
    expect(hasSurface('NOPE')).toBe(false);
    for (const b of defaultBodies.all()) expect(hasSurface(b.id)).toBe(b.id !== 'SUN' && b.radiusKm > 0);
  });

  it('Mars: its centre is the body state, its pole the IAU pole (within the precession), radius the sphere of the registry', () => {
    const g = surfaceBodyAt('MARS', T0)!;
    const c = bodyStateEci('MARS', T0).r;
    expect(len(sub(g.c, c as V3))).toBeLessThan(1e-3);
    expect(g.radiusKm).toBeCloseTo(3396.19, 6);
    expect(g.flattening).toBe(0);
    expect(len(g.pole)).toBeCloseTo(1, 9);
    expect(g.floorKm).toBeCloseTo(altitudeFloorKm('MARS', 3396.19), 12);
  });

  it('the Moon, with its own pole (not the Earth\'s +Z) and a float64 centre that is the Moon\'s geocentric position', () => {
    const g = surfaceBodyAt('MOON', T0)!;
    expect(len(g.c)).toBeGreaterThan(356_000);
    expect(len(g.c)).toBeLessThan(407_000);
    expect(len(g.pole)).toBeCloseTo(1, 9);
    expect(dot(g.pole, [0, 0, 1])).toBeLessThan(0.9999); // tilted from the Earth's axis
  });

  it('a body whose pole is not in the registry (NO_ROTATION) keeps the neutral pole, finite and unit', () => {
    const noRot = defaultBodies.all().find((b) => b.id !== 'SUN' && b.rotation.kind === 'linear' && b.rotation.rateDegPerDay === 0 && b.rotation.poleDecDeg === 90 && bodyAxes(b.id, T0));
    expect(noRot).toBeDefined();
    const g = surfaceBodyAt(noRot!.id, T0)!;
    expect(Number.isFinite(g.pole[0] + g.pole[1] + g.pole[2])).toBe(true);
    expect(len(g.pole)).toBeCloseTo(1, 9);
    expect(g.pole[2]).toBeGreaterThan(0.99); // the scene's +Z up to the J2000-to-date precession
  });

  it('the Sun and the Earth: no ground, and the fixed Earth ground', () => {
    expect(surfaceBodyAt('SUN', T0)).toBeNull();
    expect(surfaceBodyAt('EARTH', T0)).toBe(EARTH_BODY);
  });

  it('a latitude and longitude on Mars place a point on its sphere, turn with the planet and read back', () => {
    const a = bodyAxes('MARS', T0)!;
    const w = groundPointWorld('MARS', a, 0.3, 1.1, 5);
    expect(len(sub(w, a.o as V3))).toBeCloseTo(3396.19 + 5, 6);
    const back = worldToGround('MARS', a, w);
    expect(back.lat).toBeCloseTo(0.3, 9);
    expect(back.lon).toBeCloseTo(1.1, 9);
    expect(back.alt).toBeCloseTo(5, 6);
    // 6 hours later the same site has turned about the pole by about 87.6 degrees (Mars rotates 350.892 degrees a day)
    const a2 = bodyAxes('MARS', T0 + 6 * 3600e3)!;
    const w2 = groundPointWorld('MARS', a2, 0.3, 1.1, 5);
    const g = surfaceBodyAt('MARS', T0)!;
    const h = (p: V3, o: V3) => {
      const r = sub(p, o), k = dot(r, g.pole);
      return unit([r[0] - k * g.pole[0], r[1] - k * g.pole[1], r[2] - k * g.pole[2]]);
    };
    const turn = (Math.acos(dot(h(w, a.o as V3), h(w2, a2.o as V3))) * 180) / Math.PI;
    expect(turn).toBeGreaterThan(80);
    expect(turn).toBeLessThan(95);
  });
});

describe('the blend round a body that is not the Earth', () => {
  const alt = (p: V3) => altitudeOf(p, BODY);
  const start = onBody(10, 20, 8000).p; // 8,000 km up, over the 10 degrees north
  const end = onBody(-35, 150, 30).p; // 30 km up, far round the body

  it('is exactly the ends at 0 and 1', () => {
    expect(blendPosition(start, end, 0, BODY.floorKm, undefined, BODY)).toEqual(start);
    expect(blendPosition(start, end, 1, BODY.floorKm, undefined, BODY)).toEqual(end);
  });

  it('goes round the body on the great circle between the ends (slerp about its centre), height steady in the log', () => {
    const k = 0.37;
    const p = blendPosition(start, end, k, BODY.floorKm, undefined, BODY);
    const d = unit(sub(p, BODY.c));
    const a = unit(sub(start, BODY.c)), b = unit(sub(end, BODY.c));
    // on the plane of the two directions
    const nrm = unit([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
    expect(Math.abs(dot(d, nrm))).toBeLessThan(1e-9);
    // the angle covered is k of the whole
    const whole = Math.acos(dot(a, b));
    expect(Math.acos(dot(a, d))).toBeCloseTo(whole * k, 6);
    // log-linear height
    expect(Math.log(alt(p))).toBeCloseTo(Math.log(8000) + (Math.log(30) - Math.log(8000)) * k, 6);
  });

  it('never goes below the body\'s floor, even when both ends are on the ground', () => {
    const a = onBody(0, 0, 0).p, b = onBody(0, 179, 0).p;
    for (let k = 0.01; k < 1; k += 0.01) expect(alt(blendPosition(a, b, k, BODY.floorKm, undefined, BODY))).toBeGreaterThanOrEqual(BODY.floorKm - 1e-9);
  });

  it('with an aim point never dips below the horizon of the lower end, as seen from the aim', () => {
    const t = onBody(-35, 150, 0).p;
    const floor = Math.min(elevationAbout(start, t, BODY), elevationAbout(end, t, BODY));
    for (let k = 0.02; k < 1; k += 0.02) {
      const p = blendPosition(start, end, k, BODY.floorKm, t, BODY);
      expect(elevationAbout(p, t, BODY)).toBeGreaterThanOrEqual(floor - 1e-9);
      expect(alt(p)).toBeGreaterThan(BODY.floorKm - 1e-9);
    }
  });

  it('the Earth path is what it was: no body argument, same result as the Earth body', () => {
    const a: V3 = [7000, 100, 200], b: V3 = [-3000, 6000, 1000];
    expect(blendPosition(a, b, 0.4)).toEqual(blendPosition(a, b, 0.4, MIN_ALT_KM, undefined, EARTH_BODY));
  });
});

// ------------------------------------------------------------------------------------------------ the rig on another body

const fakeDom = () => {
  const noop = () => undefined;
  return { style: {}, addEventListener: noop, removeEventListener: noop, setPointerCapture: noop, clientHeight: 500 } as unknown as HTMLElement;
};
let clock = 0;
vi.spyOn(performance, 'now').mockImplementation(() => clock);
afterEach(() => { clock = 0; });
const vec = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);

describe('OrbitRig in the surface view of another body', () => {
  const setup = () => {
    const cam = new THREE.PerspectiveCamera(45, 1.6, 0.1, 1e12);
    const rig = new OrbitRig(cam, fakeDom());
    rig.surfaceBody = BODY;
    rig.minDist = 0.2;
    return { cam, rig };
  };

  it('the horizon is level (camera up is the local vertical), the view north-up, and the camera stays above the floor', () => {
    const { cam, rig } = setup();
    rig.mode = 'surface';
    rig.az = -Math.PI / 2;
    rig.el = 0.35;
    rig.dist = 40;
    for (const lon of [60, 61, 62]) {
      const s = onBody(25, lon, 0);
      rig.update(vec(s.p), new THREE.Vector3(), 0);
      expect(cam.up.dot(vec(s.u))).toBeGreaterThan(1 - 1e-9);
      const fwd = cam.getWorldDirection(new THREE.Vector3());
      expect(fwd.dot(vec(s.n))).toBeGreaterThan(0.9); // looking north (toward the body's pole), not toward the Earth's +Z
      expect(altitudeOf([cam.position.x, cam.position.y, cam.position.z], BODY)).toBeGreaterThanOrEqual(BODY.floorKm - 1e-9);
    }
  });

  it('tilting the camera down never takes it under the floor (the body\'s, not the Earth\'s 3 km)', () => {
    const { cam, rig } = setup();
    const s = onBody(-10, 200, 0);
    rig.mode = 'surface';
    rig.az = -Math.PI / 2;
    rig.dist = 8;
    for (const el of [-1.4, -0.5, 0, 0.01]) {
      rig.el = el;
      rig.update(vec(s.p), new THREE.Vector3(), 0);
      expect(altitudeOf([cam.position.x, cam.position.y, cam.position.z], BODY)).toBeGreaterThanOrEqual(BODY.floorKm - 1e-9);
    }
    // and at 2.5 km it is allowed (it would have been lifted to the Earth's 3 km before)
    rig.el = 0.31;
    rig.dist = 8;
    rig.update(vec(s.p), new THREE.Vector3(), 0);
    expect(rig.altitudeKm).toBeGreaterThanOrEqual(BODY.floorKm - 1e-9);
  });

  it('enters and leaves with a blend that aims at the target and stays above the ground, round the same body', () => {
    const { cam, rig } = setup();
    const obj = onBody(5, 100, 60).p;
    rig.mode = 'globe';
    rig.dist = 9000;
    rig.az = 0.6;
    rig.el = 0.4;
    rig.update(vec(obj), new THREE.Vector3(), 0);
    clock = 1000;
    rig.switchMode('surface', 1500);
    rig.az = -Math.PI / 2;
    rig.el = 0.35;
    rig.dist = 300;
    for (let t = 0; t <= 1600; t += 1000 / 60) {
      rig.update(vec(obj), new THREE.Vector3(), 1000 + t);
      const fwd = cam.getWorldDirection(new THREE.Vector3());
      const to = vec(obj).sub(cam.position).normalize();
      expect(Math.acos(Math.max(-1, Math.min(1, fwd.dot(to))))).toBeLessThan(1e-6);
      expect(altitudeOf([cam.position.x, cam.position.y, cam.position.z], BODY)).toBeGreaterThanOrEqual(BODY.floorKm - 1e-6);
    }
    clock = 5000;
    rig.switchMode('globe', 1500);
    rig.az = 0.5;
    rig.el = 0.3;
    rig.dist = 5000;
    for (let t = 0; t <= 1600; t += 1000 / 60) {
      rig.update(vec(obj), new THREE.Vector3(), 5000 + t);
      expect(altitudeOf([cam.position.x, cam.position.y, cam.position.z], BODY)).toBeGreaterThanOrEqual(BODY.floorKm - 1e-6);
    }
  });

  it('the ground pan callback gets the body\'s own east and north', () => {
    const { rig } = setup();
    const s = onBody(0, 0, 0);
    rig.mode = 'surface';
    rig.az = -Math.PI / 2;
    rig.el = 0.35;
    rig.dist = 100;
    rig.update(vec(s.p), new THREE.Vector3(), 0);
    expect(rig.frame).not.toBeNull();
    expect(dot(rig.frame!.n as V3, POLE)).toBeGreaterThan(0);
    expect(dot(rig.frame!.u as V3, s.u)).toBeGreaterThan(1 - 1e-12);
  });
});
