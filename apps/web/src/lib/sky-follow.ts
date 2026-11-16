import { DEG } from '@eio/core';
import type { V3 } from './camera';
import { lstRad, precessFromJ2000, raDecToAzEl } from './sky-frame';
import { poseFromLook } from './sky-pose';

/**
 * Follow in the Sky view (pure): keep the same altitude and azimuth while the sky turns, like a telescope that does not track.
 * The zenith is the special case (altitude 90). The held direction is fixed in the observer's horizontal frame; at each sim time it
 * is converted to equatorial coordinates of date (`azElToRaDec`, mean sidereal time) and precessed to J2000, which is what Aladin
 * and the HiPS surveys use. The roll stays horizon-up: the local vertical is the screen's up vector. Both go through
 * `poseFromLook`, the function that turns the first-person camera into Aladin's pose, so Follow and the pose the view was
 * entered with agree exactly (the J2000 position angle is the parallactic angle plus the meridian convergence of the
 * precession, about 0.15 deg, which a plain parallactic angle would leave out).
 *
 * Space telescopes have no horizon and no sky rotation in an inertial frame, so there is nothing to follow for them.
 */

export interface HeldAltAz { azDeg: number; elDeg: number }

/** The altitude and azimuth (of date, no refraction) of a J2000 view centre seen from a site at `tMs`: what Follow holds. */
export function holdFromCentre(raDeg: number, decDeg: number, tMs: number, latDeg: number, lonDeg: number): HeldAltAz {
  const of = precessFromJ2000(raDeg, decDeg, tMs);
  const h = raDecToAzEl(of.raDeg, of.decDeg, tMs, latDeg, lonDeg);
  return { azDeg: h.azDeg, elDeg: h.elDeg };
}

export interface FollowAim {
  /** J2000 centre */
  raDeg: number;
  decDeg: number;
  /** position angle of screen-up, degrees from north toward east (the `SkyPose.rotationDeg` convention): horizon-up */
  rotationDeg: number;
}

/** Where the held altitude/azimuth is on the sky at `tMs` (J2000 centre and the horizon-up rotation). */
export function aimForHold(hold: HeldAltAz, tMs: number, latDeg: number, lonDeg: number): FollowAim {
  // the local east / north / up of date, as the first-person view builds them from the mean sidereal time
  const L = lstRad(tMs, lonDeg), p = latDeg * DEG;
  const sL = Math.sin(L), cL = Math.cos(L), sp = Math.sin(p), cp = Math.cos(p);
  const e: V3 = [-sL, cL, 0];
  const n: V3 = [-sp * cL, -sp * sL, cp];
  const u: V3 = [cp * cL, cp * sL, sp];
  const az = hold.azDeg * DEG, el = hold.elDeg * DEG;
  const ce = Math.cos(el), se = Math.sin(el), sa = Math.sin(az), ca = Math.cos(az);
  const dir: V3 = [ce * sa * e[0] + ce * ca * n[0] + se * u[0], ce * sa * e[1] + ce * ca * n[1] + se * u[1], ce * sa * e[2] + ce * ca * n[2] + se * u[2]];
  const pose = poseFromLook(dir, tMs, 60, 1, u); // the field and aspect do not enter the centre or the rotation
  return { raDeg: pose.raDeg, decDeg: pose.decDeg, rotationDeg: pose.rotationDeg };
}

/** The sky turns at 15.0411 deg per hour of mean solar time (one turn per sidereal day, 86164.0905 s). */
export const SKY_TURN_DEG_PER_MS = 360 / 86_164_090.5;

/** Largest sky motion (degrees) allowed between two re-aims; below it the sky looks the same. */
export const FOLLOW_MAX_STEP_DEG = 0.05;
/** The step is also kept under this fraction of the field, so a deep zoom does not move in visible jumps. */
export const FOLLOW_FOV_FRACTION = 0.001;
/** Never re-aim more often than this in real time (about 4 Hz): a fast clock must not spam Aladin. */
export const FOLLOW_MIN_REAL_MS = 250;

/** The sky motion (degrees) that triggers a re-aim for a view `hFovDeg` wide: 0.05 at most, 0.1 % of the field, never under 0.002. */
export const followStepDeg = (hFovDeg: number): number => Math.min(FOLLOW_MAX_STEP_DEG, Math.max(0.002, (Number.isFinite(hFovDeg) ? hFovDeg : 60) * FOLLOW_FOV_FRACTION));

/**
 * Is a re-aim due? `lastSimMs` is the sim time of the last one (null: none yet, aim now), `lastRealMs` the wall time of it. It is
 * due when the sim clock has moved enough for the sky to turn `followStepDeg` (in either direction) and at least
 * FOLLOW_MIN_REAL_MS have passed; a paused clock never triggers.
 */
export function followDue(lastSimMs: number | null, simMs: number, lastRealMs: number, realMs: number, hFovDeg: number): boolean {
  if (lastSimMs === null) return true;
  if (realMs - lastRealMs < FOLLOW_MIN_REAL_MS) return false;
  return Math.abs(simMs - lastSimMs) * SKY_TURN_DEG_PER_MS >= followStepDeg(hFovDeg);
}

/** Angular separation (degrees) of two RA/Dec positions. */
export function separationDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  // haversine: accurate for the tiny separations Follow compares
  const a = dec1 * DEG, b = dec2 * DEG, dr = (ra1 - ra2) * DEG;
  const h = Math.sin((a - b) / 2) ** 2 + Math.cos(a) * Math.cos(b) * Math.sin(dr / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / DEG;
}

/**
 * Did something else move the view since Follow last aimed it (a marker click's animation, a programmatic goto)? True when the
 * centre Aladin reports is further from the last aim than a small tolerance (0.02 deg plus 0.2 % of the field), which Follow
 * answers by switching off instead of fighting it.
 */
export function movedByOthers(aimed: { raDeg: number; decDeg: number }, now: { raDeg: number; decDeg: number }, hFovDeg: number): boolean {
  return separationDeg(aimed.raDeg, aimed.decDeg, now.raDeg, now.decDeg) > 0.02 + 0.002 * (Number.isFinite(hFovDeg) ? hFovDeg : 60);
}
