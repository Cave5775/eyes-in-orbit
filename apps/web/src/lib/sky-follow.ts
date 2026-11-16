import { DEG } from '@eio/core';
import type { V3 } from './camera';
import { lstRad, precessDir, raDecToDir } from './sky-frame';
import { poseFromLook } from './sky-pose';

/**
 * Follow in the Sky view (pure): keep the same altitude and azimuth while the sky turns, like a telescope that does not track.
 * The zenith is the special case (altitude 90). What is held is the view's direction AND its screen-up vector, both as components
 * on the observer's local east / north / up, so they are fixed in the horizontal frame. At each sim time they are turned back into
 * vectors of date (the first-person frame, mean sidereal time) and go through `poseFromLook`, the function that turns the
 * first-person camera into Aladin's pose (centre precessed to J2000 and the position angle of screen-up), so Follow and the pose
 * the view was entered with agree exactly.
 *
 * Why not an azimuth and an altitude: near the zenith the azimuth is undefined (noise of 1e-6 degrees or worse decides it) and a
 * roll derived from "local up" would be arbitrary there. The up vector is captured from Aladin's own rotation when the hold is
 * taken, so the roll the person sees is kept (entering from the first-person view it is horizon-up) and is continuous at any altitude.
 *
 * Space telescopes have no horizon and no sky rotation in an inertial frame, so there is nothing to follow for them.
 */

/** The held view in the local frame: unit direction and unit screen-up, components (east, north, up). */
export interface HeldView { dir: V3; up: V3 }

interface Local { e: V3; n: V3; u: V3 }

/** The local east / north / up of date, as the first-person view builds them from the mean sidereal time. */
function localFrame(tMs: number, latDeg: number, lonDeg: number): Local {
  const L = lstRad(tMs, lonDeg), p = latDeg * DEG;
  const sL = Math.sin(L), cL = Math.cos(L), sp = Math.sin(p), cp = Math.cos(p);
  return { e: [-sL, cL, 0], n: [-sp * cL, -sp * sL, cp], u: [cp * cL, cp * sL, sp] };
}

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const toLocal = (v: V3, f: Local): V3 => [dot(v, f.e), dot(v, f.n), dot(v, f.u)];
const fromLocal = (c: V3, f: Local): V3 => [0, 1, 2].map((i) => c[0] * f.e[i] + c[1] * f.n[i] + c[2] * f.u[i]) as V3;

/**
 * What Follow holds for a J2000 view centre with screen-up at position angle `rotationDeg` (from north toward east, the
 * `SkyPose.rotationDeg` convention) seen from a site at `tMs`.
 */
export function holdFromCentre(raDeg: number, decDeg: number, rotationDeg: number, tMs: number, latDeg: number, lonDeg: number): HeldView {
  const ra = raDeg * DEG, dec = decDeg * DEG, r = (Number.isFinite(rotationDeg) ? rotationDeg : 0) * DEG;
  const d = raDecToDir(raDeg, decDeg);
  const north: V3 = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
  const east: V3 = [-Math.sin(ra), Math.cos(ra), 0];
  const upJ: V3 = [0, 1, 2].map((i) => Math.cos(r) * north[i] + Math.sin(r) * east[i]) as V3;
  const f = localFrame(tMs, latDeg, lonDeg);
  return { dir: toLocal(precessDir(d, tMs, false), f), up: toLocal(precessDir(upJ, tMs, false), f) };
}

/** The altitude and azimuth (degrees, azimuth from north through east) of the held direction; for display and tests. */
export function altAzOf(h: HeldView): { azDeg: number; elDeg: number } {
  const az = Math.atan2(h.dir[0], h.dir[1]) / DEG;
  return { azDeg: ((az % 360) + 360) % 360, elDeg: Math.atan2(h.dir[2], Math.hypot(h.dir[0], h.dir[1])) / DEG };
}

export interface FollowAim {
  /** J2000 centre */
  raDeg: number;
  decDeg: number;
  /** position angle of screen-up, degrees from north toward east (the `SkyPose.rotationDeg` convention) */
  rotationDeg: number;
}

/** Where the held view is on the sky at `tMs` (J2000 centre and rotation). */
export function aimForHold(hold: HeldView, tMs: number, latDeg: number, lonDeg: number): FollowAim {
  const f = localFrame(tMs, latDeg, lonDeg);
  const pose = poseFromLook(fromLocal(hold.dir, f), tMs, 60, 1, fromLocal(hold.up, f)); // the field and aspect do not enter the centre or the rotation
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

/**
 * Guards Follow against reading its own move as somebody else's. Aladin applies `gotoRaDec` at once (checked in 3.8.2: the
 * centre read right after is the new one, and Follow stayed on across 15 minute steps at a 3600x clock), but a build that applied it on
 * the next frame would still report the old centre, which a large step puts outside the tolerance. So the tick after an aim is not
 * checked, and the later ones compare against the place that was aimed at.
 */
export class FollowGuard {
  private at: { raDeg: number; decDeg: number } | null = null;
  private skip = 0;

  /** Follow aimed the view at `p`. */
  aimed(p: { raDeg: number; decDeg: number }): void {
    this.at = { raDeg: p.raDeg, decDeg: p.decDeg };
    this.skip = 1;
  }

  /** True when the centre `now` shows that something else moved the view since the last aim. */
  moved(now: { raDeg: number; decDeg: number } | null, hFovDeg: number): boolean {
    if (!this.at || !now) return false;
    if (this.skip > 0) {
      this.skip--;
      return false;
    }
    return movedByOthers(this.at, now, hFovDeg);
  }
}
