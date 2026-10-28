/**
 * Hiding small objects over a small, far body (docs: plans.md, "hide the icons in 3D space as well"). Zoomed out, the
 * satellite cloud drawn over a distant Earth (or objects over a Moon or Sun dot) is a smear nobody can aim at, so the point
 * shader does not draw those points and picking does not offer them: a click there lands on the body. It switches off once
 * the disc radius exceeds `GROUP_DISC_PX` (zoomed in the objects are drawn apart).
 *
 * Two shapes are hidden, both about the body's centre `c` (the camera-relative position of the body):
 *  - the cone: a point whose direction from the camera is within the body's pick hit radius (`max(BODY_MIN_HIT_PX, disc + 3)`
 *    px, see `bodyHitRadiusPx`), in front of the body's centre plane or at most `depthKm` behind it (the Earth: GEO,
 *    `EARTH_SYSTEM_DEPTH_KM`, so the satellites seen at the limb from behind go too, while the Moon, a probe or a planet that
 *    happens to lie behind the Earth stay). What is hidden is what a click on the body resolves to.
 *  - the shell: a point within `radiusKm * k + reachKm + 3 px` of `c`, in front or behind. `reachKm` is how far the body's own
 *    system reaches (`EARTH_SYSTEM_REACH_KM`: the LEO shell, about 2000 km above the surface), so the satellites drawn just
 *    beyond the limb, which would still read as a ring of clutter around the disc, go too, and so do the ones on the far
 *    side just outside the limb (the disc covers those inside it). Farther orbits (MEO about 20,000 km, GEO 42,164 km from
 *    the centre) stay drawn once they are more than a few px from the disc.
 *
 * The shader (scene/materials.ts) and `hiddenByDisc` implement the same test on the same numbers; keep them in step.
 * Points with `aShow >= SHOW_EXEMPT` are never hidden here: the selected, the hovered and the followed entity, launch
 * vehicles, stages and capsules in flight, and the highlight set (rings and ticks of the selection). Everything else is
 * hidden, labelled entities (the ISS, ground stations) and launch pads included. No three.js.
 */
import type { V3 } from './camera';
import { BODY_MIN_HIT_PX, GROUP_DISC_PX, bodyDiscRadiusPx } from './pick';

/**
 * Cone slots in the point shader. The cones are made from the same body list as the occluders (`SceneBody` in lib/occlusion.ts,
 * `CelestialLayer.bodies()`), in the layer's order: the first `GROUP_SLOTS` bodies get one (Earth, Moon, Sun, Mars and the
 * planets to come; a body past the last slot has no cone, the objects over its disc stay drawn).
 */
export const GROUP_SLOTS = 8;

/** How far above the surface the Earth's crowded low orbits reach, km: the upper edge of the LEO shell (the ISS flies at 420 km, the Starlink shells at 340 to 570 km, debris clouds to about 2000 km). */
export const EARTH_SYSTEM_REACH_KM = 2000;

/** How far behind the Earth's centre its satellites lie, km: the geostationary radius, 42,164 km from the centre (the highest orbit that is crowded). */
export const EARTH_SYSTEM_DEPTH_KM = 42_164;

/** Screen margin, px, added to the cone and to the shell (the same 3 px the body's pick hit area adds to its disc). */
export const GROUP_MARGIN_PX = 3;

/** A drawn body as the camera sees it: a `SceneBody` (lib/occlusion.ts) is one, so the cones and the occluders share a list. */
export interface GroupBody {
  /** centre relative to the camera in display space, km */
  rel: V3;
  /** true radius, km, and the display shrink factor (the radius drawn is `radiusKm * k`) */
  radiusKm: number;
  k: number;
  /** how far the body's own system reaches above its drawn surface, km (default 0: only the margin) */
  reachKm?: number;
  /** how far behind the body's centre plane its system reaches, km (default 0: the cone hides only what is in front) */
  depthKm?: number;
}

/**
 * One shader slot: `x, y, z` the unit direction from the camera to the body's centre, `sinR` the sine of the cone's angular
 * radius (> 1: switched off), `dist` the distance to the centre, km, `shell` the radius of the shell about the centre, km and
 * `back` how far behind the centre plane the cone still hides, km.
 * The sine (not the cosine) is compared because `1 - cos` of a cone a few px wide drowns in float32; the shader gets the same
 * numbers as a vec4 and two floats.
 */
export interface DiscGroup {
  x: number;
  y: number;
  z: number;
  sinR: number;
  dist: number;
  shell: number;
  back: number;
}

/** `sinR` of a slot that hides nothing (the shader's `w > 1`). */
export const GROUP_OFF = 2;

export const offGroup = (): DiscGroup => ({ x: 0, y: 0, z: 1, sinR: GROUP_OFF, dist: 0, shell: 0, back: 0 });

/**
 * The slots for this frame: a body whose disc radius is at most `maxDiscPx` gets a cone of its pick hit radius and a shell, the
 * others (and a camera inside a sphere) are off. `fovDeg` is the vertical field of view and `viewportPx` the viewport height,
 * the same two numbers `bodyPickExtra` uses. Always `slots` entries.
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
    const hitPx = Math.max(BODY_MIN_HIT_PX, disc + GROUP_MARGIN_PX);
    // the shell, in km at the body's own depth: its drawn radius, the system's reach and the screen margin
    const shell = b.radiusKm * b.k + (b.reachKm ?? 0) + (GROUP_MARGIN_PX * dist) / focalPx;
    out.push({ x: x / dist, y: y / dist, z: z / dist, sinR: hitPx / Math.hypot(hitPx, focalPx), dist, shell, back: b.depthKm ?? 0 });
  }
  while (out.length < slots) out.push(offGroup());
  return out;
}

/**
 * Is the camera-relative point hidden by a small body? Mirrors the vertex shader: within the shell about the body's centre, or
 * inside the cone (`|cross(u, dir)| < sinR` with `dot(u, dir) > 0`) and nearer than the body's centre plane plus `back`.
 */
export function hiddenByDisc(x: number, y: number, z: number, groups: readonly DiscGroup[]): boolean {
  const L = Math.hypot(x, y, z);
  if (!(L > 0)) return false;
  const ux = x / L, uy = y / L, uz = z / L;
  for (const g of groups) {
    if (g.sinR > 1) continue;
    if (Math.hypot(x - g.x * g.dist, y - g.y * g.dist, z - g.z * g.dist) < g.shell) return true; // in the body's own system
    const b = ux * g.x + uy * g.y + uz * g.z;
    if (b <= 0) continue;
    const cx = uy * g.z - uz * g.y, cy = uz * g.x - ux * g.z, cz = ux * g.y - uy * g.x;
    if (Math.hypot(cx, cy, cz) >= g.sinR) continue;
    if (x * g.x + y * g.y + z * g.z < g.dist + g.back) return true; // in front of the body, or not far behind it
  }
  return false;
}
