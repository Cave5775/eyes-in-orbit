import { DEG } from '@eio/core';
import type { V3 } from './camera';
import { dirToRaDec, precessDir } from './sky-frame';

/**
 * Where the first-person camera points, in the terms a sky viewer (Aladin Lite) takes (pure maths).
 *
 * Axes. The scene's Earth-inertial axes are the equator and equinox of DATE for the Sun, Moon and SGP4 (TEME) and J2000 for the
 * planets, dwarf planets and moons (a Kepler orbit rotated by the J2000 obliquity); the first-person basis (east / north / up) is
 * built from the mean sidereal time, so a look direction taken from it is an equatorial direction OF DATE. `poseFromLook` takes
 * that and returns the J2000 RA/Dec a HiPS survey is indexed in, by IAU 1976 precession (lib/sky-frame.ts).
 *
 * Field of view. A pinhole (rectilinear) camera, the same as the gnomonic (TAN) projection of the Sky view. The scene's FOV is
 * the VERTICAL one (three.js `PerspectiveCamera.fov`); `aspect` is width / height. The horizontal one is
 *   h = 2 atan(aspect tan(v / 2)),   v = 2 atan(tan(h / 2) / aspect).
 *
 * Rotation. `rotationDeg` is the position angle of the camera's up vector on the sky: the angle at the view centre from
 * celestial north to the up vector projected on the view plane, measured from north toward east (the usual position-angle
 * convention). Seen by the viewer on a chart with north up, east is on the LEFT, so north -> east is counter-clockwise: 0 means
 * north is up on screen (an equatorial chart as in a textbook), +90 means east is up, 180 south is up, -90 west is up. It is in
 * (-180, 180]. With up = the local vertical it equals the parallactic angle (sky-frame `parallacticAngleDeg`). Aladin's `setRotation`
 * takes the opposite sign (checked against the real 3.8.2 widget, see lib/aladin.ts `aladinRotationDeg`).
 */

/** Horizontal field of view (deg) of a rectilinear camera of vertical field `vDeg` and `aspect` = width / height. */
export function vFovToHFov(vDeg: number, aspect: number): number {
  return (2 * Math.atan(aspect * Math.tan((vDeg * DEG) / 2))) / DEG;
}

/** The largest vertical field (deg) whose horizontal field at `aspect` does not pass `maxHDeg` (what the sky viewer can show); the scene's own field is cut to it on entering. */
export function maxVFovFor(maxHDeg: number, aspect: number): number {
  return hFovToVFov(maxHDeg, aspect);
}

/** Vertical field of view (deg) of a rectilinear camera of horizontal field `hDeg`; the inverse of `vFovToHFov`. */
export function hFovToVFov(hDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((hDeg * DEG) / 2) / aspect)) / DEG;
}

/**
 * Azimuth (rad, [0, 2 pi), from north through east) and elevation (rad) of direction `d` (any length) in the local frame: the
 * exact inverse of `firstPersonLookDir`. At the zenith or nadir the azimuth is undefined and comes out 0. `out` avoids an allocation.
 */
export function dirToAzEl(frame: { e: V3; n: V3; u: V3 }, d: V3, out: { az: number; el: number } = { az: 0, el: 0 }): { az: number; el: number } {
  const e = frame.e, n = frame.n, u = frame.u;
  const de = d[0] * e[0] + d[1] * e[1] + d[2] * e[2];
  const dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
  const du = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  let az = Math.atan2(de, dn);
  if (az < 0) az += 2 * Math.PI;
  if (az >= 2 * Math.PI) az = 0; // a tiny negative angle rounds up to exactly 2 pi
  out.az = az;
  out.el = Math.atan2(du, Math.hypot(de, dn));
  return out;
}

export interface SkyPose {
  /** J2000 right ascension of the view centre, [0, 360) */
  raDeg: number;
  /** J2000 declination of the view centre */
  decDeg: number;
  /** horizontal field of view, degrees */
  hFovDeg: number;
  /** position angle of the camera's up vector, degrees in (-180, 180], from north toward east (see the header) */
  rotationDeg: number;
}

/**
 * The sky pose of a camera looking along `dirOfDate` (equatorial, of date, any length) at sim time `tMs`, with vertical field
 * of view `vFovDeg` and `aspect` = width / height. `upDir` is the camera's up in the same axes (it need not be perpendicular to
 * the view; for the first-person view it is the local vertical `frame.u`); without it north is up (rotation 0).
 */
export function poseFromLook(dirOfDate: V3, tMs: number, vFovDeg: number, aspect: number, upDir?: V3): SkyPose {
  const d = precessDir(dirOfDate, tMs, true);
  const { raDeg, decDeg } = dirToRaDec(d);
  let rotationDeg = 0;
  if (upDir) {
    const up = precessDir(upDir, tMs, true);
    const ra = raDeg * DEG, es = Math.sin(ra), ec = Math.cos(ra);
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    // unit east E = (-sin ra, cos ra, 0) at the centre, unit north N = d x E (d unit); both are perpendicular to d
    const ex = -es, ey = ec;
    const nx = -d[2] * ey / len, ny = d[2] * ex / len, nz = (d[0] * ey - d[1] * ex) / len;
    rotationDeg = Math.atan2(up[0] * ex + up[1] * ey, up[0] * nx + up[1] * ny + up[2] * nz) / DEG;
    if (rotationDeg <= -180) rotationDeg += 360;
    if (!Number.isFinite(rotationDeg)) rotationDeg = 0;
  }
  return { raDeg, decDeg, hFovDeg: vFovToHFov(vFovDeg, aspect), rotationDeg };
}
