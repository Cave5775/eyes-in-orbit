import { inertialToFixedMatrix, transpose, DEG, type Body, type Mat3, type Vec3 } from '@eio/core';

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
 * Body-fixed to inertial rotation (row-major), the transpose of the IAU inertial-to-fixed matrix: it takes the mesh's
 * local axes (z = pole, +x = prime meridian) to inertial axes, so it is the mesh's orientation.
 */
export function bodyFixedToInertial(body: Body, tMs: number): Mat3 {
  return transpose(inertialToFixedMatrix(body, tMs));
}

/** Unit vector of the body's IAU north pole in the inertial frame (from its pole right ascension and declination). */
export function poleDirection(body: Body): Vec3 {
  if (body.rotation.kind !== 'linear') return [0, 0, 1];
  const ra = body.rotation.poleRaDeg * DEG, dec = body.rotation.poleDecDeg * DEG;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}
