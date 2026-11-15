/**
 * The SGP4 worker samples every satellite about 30 times a second, but the scene draws at the frame's own sim time. Drawing
 * the sample as is puts each point 0..33 ms (times the clock rate) behind the camera, which follows its target at the exact
 * time: the points and their labels shake, more the closer the camera is. Each frame the sample is carried forward to the
 * frame time with a second-order step under the Earth's point-mass gravity (error about 1 cm at x600 over a 33 ms tick).
 */

/** Earth's gravitational parameter, km^3/s^2: WGS-72, the value SGP4 itself uses (Vallado et al. 2006, "Revisiting Spacetrack Report #3"). */
export const MU_EARTH_WGS72 = 398_600.8;

/**
 * Fill `out` (xyz per satellite) from `states` (x, y, z, vx, vy, vz per satellite, km and km/s) carried `dtSec` seconds forward.
 * A zero position (no state) stays zero. `dtSec` may be negative (the clock runs backwards).
 */
export function extrapolateStates(states: ArrayLike<number>, out: Float64Array, n: number, dtSec: number): void {
  const h = 0.5 * dtSec * dtSec;
  for (let i = 0; i < n; i++) {
    const s = i * 6, o = i * 3;
    const x = states[s], y = states[s + 1], z = states[s + 2];
    if (x === 0 && y === 0 && z === 0) {
      out[o] = out[o + 1] = out[o + 2] = 0;
      continue;
    }
    const r2 = x * x + y * y + z * z;
    const k = (-MU_EARTH_WGS72 / (r2 * Math.sqrt(r2))) * h; // a = -mu r / |r|^3
    out[o] = x + states[s + 3] * dtSec + k * x;
    out[o + 1] = y + states[s + 4] * dtSec + k * y;
    out[o + 2] = z + states[s + 5] * dtSec + k * z;
  }
}
