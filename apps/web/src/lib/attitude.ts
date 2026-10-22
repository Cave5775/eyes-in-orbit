import { EARTH } from '@eio/core';
import type { V3 } from './camera';

/**
 * Attitude maths for the 3D models (pure, no three.js). All vectors are in the Earth-inertial render frame.
 *
 * Model body frame (every model is authored in it): +X forward, +Y starboard (right when looking forward), +Z nadir
 * (down). That is the ISS structural frame and also the LVLH frame of an object in its typical flight attitude: x along
 * the velocity, z toward the Earth's centre, y completing the right-handed set (= minus the orbit normal).
 */

export interface Basis {
  /** body axes expressed in the inertial frame; right-handed (x cross y = z) */
  x: V3;
  y: V3;
  z: V3;
}

const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 | null => {
  const n = len(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : null;
};

/** Earth's rotation rate, rad/s (sidereal). */
export const EARTH_RATE_RAD_S = 7.2921150e-5;

/**
 * LVLH basis from an inertial state (km, km/s): z = nadir exactly, y = unit(z x v) (minus the orbit normal), x = y x z
 * (along the velocity for a circular orbit, in the orbit plane and perpendicular to nadir otherwise).
 * Null for a degenerate state (zero position, or velocity parallel to the radius).
 */
export function lvlhBasis(r: V3, v: V3): Basis | null {
  const rn = unit(r);
  if (!rn) return null;
  const z: V3 = [-rn[0], -rn[1], -rn[2]];
  const y = unit(cross(z, v));
  if (!y) return null;
  const x = cross(y, z);
  return { x, y, z };
}

/**
 * Basis with +X along `forward` and +Z as close to nadir as possible (a body that points somewhere and does not roll).
 * Null when `forward` is zero or parallel to the radius (use the caller's fallback).
 */
export function forwardBasis(forward: V3, r: V3): Basis | null {
  const x = unit(forward);
  const rn = unit(r);
  if (!x || !rn) return null;
  // a vertical body (forward parallel to the radius) has no unique "down-side": fall back to the polar axis, then X
  const y = unit(cross([-rn[0], -rn[1], -rn[2]], x)) ?? unit(cross([0, 0, 1], x)) ?? unit(cross([1, 0, 0], x));
  if (!y) return null;
  return { x, y, z: cross(x, y) };
}

/**
 * Where a rocket stage points (its +X): along its velocity relative to the Earth's surface while going up or flying
 * level, straight up when it is nearly at rest (on a pad) or descending (a landing booster comes down tail first, engines
 * burning against the motion). The Earth-fixed velocity is the inertial one minus omega x r.
 */
export function rocketForward(r: V3, v: V3): V3 | null {
  const up = unit(r);
  if (!up) return null;
  const rel: V3 = [v[0] + EARTH_RATE_RAD_S * r[1], v[1] - EARTH_RATE_RAD_S * r[0], v[2]];
  const speed = len(rel);
  if (speed < 0.02 || dot(rel, up) < -0.005) return up;
  return rel;
}

/** Body-frame coordinates of an inertial vector. */
export const toBody = (b: Basis, w: V3): V3 => [dot(w, b.x), dot(w, b.y), dot(w, b.z)];

/** Rotation taking body axes to inertial axes, as a unit quaternion [x, y, z, w] (three.js order). */
export function basisToQuaternion(b: Basis): [number, number, number, number] {
  // rotation matrix columns are the body axes
  const m00 = b.x[0], m10 = b.x[1], m20 = b.x[2];
  const m01 = b.y[0], m11 = b.y[1], m21 = b.y[2];
  const m02 = b.z[0], m12 = b.z[1], m22 = b.z[2];
  const tr = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotate `v` by the unit quaternion [x, y, z, w]. */
export function rotateByQuaternion(q: readonly number[], v: V3): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/**
 * Fraction of the Sun's disc visible from `r` (km, geocentric), 1 = full sun, 0 = umbra, a conical shadow model with the
 * Earth's apparent radius against the Sun's. `sunDir` is a unit vector toward the Sun. Accurate to a few seconds of
 * eclipse timing, which is all a lighting factor needs.
 */
export function sunlitFraction(r: V3, sunDir: V3): number {
  const R = len(r);
  if (R <= EARTH.radiusKm) return 1;
  const along = dot(r, sunDir);
  if (along > 0) return 1; // on the day side of the terminator plane
  const AU = 1.495978707e8;
  const SUN_R = 695_700;
  const earthAng = Math.asin(Math.min(1, EARTH.radiusKm / R)); // Earth's angular radius seen from the object
  const sunAng = Math.asin(SUN_R / AU);
  // angular separation between the Sun's direction and the Earth's centre direction
  const cosSep = Math.min(1, Math.max(-1, -along / R));
  const sep = Math.acos(cosSep);
  if (sep >= earthAng + sunAng) return 1;
  if (sep <= earthAng - sunAng) return 0;
  // linear penumbra ramp between the two limits (good enough for lighting)
  return (sep - (earthAng - sunAng)) / (2 * sunAng);
}
