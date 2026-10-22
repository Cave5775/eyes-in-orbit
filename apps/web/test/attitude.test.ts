import { describe, expect, it } from 'vitest';
import { EARTH, Sgp4Provider, type Omm } from '@eio/core';
import {
  basisToQuaternion, forwardBasis, lvlhBasis, rocketForward, rotateByQuaternion, sunlitFraction, toBody,
  type Basis,
} from '../src/lib/attitude';
import type { V3 } from '../src/lib/camera';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const near = (a: V3, b: V3, d = 6) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], d));

function orthonormalRightHanded(b: Basis): void {
  expect(dot(b.x, b.x)).toBeCloseTo(1, 9);
  expect(dot(b.y, b.y)).toBeCloseTo(1, 9);
  expect(dot(b.z, b.z)).toBeCloseTo(1, 9);
  expect(dot(b.x, b.y)).toBeCloseTo(0, 9);
  expect(dot(b.y, b.z)).toBeCloseTo(0, 9);
  expect(dot(b.x, b.z)).toBeCloseTo(0, 9);
  near(cross(b.x, b.y), b.z, 9);
}

describe('lvlhBasis', () => {
  const r: V3 = [6800, 0, 0];
  const v: V3 = [0, 7.5, 0];
  it('is x along velocity, z nadir, y completing (minus the orbit normal)', () => {
    const b = lvlhBasis(r, v)!;
    near(b.x, [0, 1, 0], 9);
    near(b.z, [-1, 0, 0], 9);
    near(b.y, [0, 0, -1], 9); // orbit normal r x v = +z, so y = -z
    orthonormalRightHanded(b);
  });

  it('stays orthonormal and right-handed on an eccentric / inclined state, with x in the orbit plane', () => {
    const rr: V3 = [4000, 5000, -3000];
    const vv: V3 = [-5.1, 4.2, 3.9];
    const b = lvlhBasis(rr, vv)!;
    orthonormalRightHanded(b);
    near(b.z, [-rr[0], -rr[1], -rr[2]].map((x) => x / Math.hypot(...rr)) as V3, 9);
    // y is exactly minus the unit orbit normal
    const h = cross(rr, vv);
    const hn = Math.hypot(...h);
    near(b.y, [-h[0] / hn, -h[1] / hn, -h[2] / hn], 9);
    expect(dot(b.x, vv)).toBeGreaterThan(0);
  });

  it('is null for degenerate states', () => {
    expect(lvlhBasis([0, 0, 0], [0, 1, 0])).toBeNull();
    expect(lvlhBasis([7000, 0, 0], [3, 0, 0])).toBeNull(); // radial velocity: no orbit plane
  });

  it('tracks the ISS along a real SGP4 orbit: x follows the velocity within the eccentricity, z points at the Earth, a full turn per orbit', () => {
    const omm: Omm = {
      OBJECT_NAME: 'ISS (ZARYA)', OBJECT_ID: '1998-067A', EPOCH: '2026-10-22T00:00:00.000Z', MEAN_MOTION: 15.49, ECCENTRICITY: 0.0005,
      INCLINATION: 51.64, RA_OF_ASC_NODE: 120, ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 270, NORAD_CAT_ID: 25544, BSTAR: 0.0002,
      MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
    };
    const p = new Sgp4Provider(omm);
    const t0 = Date.parse('2026-10-22T01:00:00Z');
    let prevX: V3 | null = null;
    let turned = 0; // total rotation of the x axis relative to the inertial frame, about the orbit normal
    for (let k = 0; k <= 92; k++) {
      const s = p.stateAt(t0 + k * 60_000)!;
      const b = lvlhBasis(s.r, s.v!)!;
      orthonormalRightHanded(b);
      const vn = Math.hypot(...s.v!);
      expect(dot(b.x, s.v!) / vn).toBeGreaterThan(0.999); // velocity within ~2.5 degrees of x
      expect(dot(b.z, s.r) / Math.hypot(...s.r)).toBeCloseTo(-1, 9);
      if (prevX) turned += Math.acos(Math.min(1, dot(prevX, b.x)));
      prevX = b.x;
    }
    expect(turned / (2 * Math.PI)).toBeCloseTo(92 / (1440 / 15.49), 1); // one revolution per orbital period
  });
});

describe('basisToQuaternion', () => {
  it('rotates the body axes onto the basis for every branch of the conversion', () => {
    const cases: Basis[] = [
      lvlhBasis([6800, 0, 0], [0, 7.5, 0])!,
      lvlhBasis([-3000, 5000, 4000], [3, 4, -5])!,
      lvlhBasis([0, 7000, 100], [-7, 0, 1])!,
      lvlhBasis([100, -200, 7000], [6, 4, 0.5])!,
      forwardBasis([0, 0, 1], [7000, 0, 0])!,
    ];
    for (const b of cases) {
      const q = basisToQuaternion(b);
      near(rotateByQuaternion(q, [1, 0, 0]), b.x, 9);
      near(rotateByQuaternion(q, [0, 1, 0]), b.y, 9);
      near(rotateByQuaternion(q, [0, 0, 1]), b.z, 9);
      expect(Math.hypot(...q)).toBeCloseTo(1, 12);
    }
  });

  it('maps an inertial vector into the body frame and back', () => {
    const b = lvlhBasis([6800, 100, -200], [-0.1, 7.5, 0.3])!;
    const w: V3 = [1, 2, 3];
    const body = toBody(b, w);
    const q = basisToQuaternion(b);
    near(rotateByQuaternion(q, body), w, 9);
  });
});

describe('rocket attitude', () => {
  const onPad: V3 = [EARTH.radiusKm, 0, 0];
  const rot = 7.2921150e-5;
  it('points straight up for a booster standing on the ground (inertial velocity is only the Earth\'s spin)', () => {
    const v: V3 = [0, rot * EARTH.radiusKm, 0];
    expect(rocketForward(onPad, v)).toEqual([1, 0, 0]);
  });
  it('points along the Earth-relative velocity in ascent', () => {
    const v: V3 = [1.2, rot * EARTH.radiusKm + 0.8, 0];
    const f = rocketForward(onPad, v)!;
    near(f, [1.2, 0.8, 0], 6);
  });
  it('stays upright while descending (engines first)', () => {
    const v: V3 = [-0.3, rot * EARTH.radiusKm, 0];
    expect(rocketForward(onPad, v)).toEqual([1, 0, 0]);
  });
  it('builds a valid basis even when the forward axis is vertical', () => {
    const b = forwardBasis([1, 0, 0], [EARTH.radiusKm, 0, 0])!;
    orthonormalRightHanded(b);
    near(b.x, [1, 0, 0], 9);
  });
});

describe('sunlitFraction', () => {
  const sun: V3 = [1, 0, 0];
  it('is 1 on the day side, 0 in the umbra behind the Earth, fractional in the penumbra', () => {
    expect(sunlitFraction([7000, 0, 0], sun)).toBe(1);
    expect(sunlitFraction([-7000, 0, 0], sun)).toBe(0);
    expect(sunlitFraction([0, 7000, 0], sun)).toBe(1); // terminator crossing high above: still lit
    // just outside the shadow cylinder on the night side
    expect(sunlitFraction([-7000, EARTH.radiusKm + 400, 0], sun)).toBe(1);
    // exactly on the Earth's limb as seen from the object: half the Sun's disc is covered
    const psi = Math.asin(EARTH.radiusKm / 7000);
    expect(sunlitFraction([-7000 * Math.cos(psi), 7000 * Math.sin(psi), 0], sun)).toBeCloseTo(0.5, 3);
  });
});
