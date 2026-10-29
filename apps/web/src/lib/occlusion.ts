import { EARTH } from '@eio/core';
import type { V3 } from './camera';

/**
 * Occlusion by the drawn bodies: ONE list of bodies, ONE test, shared by the point shader and every CPU consumer.
 *
 * Every body the scene draws (the Earth, the Moon, the Sun, Mars, and any body added later) reaches this module as a
 * `SceneBody` from `CelestialLayer.bodies()`: its centre relative to the camera (`rel`, subtracted in float64), its radius and
 * its flattening. `OccluderSet.build` turns that list, once a frame, into at most `MAX_OCCLUDERS` slots (`SphereView`): the
 * bodies that cover the most sky first, those under `MIN_OCCLUDER_PX` px skipped. The point shader (scene/materials.ts) gets
 * the very same slots as a uniform array and runs the same test in GLSL (`sphereOccludes` is the reference for it); the
 * picker, hover, labels and the other CPU tests call `OccluderSet.hides`. Nothing here names a body, so adding one needs
 * nothing but `CelestialLayer` exposing it (see docs/frames.md, "Adding a body").
 *
 * A body is a sphere or, when it has a flattening f, an ellipsoid (a, a, b = a (1 - f)): stretching its pole axis by `k = 1 / (1 - f)` maps it
 * to a sphere of radius `a`, so a ray test against a sphere is exact for it (the pole is +z for the Earth, `SceneBody.pole` for the
 * oblate giants). Each test
 * sphere is shrunk by a small margin so a marker lying ON the surface (a pad, a lander) is never taken to be hidden by the
 * ground it stands on.
 *
 * Positions are camera-relative: the ray starts at the camera (the origin) and ends at `rel`, both computed in float64 by
 * the caller, which is what keeps the test accurate for a camera metres from the target and for a Sun 1.5e8 km away.
 */

/** Ellipsoid z scale of the Earth, 1 / (1 - f). */
export const ELLIPSOID_K = 1 / (1 - EARTH.flattening);
/** Occluder radius reduction, km (above the mesh facet sag, below anything meant to hover above the ground). */
export const OCCLUSION_MARGIN_KM = 0.3;

/**
 * Slots in the point shader's occluder array (two vec4-sized uniforms each: 2 x 24 = 48 vectors). Sized for every planet and
 * the large moons to be drawn with room over; WebGL2 guarantees at least 256 vertex uniform vectors (WebGL1: 128), and the
 * rest of the point shader uses about 30. More bodies than slots: the ones covering the most sky win and `overflow` counts the rest.
 */
export const MAX_OCCLUDERS = 24;
/** A body whose apparent radius is under this many px cannot hide a point visibly and is not given a slot. */
export const MIN_OCCLUDER_PX = 0.25;

/** A drawn body as occlusion and the disc hiding (lib/disc-hide.ts) see it: the one list `CelestialLayer.bodies()` returns. */
export interface SceneBody {
  entityId: string;
  /** centre in world space, km (the frame of the camera `origin`) */
  c: V3;
  /** centre relative to the camera, km, in float64: refreshed by the layer each frame (`CelestialLayer.update`) */
  rel: V3;
  /** true radius, km, and the factor it is drawn with (always 1: everything is drawn to scale) */
  radiusKm: number;
  k: number;
  /** flattening (0 for a sphere; the Earth's for the Earth), see `ELLIPSOID_K` */
  flattening?: number;
  /** unit vector of the body's pole in the world frame (default +z, the Earth's): the axis the flattening squashes */
  pole?: V3;
  /** how far the body's own system reaches above its surface and behind its centre plane, km (lib/disc-hide.ts) */
  reachKm?: number;
  depthKm?: number;
}

/**
 * A body seen from the camera, in the form the point shader receives: `(x, y, z)` is the centre RELATIVE to the camera with z
 * scaled by `k` (the ellipsoid), `r` the shrunk radius and `c2 = |centre|^2 - r^2` (float64: > 0 when the camera is outside).
 */
export interface SphereView {
  x: number;
  y: number;
  z: number;
  r: number;
  c2: number;
  /** scale of the ellipsoid along its pole, 1 for a sphere */
  k: number;
  /** unit pole axis (camera-relative frame = world frame), +z for the Earth: the scaling is `v + (k - 1)(v . pole) pole` */
  pxa: number;
  pya: number;
  pza: number;
}

export const newSphereView = (): SphereView => ({ x: 0, y: 0, z: 0, r: 0, c2: 0, k: 1, pxa: 0, pya: 0, pza: 1 });

/** Margin for a sphere: the Earth's absolute margin, but never more than 1 % of the radius (a small, far Sun). */
const sphereMargin = (r: number, marginKm: number): number => Math.min(marginKm, r * 0.01);

/** Fill `out` for a body whose centre is `(rx, ry, rz)` from the camera. */
export function setSphereView(out: SphereView, rx: number, ry: number, rz: number, radiusKm: number, flattening = 0, marginKm = OCCLUSION_MARGIN_KM, pole?: V3): SphereView {
  const k = flattening > 0 ? 1 / (1 - flattening) : 1;
  const pxa = pole ? pole[0] : 0, pya = pole ? pole[1] : 0, pza = pole ? pole[2] : 1;
  // the ellipsoid (a, a, b = a / k) squashed along the pole axis becomes a sphere when the axis is stretched by k
  const g = (k - 1) * (rx * pxa + ry * pya + rz * pza);
  const x = rx + g * pxa, y = ry + g * pya, z = rz + g * pza;
  const r = radiusKm - sphereMargin(radiusKm, marginKm);
  out.x = x;
  out.y = y;
  out.z = z;
  out.r = r;
  out.c2 = x * x + y * y + z * z - r * r;
  out.k = k;
  out.pxa = pxa;
  out.pya = pya;
  out.pza = pza;
  return out;
}

/** A new view of a body at `rel` (the Earth: `flattening = EARTH.flattening`; another body: its `pole`). */
export const sphereView = (rel: V3, radiusKm: number, flattening = 0, marginKm = OCCLUSION_MARGIN_KM, pole?: V3): SphereView =>
  setSphereView(newSphereView(), rel[0], rel[1], rel[2], radiusKm, flattening, marginKm, pole);

/**
 * True when the body `v` (see `SphereView`) lies between the camera and the point `rel` (camera-relative). Only a point whose
 * segment to the camera crosses it is hidden: a point on the camera side of the near surface, beside the body, or looking away
 * from it is not. A point inside the body is hidden. THE test: the point shader's GLSL is this function line for line.
 *
 * Written to stay accurate in float32 for huge distances: the miss distance is the length of `cross(u, centre)` (no
 * `|centre|^2 - t^2` cancellation) and the near hit is `c2 / (b + sqrt((r - p)(r + p)))`.
 */
export function sphereOccludes(v: SphereView, rx: number, ry: number, rz: number): boolean {
  if (v.c2 <= 0) return false; // camera inside the body: nothing sensible to hide
  const g = (v.k - 1) * (rx * v.pxa + ry * v.pya + rz * v.pza);
  const dx = rx + g * v.pxa, dy = ry + g * v.pya, dz = rz + g * v.pza;
  const L = Math.hypot(dx, dy, dz);
  if (L === 0) return false;
  const ux = dx / L, uy = dy / L, uz = dz / L;
  const b = ux * v.x + uy * v.y + uz * v.z;
  if (b <= 0) return false; // looking away from the centre
  const cx = uy * v.z - uz * v.y, cy = uz * v.x - ux * v.z, cz = ux * v.y - uy * v.x;
  const p = Math.hypot(cx, cy, cz);
  if (p >= v.r) return false; // the ray misses the body
  return v.c2 / (b + Math.sqrt((v.r - p) * (v.r + p))) < L;
}

/** True when the Earth (the ellipsoid, shrunk by the margin) lies between the camera at world `origin` and `origin + rel`. */
export function earthOccludes(origin: V3, rel: V3, marginKm = OCCLUSION_MARGIN_KM): boolean {
  return sphereOccludes(sphereView([-origin[0], -origin[1], -origin[2]], EARTH.radiusKm, EARTH.flattening, marginKm), rel[0], rel[1], rel[2]);
}

/**
 * How far the middle of a straight chord of `chordKm` between two points on a sphere of radius `radiusKm` sinks below the
 * surface. A depth-tested line drawn along the ground between widely spaced points (a ground track, the footprint circle)
 * dips under the Earth mesh by this much and shows as dashes unless its vertices are lifted by at least it.
 */
export function chordSagKm(chordKm: number, radiusKm: number = EARTH.radiusKm): number {
  const h = Math.min(chordKm / 2, radiusKm);
  return radiusKm - Math.sqrt(radiusKm * radiusKm - h * h);
}

/**
 * The occluders of one frame. `build` fills `slots` (preallocated, mutated: no allocation per frame) from the body list;
 * `slots[0 .. count)` are the ones in use, the biggest in the sky first. The point shader reads the slots as uniforms and
 * `hides` tests them on the CPU, so the two always see the same bodies and the same numbers.
 */
export class OccluderSet {
  /** the slots; only the first `count` are meaningful */
  readonly slots: SphereView[] = Array.from({ length: MAX_OCCLUDERS }, newSphereView);
  /** slots in use */
  count = 0;
  /** bodies that qualified for a slot in the last build but did not get one (the smaller ones lose) */
  overflow = 0;
  /** the most `overflow` ever seen (a debug counter: nonzero means MAX_OCCLUDERS is too small for the scene) */
  maxOverflow = 0;
  private readonly sky = new Float64Array(MAX_OCCLUDERS);
  private readonly scratch = newSphereView();

  /**
   * Choose the slots for the bodies in `bodies` seen with vertical field of view `fovDeg` on a viewport `viewportPx` high.
   * Skipped: a body under `minPx` px (apparent radius) and one the camera is inside. When more qualify than there are slots,
   * the ones with the largest angular radius win.
   */
  build(bodies: readonly SceneBody[], fovDeg: number, viewportPx: number, minPx = MIN_OCCLUDER_PX, marginKm = OCCLUSION_MARGIN_KM): void {
    const focalPx = viewportPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    const slots = this.slots, sky = this.sky, s = this.scratch;
    let count = 0, overflow = 0;
    for (const b of bodies) {
      const [x, y, z] = b.rel;
      const dist = Math.hypot(x, y, z);
      const radius = b.radiusKm * b.k;
      if (!(dist > 0) || !(radius > 0)) continue;
      const ang = radius / dist; // angular radius, rad (tan of it is the pixel ratio below, near enough for a cutoff)
      if (!(ang * focalPx >= minPx)) continue;
      setSphereView(s, x, y, z, radius, b.flattening ?? 0, marginKm, b.pole);
      if (s.c2 <= 0) continue; // the camera is inside it
      let pos: number;
      if (count < MAX_OCCLUDERS) pos = count++;
      else {
        overflow++;
        if (!(ang > sky[MAX_OCCLUDERS - 1])) continue;
        pos = MAX_OCCLUDERS - 1; // replaces the smallest in use
      }
      const t = slots[pos];
      t.x = s.x; t.y = s.y; t.z = s.z; t.r = s.r; t.c2 = s.c2; t.k = s.k; t.pxa = s.pxa; t.pya = s.pya; t.pza = s.pza;
      sky[pos] = ang;
      // keep the slots sorted by angular radius, largest first (insertion: swap the objects, no allocation)
      while (pos > 0 && sky[pos - 1] < ang) {
        const o = slots[pos - 1];
        slots[pos - 1] = slots[pos];
        slots[pos] = o;
        sky[pos] = sky[pos - 1];
        sky[pos - 1] = ang;
        pos--;
      }
    }
    this.count = count;
    this.overflow = overflow;
    if (overflow > this.maxOverflow) this.maxOverflow = overflow;
  }

  /** Is the camera-relative point hidden behind any slot? Bound so it can be passed around (`occluded: set.hides`). */
  readonly hides = (rx: number, ry: number, rz: number): boolean => {
    const slots = this.slots;
    for (let i = 0, n = this.count; i < n; i++) if (sphereOccludes(slots[i], rx, ry, rz)) return true;
    return false;
  };
}

/** Geocentric distance beyond which the horizon test can be skipped because everything is far outside the planet. */
export const horizonDistanceKm = (altKm: number): number => Math.sqrt(Math.max(0, 2 * EARTH.radiusKm * altKm + altKm * altKm));
