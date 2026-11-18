import { defaultBodies, fixedToGeodetic, geodeticToFixed, surfaceShape, type Vec3 } from '@eio/core';
import { EARTH_BODY, MIN_ALT_KM, type SurfaceBody, type V3 } from './camera';
import { bodyAxes, traverseWorld, type BodyAxes } from './traverse';

/**
 * The ground of the surface-aligned view for ANY drawn body with a radius (pure, no three.js). One rule builds it: the body's
 * registry entry (radius, the shape `surfaceShape` places sites on) and its body-fixed frame at the moment (`bodyAxes`, core
 * `convert`: the IAU pole and spin, or the neutral `NO_ROTATION` for a body whose pole is not in the registry, whose "north" is then
 * the scene's +Z). The Sun is excluded: it has no ground.
 */

/** Facet count of the sphere every drawn body but the Earth is built from (`createMapSphere`: 128 x 64). */
export const SPHERE_WIDTH_SEGMENTS = 128;
/** The camera clears the mesh by this many times its facet sag. The Earth's 3 km is 25 times the sag of its own 512 x 256 mesh. */
export const FLOOR_SAG_FACTOR = 4;
/** Absolute lower bound of the floor, km (10 m): below this the float64-to-float32 camera-relative upload is the limit, not the mesh. */
export const MIN_FLOOR_KM = 0.01;

/**
 * The lowest the camera may be above a body's ground, km. The Earth keeps its 3 km (`MIN_ALT_KM`, 25 times the sag of its
 * 512 x 256 mesh). Every other body is the 128 x 64 sphere, whose facets sag by R (1 - cos(pi / 128)) = 3.0e-4 R from the true
 * sphere between vertices (the Moon 0.52 km, Mars 1.0 km, Vesta 0.08 km); the floor is `FLOOR_SAG_FACTOR` (4) times that, so the
 * camera is always above the drawn mesh, with the same kind of margin the Earth has, scaling with the body instead of the
 * Earth's size (1.2e-3 R: the Moon 2.1 km, Mars 4.1 km, Ceres 0.57 km, never under `MIN_FLOOR_KM`).
 */
export function altitudeFloorKm(bodyId: string, radiusKm: number): number {
  if (bodyId === 'EARTH') return MIN_ALT_KM;
  const sag = radiusKm * (1 - Math.cos(Math.PI / SPHERE_WIDTH_SEGMENTS));
  return Math.max(MIN_FLOOR_KM, FLOOR_SAG_FACTOR * sag);
}

/** Whether the surface view can stand on this registry body: it has a radius and is not the Sun. */
export function hasSurface(bodyId: string): boolean {
  if (bodyId === 'SUN' || !defaultBodies.has(bodyId)) return false;
  const r = defaultBodies.get(bodyId).radiusKm;
  return Number.isFinite(r) && r > 0;
}

/**
 * The ground of `bodyId` from its body-fixed axes in the scene's Earth-inertial space: centre `a.o`, pole `a.ez`, the radius and
 * flattening of `surfaceShape` (the Earth's ellipsoid, every other body its sphere), and the altitude floor.
 */
export function surfaceBodyFromAxes(bodyId: string, a: BodyAxes): SurfaceBody {
  const shape = surfaceShape(defaultBodies.get(bodyId));
  return { c: [a.o[0], a.o[1], a.o[2]], radiusKm: shape.radiusKm, flattening: shape.flattening, pole: [a.ez[0], a.ez[1], a.ez[2]], floorKm: altitudeFloorKm(bodyId, shape.radiusKm) };
}

/** The ground of `bodyId` at `tMs`, float64 km in the scene's axes; null for the Sun, an unknown body, or a body with no state then. The Earth is the fixed `EARTH_BODY`. */
export function surfaceBodyAt(bodyId: string, tMs: number): SurfaceBody | null {
  if (bodyId === 'EARTH') return EARTH_BODY;
  if (!hasSurface(bodyId)) return null;
  const a = bodyAxes(bodyId, tMs);
  return a ? surfaceBodyFromAxes(bodyId, a) : null;
}

/** Scene (Earth-inertial) position of a point given by planetocentric/geodetic `lat`, `lon` (rad) and height `alt` (km) over the body's shape. */
export function groundPointWorld(bodyId: string, a: BodyAxes, lat: number, lon: number, alt: number): V3 {
  const f = geodeticToFixed({ lat, lon, alt }, surfaceShape(defaultBodies.get(bodyId)));
  const out = new Float64Array(3);
  traverseWorld(Float64Array.from(f), 1, a, out);
  return [out[0], out[1], out[2]];
}

/** The inverse: latitude, longitude (rad) and height (km) of a scene position over the body's shape. */
export function worldToGround(bodyId: string, a: BodyAxes, p: V3): { lat: number; lon: number; alt: number } {
  const r: Vec3 = [p[0] - a.o[0], p[1] - a.o[1], p[2] - a.o[2]];
  const f: Vec3 = [
    r[0] * a.ex[0] + r[1] * a.ex[1] + r[2] * a.ex[2],
    r[0] * a.ey[0] + r[1] * a.ey[1] + r[2] * a.ey[2],
    r[0] * a.ez[0] + r[1] * a.ez[1] + r[2] * a.ez[2],
  ];
  return fixedToGeodetic(f, surfaceShape(defaultBodies.get(bodyId)));
}

