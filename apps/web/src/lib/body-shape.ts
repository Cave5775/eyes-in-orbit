/**
 * Shape of a celestial body, as the scene draws it (pure; the web side only, like `body-style.ts`: the core registry holds
 * physics). A body is drawn at one of three tiers, chosen by what is known about it and how close the camera is:
 *
 *   1. `sphere`  (the default: no entry). One shared sphere scaled to the registry radius (and the registry flattening, for
 *                the giants and Ceres). Costs nothing per body and is right for every large, round body.
 *   2. `ellipsoid`  semi-axes a >= b >= c in km, for the bodies that are measurably not round: Haumea is a rapid rotator
 *                (a triaxial ellipsoid at a 2:1:1 ratio), the small moons are potatoes. Still the same shared geometry, scaled
 *                per axis, so it costs nothing either. Only `radiiKm` plus a `source` is needed.
 *   3. `mesh`    a glTF binary (.glb) for a body whose detail matters up close (a dwarf planet or a small body with a shape
 *                model). Fetched only when the body's disc gets big enough on screen (`meshWanted`), shared through the asset
 *                cache (`lib/asset-cache.ts`), disposed when the camera leaves and the budget needs the room. Until it has
 *                loaded (or if it never does) the body shows its tier 1 or 2 shape: a missing file degrades, it never breaks.
 *
 * Adding a body or changing a shape is one entry in `BODY_SHAPES`; nothing else changes (the occluders, disc cones, picks and
 * labels keep using the registry's mean radius, a sphere: for the bodies that would be ellipsoids the difference is below a
 * pixel at any distance a sphere hides something).
 *
 * Physical numbers need a `source`; never put in a value that was not read from somewhere. The table is empty on purpose
 * until the numbers have been checked: see docs/models.md for what each entry needs.
 */

export interface EllipsoidShape {
  kind: 'ellipsoid';
  /** semi-axes, km, along the body's x (towards the prime meridian), y and z (the pole) in its body-fixed frame */
  radiiKm: readonly [number, number, number];
  /** where the radii come from (a paper, a NASA/JPL page); required so a number can be traced */
  source: string;
}

export interface MeshShape {
  kind: 'mesh';
  /** the glb, served from the web app (`/models/<file>.glb`) or any CORS-enabled https URL */
  url: string;
  /** approximate bytes it holds once parsed (geometry and textures): what the cache budget counts; measure it, do not guess */
  bytes: number;
  /** disc radius in pixels at which loading starts (default `MESH_LOAD_PX`) */
  loadPx?: number;
  /** the shape shown until the mesh arrives, or for ever if it cannot be loaded (omitted: the registry sphere) */
  fallback?: EllipsoidShape;
  /** the model's own axes: `'iau'` (default) = its +z is the pole and +x the prime meridian, like a map sphere */
  frame?: 'iau';
  source: string;
}

export type BodyShape = EllipsoidShape | MeshShape;

const NAIF = 'NAIF pck00011.tpc, BODY<id>_RADII, from the IAU WGCCRE report the kernel cites (naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc, read 2026-11-14)';

/**
 * Shapes by registry id. Tier 2 entries are the bodies whose NAIF triaxial radii differ from a sphere by more than 2.5 % (c / a
 * under 0.975): the two Martian moons, Mimas, Enceladus, Iapetus (an oblate spheroid) and Miranda. The rounder ones (Io 0.992,
 * Europa, Tethys 0.978 ...) stay spheres: their radii differ by under a pixel at any distance a disc is visible. Haumea is
 * missing on purpose: its radii are not in the kernel and the registry has no rotation for it, so a triaxial shape would have no
 * orientation. No mesh entry yet: it needs a licensed glb (docs/models.md).
 */
export const BODY_SHAPES: Record<string, BodyShape> = {
  PHOBOS: { kind: 'ellipsoid', radiiKm: [13.0, 11.4, 9.1], source: NAIF },
  DEIMOS: { kind: 'ellipsoid', radiiKm: [7.8, 6.0, 5.1], source: NAIF },
  MIMAS: { kind: 'ellipsoid', radiiKm: [207.8, 196.7, 190.6], source: NAIF },
  ENCELADUS: { kind: 'ellipsoid', radiiKm: [256.6, 251.4, 248.3], source: NAIF },
  IAPETUS: { kind: 'ellipsoid', radiiKm: [745.7, 745.7, 712.1], source: NAIF },
  MIRANDA: { kind: 'ellipsoid', radiiKm: [240.4, 234.2, 232.9], source: NAIF },
  // smaller moons (2026-11-17): every NAIF triaxial entry with a rotation model, c / a under 0.975. Hyperion (180.1, 133.0, 102.7)
  // has none (chaotic rotation, NO_ROTATION), so like Haumea it has no orientation and stays a sphere. pck00011 gives Despina (74),
  // Galatea (79) and Larissa (96, after a commented 104 / --- / 89 alternative) as equal radii: spheres, no entry.
  AMALTHEA: { kind: 'ellipsoid', radiiKm: [125, 73, 64], source: NAIF },
  THEBE: { kind: 'ellipsoid', radiiKm: [58, 49, 42], source: NAIF },
  PHOEBE: { kind: 'ellipsoid', radiiKm: [109.4, 108.5, 101.8], source: NAIF },
  JANUS: { kind: 'ellipsoid', radiiKm: [101.7, 93.0, 76.3], source: NAIF },
  EPIMETHEUS: { kind: 'ellipsoid', radiiKm: [64.9, 57.3, 53.0], source: NAIF },
  PROTEUS: { kind: 'ellipsoid', radiiKm: [218, 208, 201], source: NAIF },
};

/** The shape entry of a body, or undefined for a plain sphere. */
export const shapeOf = (id: string, table: Readonly<Record<string, BodyShape>> = BODY_SHAPES): BodyShape | undefined => table[id];

/** The ellipsoid to draw before any mesh is there: the entry itself, a mesh's fallback, or none. */
export function baseEllipsoid(s: BodyShape | undefined): EllipsoidShape | undefined {
  return s?.kind === 'ellipsoid' ? s : s?.kind === 'mesh' ? s.fallback : undefined;
}

/**
 * Per-axis scale of the shared unit-mean-radius sphere for semi-axes `radii` (km) and the registry mean radius `meanKm`:
 * `[a, b, c] / meanKm`, so the mesh built at `meanKm` becomes the ellipsoid. Invalid radii (not all positive and finite)
 * give null: the caller keeps its sphere.
 */
export function ellipsoidScale(radii: readonly [number, number, number], meanKm: number): [number, number, number] | null {
  if (!(meanKm > 0) || !radii.every((r) => Number.isFinite(r) && r > 0)) return null;
  return [radii[0] / meanKm, radii[1] / meanKm, radii[2] / meanKm];
}

/** Volume-equivalent radius of an ellipsoid, km: what a sphere with the same volume has. */
export const meanRadiusOf = (r: readonly [number, number, number]): number => Math.cbrt(r[0] * r[1] * r[2]);

/** Default disc radius (px) at which a body's mesh starts to load. */
export const MESH_LOAD_PX = 24;
/** The mesh is released again when the disc is under this fraction of the load radius (hysteresis against flicker). */
export const MESH_DROP_FRACTION = 0.4;

/**
 * Should the body's mesh be held this frame? Wanted once the disc radius reaches `loadPx` and kept until it falls under
 * `loadPx * MESH_DROP_FRACTION` (or the body leaves the view: `inView` false). `held` is whether it is held now.
 */
export function meshWanted(discPx: number, loadPx: number, held: boolean, inView = true): boolean {
  if (!inView || !(discPx > 0)) return false;
  return held ? discPx >= loadPx * MESH_DROP_FRACTION : discPx >= loadPx;
}
