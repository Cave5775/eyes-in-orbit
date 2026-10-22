import type { V3 } from './camera';

/**
 * Floating-origin helpers (pure). World positions live in float64 on the CPU, in km around the Earth's centre. A
 * float32 holds ~7 significant digits, i.e. 0.5 m at 6,400 km: uploading world positions and letting the GPU subtract
 * the camera makes everything within a few km of the camera wobble by that much. Instead the CPU subtracts the camera
 * position in float64 and uploads the (small) difference, so a point 200 m from the camera is accurate to ~10 micrometres.
 */

/** Rotation about +z by `gmst` (Earth-fixed to inertial), as cos/sin. */
export interface Spin {
  cos: number;
  sin: number;
}

export const spinOf = (gmstRad: number): Spin => ({ cos: Math.cos(gmstRad), sin: Math.sin(gmstRad) });

/**
 * out[i] = R(spin) * world[i] - origin for the first `count` points (xyz triples). `fixed` marks the input as
 * Earth-fixed (rotated into the inertial frame before the subtraction); otherwise it is already inertial.
 */
export function toCameraRelative(world: ArrayLike<number>, out: Float32Array, count: number, origin: V3, spin: Spin, fixed: boolean): void {
  const ox = origin[0], oy = origin[1], oz = origin[2];
  const n = Math.min(count, Math.floor(out.length / 3), Math.floor(world.length / 3)) * 3;
  if (fixed) {
    const c = spin.cos, s = spin.sin;
    for (let i = 0; i < n; i += 3) {
      const x = world[i], y = world[i + 1];
      out[i] = c * x - s * y - ox;
      out[i + 1] = s * x + c * y - oy;
      out[i + 2] = world[i + 2] - oz;
    }
  } else {
    for (let i = 0; i < n; i += 3) {
      out[i] = world[i] - ox;
      out[i + 1] = world[i + 1] - oy;
      out[i + 2] = world[i + 2] - oz;
    }
  }
}

/** Earth-fixed to inertial for one point. */
export function fixedToInertial(f: ArrayLike<number>, spin: Spin, out: V3 = [0, 0, 0]): V3 {
  out[0] = spin.cos * f[0] - spin.sin * f[1];
  out[1] = spin.sin * f[0] + spin.cos * f[1];
  out[2] = f[2];
  return out;
}
