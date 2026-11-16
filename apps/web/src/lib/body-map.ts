import { inertialToFixedMatrix, frameEpoch, precessDir, transpose, DEG, type Body, type Mat3, type Vec3 } from '@eio/core';

/**
 * Pure helpers for body surface maps (the Moon and Mars are drawn as a sphere with an equirectangular map, z = pole,
 * +x = prime meridian at the map centre u = 0.5, u growing east).
 */

/** Size an image is drawn at when the GPU's texture limit is `max`: the image itself, or scaled down to `max` wide (aspect kept). */
export function fitMapSize(width: number, height: number, max: number): { width: number; height: number; scaled: boolean } {
  if (width <= max) return { width, height, scaled: false };
  return { width: max, height: Math.max(1, Math.round((max * height) / width)), scaled: true };
}

/**
 * Body-fixed to SCENE-inertial rotation (row-major): it takes the mesh's local axes (z = pole, +x = prime meridian) to the
 * scene's Earth-inertial axes (of date), so it is the mesh's orientation. The IAU matrix is in the body's own inertial axes,
 * which are J2000 for every body but the Earth and the Moon (core `frameEpoch`), so for those the columns are precessed to
 * the date, the same rotation the frame hop applies to the body's position: mesh, rings, pole and positions agree. The Moon
 * (a J2000 IAU pole in a frame of date, 0.37 deg) and the Earth are left as they were (docs/frames.md).
 */
export function bodyFixedToInertial(body: Body, tMs: number): Mat3 {
  const m = transpose(inertialToFixedMatrix(body, tMs));
  if (frameEpoch(body.id) !== 'j2000') return m;
  const c0 = precessDir([m[0], m[3], m[6]], tMs, false), c1 = precessDir([m[1], m[4], m[7]], tMs, false), c2 = precessDir([m[2], m[5], m[8]], tMs, false);
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
}

/**
 * Unit vector of the body's IAU north pole in the scene-inertial axes (from its pole right ascension and declination, precessed
 * to `tMs` for a J2000-group body; without `tMs` the J2000 direction).
 */
export function poleDirection(body: Body, tMs?: number): Vec3 {
  if (body.rotation.kind !== 'linear') return [0, 0, 1];
  const ra = body.rotation.poleRaDeg * DEG, dec = body.rotation.poleDecDeg * DEG;
  const p: Vec3 = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  return tMs !== undefined && frameEpoch(body.id) === 'j2000' ? precessDir(p, tMs, false) : p;
}
