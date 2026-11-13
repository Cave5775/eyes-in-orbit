import { MIN_ALT_KM, altitudeOf, ellipsoidUp, type V3 } from './camera';

/**
 * First-person view (pure maths, no three.js): the scene camera stands AT an observatory and looks outward. The frame is the
 * site's local east / north / up (north-up, carried by `advanceSurfaceFrame`), the azimuth is a compass bearing (0 = north,
 * 90 deg = east, clockwise seen from above), the elevation is measured from the local horizontal, wheel and pinch change the
 * field of view instead of moving the camera. A space telescope uses the same frame (up = away from the Earth).
 */

/** Narrowest and widest field of view the wheel may reach, degrees. */
export const FP_FOV_MIN = 1;
export const FP_FOV_MAX = 120;
/** Field of view on entering, degrees. */
export const FP_FOV_START = 60;
/** Eye height above a ground site, km (2 m). */
export const FP_EYE_KM = 0.002;
/** The look-at point is this far in front of the eye, km. The camera does not orbit it: it only gives the scope policy (lib/scope.ts) a focus and a scale that reach the whole sky. */
export const FP_LOOK_KM = 1000;
/** Highest and lowest elevation: never straight up or down, where the vertical would be parallel to the view (about 86 deg). */
export const FP_MAX_EL = 1.5;
/** A site lower than this above the ground counts as a ground observatory (km). */
export const FP_GROUND_ALT_KM = 50;

const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

export const clampFov = (fovDeg: number): number => Math.min(FP_FOV_MAX, Math.max(FP_FOV_MIN, Number.isFinite(fovDeg) ? fovDeg : FP_FOV_START));

/** Field of view after a wheel / pinch step `factor` (> 1 zooms out: wider, < 1 zooms in: narrower), clamped. */
export const zoomFov = (fovDeg: number, factor: number): number => clampFov(fovDeg * (Number.isFinite(factor) && factor > 0 ? factor : 1));

export const clampFpEl = (el: number): number => Math.min(FP_MAX_EL, Math.max(-FP_MAX_EL, el));

/**
 * Where the eye is for a site at geocentric `site` (km): `eyeKm` along the local vertical, and never lower than `minAltKm` above
 * the ellipsoid (the camera's usual floor: it clears the Earth mesh facets), lifted radially like the rig's own clamp.
 */
export function firstPersonEye(site: V3, eyeKm = FP_EYE_KM, minAltKm = MIN_ALT_KM): V3 {
  const n = len(site);
  if (!(n > 0)) return site;
  const u = ellipsoidUp(site);
  const p: V3 = [site[0] + u[0] * eyeKm, site[1] + u[1] * eyeKm, site[2] + u[2] * eyeKm];
  const alt = altitudeOf(p);
  if (alt >= minAltKm) return p;
  const k = (len(p) + (minAltKm - alt)) / len(p);
  return [p[0] * k, p[1] * k, p[2] * k];
}

/** Unit view direction for compass azimuth `az` (rad, clockwise from north) and elevation `el` (rad above the horizon) in the local frame. */
export function firstPersonLookDir(frame: { e: V3; n: V3; u: V3 }, az: number, el: number): V3 {
  const ce = Math.cos(el), se = Math.sin(el), sa = Math.sin(az), ca = Math.cos(az);
  return [
    ce * (sa * frame.e[0] + ca * frame.n[0]) + se * frame.u[0],
    ce * (sa * frame.e[1] + ca * frame.n[1]) + se * frame.u[1],
    ce * (sa * frame.e[2] + ca * frame.n[2]) + se * frame.u[2],
  ];
}

/**
 * Azimuth and elevation after a drag of (`dx`, `dy`) pixels. The sky is grabbed: it follows the pointer, so the view turns the
 * opposite way (drag right: look left; drag down: look up), by exactly the angle that moves the sky under the pointer, which is
 * the field of view over the viewport height per pixel (a narrow view turns slowly).
 */
export function firstPersonDrag(az: number, el: number, dx: number, dy: number, fovDeg: number, heightPx: number): { az: number; el: number } {
  const rate = (fovDeg * Math.PI) / 180 / Math.max(1, heightPx);
  return { az: az - dx * rate, el: clampFpEl(el + dy * rate) };
}

/** Compass bearing in degrees, 0 <= value < 360, of an azimuth in radians. */
export function compassDeg(az: number): number {
  const d = (az * 180) / Math.PI;
  return ((d % 360) + 360) % 360;
}

/** Where the view starts for a ground site (a little above the horizon, north) and a space telescope (level: the limb of the Earth sits low in the view). */
export function firstPersonStart(altKm: number): { az: number; el: number; fov: number } {
  return { az: 0, el: altKm < FP_GROUND_ALT_KM ? 0.26 : 0, fov: FP_FOV_START };
}

/** The scene readout while the view is on: `Looking from Mauna Kea Observatories, az 120 deg el 15 deg, FOV 60 deg`. */
export function firstPersonReadout(name: string, az: number, el: number, fovDeg: number): string {
  const elDeg = Math.round((el * 180) / Math.PI);
  return `Looking from ${name}, az ${Math.round(compassDeg(az)) % 360} deg el ${elDeg} deg, FOV ${Math.round(fovDeg)} deg`;
}

/** The camera as it was before the first-person view, restored when it ends. */
export interface FirstPersonSaved {
  dist: number;
  az: number;
  el: number;
  fov: number;
}

/**
 * Does a camera request end the first-person view? A request for the observatory we stand at (a click on its row) changes
 * nothing; any other request (another object, a ground point, the home view) does.
 */
export function focusEndsFirstPerson(standingAt: string, req: { id?: string }): boolean {
  return req.id !== standingAt;
}

/** Does a new selection end it? Only the observatory itself (or nothing yet changed) keeps it. */
export function selectionEndsFirstPerson(standingAt: string, selectedId: string | null): boolean {
  return selectedId !== standingAt;
}
