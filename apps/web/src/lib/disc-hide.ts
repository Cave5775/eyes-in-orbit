/**
 * Hiding small objects over a small, far body (docs: plans.md, "hide the icons in 3D space as well"). Zoomed out, the
 * satellite cloud drawn over a distant Earth (or objects over a Moon or Sun dot) is a smear nobody can aim at, so the point
 * shader does not draw those points and picking does not offer them: a click there lands on the body. The cone below is the
 * body's pick hit area (`max(BODY_MIN_HIT_PX, disc + 3)` px, see `bodyHitRadiusPx`), so what is hidden is what a click on the
 * body resolves to. It switches off once the disc radius exceeds `GROUP_DISC_PX` (zoomed in the objects are drawn apart).
 *
 * The shader (scene/materials.ts) and `hiddenByDisc` implement the same test on the same numbers; keep them in step.
 * A point is hidden when its direction from the camera is inside a body's cone AND it is in front of the body (points
 * behind are covered by the disc itself, which the occlusion tests already handle). Points with `aShow >= SHOW_EXEMPT`
 * (selected, hovered, related, kept by a filter, featured, launch vehicles, pads, the highlight set) are never hidden here.
 * No three.js.
 */
import type { V3 } from './camera';
import { BODY_MIN_HIT_PX, GROUP_DISC_PX, bodyDiscRadiusPx } from './pick';

/** Bodies the point shader has a slot for: Earth, Moon, Sun, Mars (every drawn body, so a click that lands on one finds nothing hidden-but-visible). */
export const GROUP_SLOTS = 4;

/** A drawn body as the camera sees it. */
export interface GroupBody {
  /** centre relative to the camera in display space, km */
  rel: V3;
  /** true radius, km, and the display shrink factor (the radius drawn is `radiusKm * k`) */
  radiusKm: number;
  k: number;
}

/**
 * One shader slot: `x, y, z` the unit direction from the camera to the body's centre, `sinR` the sine of the cone's angular
 * radius (> 1: switched off) and `dist` the distance to the centre, km. The sine (not the cosine) is compared because
 * `1 - cos` of a cone a few px wide drowns in float32; the shader gets the same numbers as a vec4 and a float.
 */
export interface DiscGroup {
  x: number;
  y: number;
  z: number;
  sinR: number;
  dist: number;
}

/** `sinR` of a slot that hides nothing (the shader's `w > 1`). */
export const GROUP_OFF = 2;

export const offGroup = (): DiscGroup => ({ x: 0, y: 0, z: 1, sinR: GROUP_OFF, dist: 0 });

/**
 * The slots for this frame: a body whose disc radius is at most `maxDiscPx` gets a cone of its pick hit radius, the others
 * (and a camera inside a sphere) are off. `fovDeg` is the vertical field of view and `viewportPx` the viewport height, the
 * same two numbers `bodyPickExtra` uses. Always `slots` entries.
 */
export function discGroups(bodies: readonly GroupBody[], fovDeg: number, viewportPx: number, maxDiscPx = GROUP_DISC_PX, slots = GROUP_SLOTS): DiscGroup[] {
  const out: DiscGroup[] = [];
  const focalPx = viewportPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  for (const b of bodies) {
    if (out.length >= slots) break;
    const [x, y, z] = b.rel;
    const dist = Math.hypot(x, y, z);
    const disc = bodyDiscRadiusPx(b.radiusKm, b.k, dist, fovDeg, viewportPx);
    if (!(disc <= maxDiscPx) || !(dist > 0) || !(focalPx > 0)) {
      out.push(offGroup());
      continue;
    }
    const hitPx = Math.max(BODY_MIN_HIT_PX, disc + 3);
    out.push({ x: x / dist, y: y / dist, z: z / dist, sinR: hitPx / Math.hypot(hitPx, focalPx), dist });
  }
  while (out.length < slots) out.push(offGroup());
  return out;
}

/**
 * Is the camera-relative point hidden by a small body's cone? Mirrors the vertex shader: inside the cone
 * (`|cross(u, dir)| < sinR` with `dot(u, dir) > 0`) and nearer than the body's centre plane.
 */
export function hiddenByDisc(x: number, y: number, z: number, groups: readonly DiscGroup[]): boolean {
  const L = Math.hypot(x, y, z);
  if (!(L > 0)) return false;
  const ux = x / L, uy = y / L, uz = z / L;
  for (const g of groups) {
    if (g.sinR > 1) continue;
    const b = ux * g.x + uy * g.y + uz * g.z;
    if (b <= 0) continue;
    const cx = uy * g.z - uz * g.y, cy = uz * g.x - ux * g.z, cz = ux * g.y - uy * g.x;
    if (Math.hypot(cx, cy, cz) >= g.sinR) continue;
    if (x * g.x + y * g.y + z * g.z < g.dist) return true; // in front of the body
  }
  return false;
}
