import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { OrbitRig } from '../src/scene/controls';
import { MIN_ALT_KM, altitudeOf, basisFromUp, ellipsoidUp, surfaceRadius, type V3 } from '../src/lib/camera';
import { FP_EYE_KM, FP_FOV_MAX, FP_FOV_MIN, FP_LOOK_KM, firstPersonEye, firstPersonLookDir } from '../src/lib/first-person';

type Handler = (e: Record<string, unknown>) => void;

/** A DOM stand-in that keeps the rig's listeners so the test can send it pointer and wheel events. */
const fakeDom = () => {
  const handlers = new Map<string, Handler>();
  const dom = {
    style: {}, clientHeight: 600, setPointerCapture: () => undefined, removeEventListener: () => undefined,
    addEventListener: (type: string, h: Handler) => handlers.set(type, h),
  } as unknown as HTMLElement;
  const fire = (type: string, e: Record<string, unknown>) => handlers.get(type)?.({ preventDefault: () => undefined, ...e });
  return { dom, fire };
};
const at = (lat: number, lon: number, alt: number): V3 => {
  const d: V3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const r = surfaceRadius(d) + alt;
  return [d[0] * r, d[1] * r, d[2] * r];
};
const vec = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);
const DUR = 1500;
const DEG = Math.PI / 180;

let clock = 0;
vi.spyOn(performance, 'now').mockImplementation(() => clock);
afterEach(() => { clock = 0; });

/** A rig that has drawn a globe view, then switched into the first-person mode at `site` and finished the transition. */
function standAt(site: V3, az = 0, el = 0.26) {
  const { dom, fire } = fakeDom();
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.005, 1e12);
  const rig = new OrbitRig(cam, dom);
  rig.dist = 24000;
  rig.minDist = 1;
  rig.update(null, new THREE.Vector3(), 0);
  const start = cam.position.clone();
  clock = 1000;
  rig.switchMode('firstPerson', DUR);
  rig.az = az;
  rig.el = el;
  const anchor = vec(site);
  rig.update(anchor, new THREE.Vector3(), 1000);
  return { cam, rig, anchor, fire, start, finish: () => rig.update(anchor, new THREE.Vector3(), 1000 + DUR) };
}

describe('OrbitRig first-person mode', () => {
  it('puts the camera at the eye and looks along the local az / el with a level horizon', () => {
    for (const site of [at(0.3459, -2.7134, 4.205), at(-0.43, -1.23, 2.635), at(0.5, 1, 540), at(0.1, 0.1, 1.5e6)]) {
      const { cam, rig, finish } = standAt(site, 120 * DEG, 15 * DEG);
      finish();
      const eye = firstPersonEye(site);
      expect(cam.position.distanceTo(vec(eye))).toBeLessThan(1e-6);
      const want = firstPersonLookDir(basisFromUp(ellipsoidUp(eye)), 120 * DEG, 15 * DEG);
      const fwd = cam.getWorldDirection(new THREE.Vector3());
      expect(fwd.distanceTo(vec(want))).toBeLessThan(1e-6);
      // horizon level: the camera's right vector has no component along the local vertical
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      expect(Math.abs(right.dot(vec(ellipsoidUp(eye))))).toBeLessThan(1e-6);
      expect(rig.flying).toBe(false);
      expect(rig.dist).toBe(FP_LOOK_KM);
    }
  });

  it('stays at ~0 distance from the object in float64 (the near plane has nothing to clip, no float32 noise)', () => {
    const site = at(0.3459, -2.7134, 4.205);
    const { cam, anchor, finish } = standAt(site);
    finish();
    expect(cam.position.distanceTo(anchor)).toBeCloseTo(FP_EYE_KM, 9);
    expect(cam.near).toBeLessThanOrEqual(FP_EYE_KM * 5);
  });

  it('never goes below the camera altitude floor, over a low site or in the transition', () => {
    const site = at(-0.43, -1.23, 2.635);
    const { cam, rig, anchor } = standAt(site);
    for (let t = 0; t <= DUR + 100; t += 1000 / 60) {
      rig.update(anchor, new THREE.Vector3(), 1000 + t);
      expect(altitudeOf([cam.position.x, cam.position.y, cam.position.z])).toBeGreaterThanOrEqual(MIN_ALT_KM - 1e-6);
    }
  });

  it('starts on the pose it left and ends on the eye', () => {
    const site = at(0.5, 0.4, 420);
    const { cam, start, finish } = standAt(site);
    expect(cam.position.distanceTo(start)).toBeLessThan(1e-6);
    finish();
    expect(cam.position.distanceTo(vec(firstPersonEye(site)))).toBeLessThan(1e-6);
  });

  it('follows the moving observatory: the Earth turns under a ground site and the camera stays at it', () => {
    const { cam, rig, finish } = standAt(at(0.3, 0.2, 4.2));
    finish();
    const later = at(0.3, 0.2 + 0.01, 4.2);
    rig.update(vec(later), new THREE.Vector3(), 9000);
    expect(cam.position.distanceTo(vec(firstPersonEye(later)))).toBeLessThan(1e-6);
    expect(cam.up.dot(vec(ellipsoidUp(firstPersonEye(later))))).toBeGreaterThan(1 - 1e-9);
  });

  it('turns with a left drag: right looks left, down looks up, and the view stays at the eye', () => {
    const site = at(0.3459, -2.7134, 4.205);
    const { cam, rig, anchor, fire, finish } = standAt(site, 0, 0.2);
    finish();
    const eye = cam.position.clone();
    fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    fire('pointermove', { pointerId: 1, clientX: 160, clientY: 100, buttons: 1, shiftKey: false });
    expect(rig.az).toBeLessThan(0);
    expect(rig.az).toBeCloseTo(-60 * (60 * DEG) / 600, 9);
    fire('pointermove', { pointerId: 1, clientX: 160, clientY: 140, buttons: 1, shiftKey: false });
    expect(rig.el).toBeCloseTo(0.2 + 40 * (60 * DEG) / 600, 9);
    rig.update(anchor, new THREE.Vector3(), 9000);
    expect(cam.position.distanceTo(eye)).toBeLessThan(1e-9);
  });

  it('does not pan (right or shift drag leaves the pose alone)', () => {
    const { cam, rig, anchor, fire, finish } = standAt(at(0.5, 1, 540), 0.4, 0.1);
    finish();
    const eye = cam.position.clone(), target = rig.target.clone();
    fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    fire('pointermove', { pointerId: 1, clientX: 180, clientY: 150, buttons: 2, shiftKey: false });
    fire('pointermove', { pointerId: 1, clientX: 200, clientY: 170, buttons: 1, shiftKey: true });
    expect(rig.pan.length()).toBe(0);
    expect(rig.az).toBe(0.4);
    expect(rig.el).toBe(0.1);
    rig.update(anchor, new THREE.Vector3(), 9000);
    expect(cam.position.distanceTo(eye)).toBeLessThan(1e-9);
    expect(rig.target.distanceTo(target)).toBeLessThan(1e-6);
  });

  it('the wheel changes the field of view, within 1..120 degrees, and does not move the camera', () => {
    const { cam, rig, anchor, fire, finish } = standAt(at(0.5, 1, 540));
    finish();
    const eye = cam.position.clone();
    const fov0 = cam.fov;
    fire('wheel', { deltaY: -300, deltaMode: 0 });
    expect(cam.fov).toBeLessThan(fov0);
    expect(cam.fov).toBeCloseTo(fov0 * Math.exp(-300 * 0.0013), 9);
    fire('wheel', { deltaY: 300, deltaMode: 0 });
    expect(cam.fov).toBeCloseTo(fov0, 9);
    for (let i = 0; i < 60; i++) fire('wheel', { deltaY: -300, deltaMode: 0 });
    expect(cam.fov).toBe(FP_FOV_MIN);
    for (let i = 0; i < 60; i++) fire('wheel', { deltaY: 300, deltaMode: 0 });
    expect(cam.fov).toBe(FP_FOV_MAX);
    expect(rig.dist).toBe(FP_LOOK_KM);
    rig.update(anchor, new THREE.Vector3(), 9000);
    expect(cam.position.distanceTo(eye)).toBeLessThan(1e-9);
  });

  it('keeps a finite pose at the pole and looking straight up', () => {
    const { cam, rig, anchor, finish } = standAt(at(Math.PI / 2, 0, 4), 0.3, 1.6);
    finish();
    expect(rig.el).toBeLessThan(1.51);
    for (const v of [cam.position.x, cam.position.y, cam.position.z, ...cam.quaternion.toArray()]) expect(Number.isFinite(v)).toBe(true);
    rig.update(anchor, new THREE.Vector3(), 9000);
    expect(Number.isFinite(cam.quaternion.x)).toBe(true);
  });

  it('leaves for the globe mode with the transition ending on the globe pose (the restored az / el / dist)', () => {
    const site = at(0.5, 0.4, 420);
    const { cam, rig, anchor, finish } = standAt(site);
    finish();
    clock = 5000;
    rig.switchMode('globe', DUR);
    rig.az = 0.6;
    rig.el = 0.45;
    rig.dist = 24000;
    const o = new THREE.Vector3();
    rig.update(o, o, 5000 + DUR);
    expect(cam.position.length()).toBeCloseTo(24000, 6);
    expect(cam.up.z).toBeCloseTo(1, 9);
    expect(anchor.length()).toBeGreaterThan(0);
  });
});
