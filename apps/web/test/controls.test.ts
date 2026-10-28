import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { OrbitRig } from '../src/scene/controls';
import { MIN_ALT_KM, altitudeOf, basisFromUp, basisOffset, ellipsoidUp, surfaceRadius, type V3 } from '../src/lib/camera';

const fakeDom = () => {
  const noop = () => undefined;
  return { style: {}, addEventListener: noop, removeEventListener: noop, setPointerCapture: noop, clientHeight: 500 } as unknown as HTMLElement;
};
const at = (lat: number, lon: number, alt: number): V3 => {
  const d: V3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const r = surfaceRadius(d) + alt;
  return [d[0] * r, d[1] * r, d[2] * r];
};
const vec = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);
const DUR = 1500;

/** The rig stamps a transition with performance.now(): drive that clock by hand so the frames land inside it. */
let clock = 0;
vi.spyOn(performance, 'now').mockImplementation(() => clock);
afterEach(() => { clock = 0; });

/** angle (rad) between the camera's view direction and the direction to `p` */
const aimError = (cam: THREE.PerspectiveCamera, p: THREE.Vector3): number => {
  const fwd = cam.getWorldDirection(new THREE.Vector3());
  const to = p.clone().sub(cam.position).normalize();
  return Math.acos(Math.max(-1, Math.min(1, fwd.dot(to))));
};

describe('OrbitRig mode transition aim', () => {
  const globeRig = (dist: number, az: number, el: number) => {
    const cam = new THREE.PerspectiveCamera(45, 1.6, 1, 1e12);
    const rig = new OrbitRig(cam, fakeDom());
    rig.dist = dist;
    rig.az = az;
    rig.el = el;
    rig.minDist = 1;
    rig.update(null, new THREE.Vector3(), 0);
    return { cam, rig };
  };

  it('looks at the followed object from the first frame to the last, in both directions', () => {
    for (const [dist, az, el] of [[24000, 0.6, 0.45], [24000, 3, -0.3], [80000, 2, 0.05], [9000, 1, 0.2], [7500, 4, -0.5]]) {
      for (const obj of [at(0.5, 0.4, 420), at(-0.3, 2.9, 7), at(1.2, -1, 346)]) {
        const { cam, rig } = globeRig(dist, az, el);
        const o = vec(obj);
        // globe -> surface of the object
        clock = 1000;
        rig.switchMode('surface', DUR);
        rig.az = -Math.PI / 2;
        rig.el = 0.35;
        rig.dist = 1400;
        for (let t = 0; t <= DUR + 100; t += 1000 / 60) {
          rig.update(o, new THREE.Vector3(), 1000 + t);
          expect(rig.target.distanceTo(o)).toBeLessThan(1e-9);
          expect(aimError(cam, o)).toBeLessThan(1e-6);
          expect(altitudeOf([cam.position.x, cam.position.y, cam.position.z])).toBeGreaterThanOrEqual(MIN_ALT_KM - 1e-6);
        }
        // and back to the globe view of the same object
        clock = 5000;
        rig.switchMode('globe', DUR);
        rig.az = 1;
        rig.el = 0.3;
        rig.dist = 20000;
        for (let t = 0; t <= DUR + 100; t += 1000 / 60) {
          rig.update(o, new THREE.Vector3(), 5000 + t);
          expect(rig.target.distanceTo(o)).toBeLessThan(1e-9);
          expect(aimError(cam, o)).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('looks at the ground point of a free surface view throughout, and at the Earth centre when leaving it', () => {
    const { cam, rig } = globeRig(24000, 0.6, 0.45);
    const g = vec(at(0.2, 1.1, 0));
    clock = 1000;
    rig.switchMode('surface', DUR);
    rig.az = -Math.PI / 2;
    rig.el = 0.35;
    rig.dist = 300;
    for (let t = 0; t <= DUR + 100; t += 1000 / 60) {
      rig.update(null, g, 1000 + t);
      expect(rig.target.distanceTo(g)).toBeLessThan(1e-9);
      expect(aimError(cam, g)).toBeLessThan(1e-6);
    }
    const o = new THREE.Vector3();
    clock = 5000;
    rig.switchMode('globe', DUR);
    rig.az = 0.5;
    rig.el = 0.4;
    rig.dist = 24000;
    for (let t = 0; t <= DUR + 100; t += 1000 / 60) {
      rig.update(null, o, 5000 + t);
      expect(rig.target.length()).toBeLessThan(1e-9);
      expect(aimError(cam, o)).toBeLessThan(1e-6);
      expect(altitudeOf([cam.position.x, cam.position.y, cam.position.z])).toBeGreaterThan(MIN_ALT_KM);
    }
  });

  it('ends exactly on the mode pose and starts exactly on the pose it left', () => {
    const { cam, rig } = globeRig(24000, 0.6, 0.45);
    const start = cam.position.clone();
    const obj = at(0.5, 0.4, 420), o = vec(obj);
    clock = 1000;
    rig.switchMode('surface', DUR);
    rig.az = -Math.PI / 2;
    rig.el = 0.35;
    rig.dist = 1400;
    rig.update(o, new THREE.Vector3(), 1000);
    expect(cam.position.distanceTo(start)).toBeLessThan(1e-6);
    rig.update(o, new THREE.Vector3(), 1000 + DUR);
    const off = basisOffset(basisFromUp(ellipsoidUp(obj)), -Math.PI / 2, 0.35, 1400);
    expect(cam.position.distanceTo(new THREE.Vector3(obj[0] + off[0], obj[1] + off[1], obj[2] + off[2]))).toBeLessThan(1e-6);
    expect(rig.flying).toBe(false);
  });

  it('never leaves its target inside the Earth when the transition is interrupted half-way', () => {
    const { rig } = globeRig(24000, 0.6, 0.45);
    const o = vec(at(0.5, 0.4, 420));
    clock = 1000;
    rig.switchMode('surface', DUR);
    rig.az = -Math.PI / 2;
    rig.el = 0.35;
    rig.dist = 1400;
    for (let t = 0; t <= 700; t += 1000 / 60) {
      rig.update(o, new THREE.Vector3(), 1000 + t);
      // what SceneController.setFollow(false) keeps as the free target
      expect(altitudeOf([rig.target.x, rig.target.y, rig.target.z])).toBeGreaterThan(400);
    }
  });
});
