/**
 * Close-up Earth detail: pure planning for the streamed imagery layer (see scene/earth-detail.ts and the server's
 * /api/imagery tiles). The base map is one 8192 px texture (4.9 km per texel); closer than about 5,000 km the camera
 * magnifies it, so a window of finer tiles is laid over it. Tiles are squares of 180 / 2^z degrees (2^(z+1) across,
 * 2^z down, row 0 at the north pole), 512 px each, at levels 4 to 6 (2.4 to 0.6 km per pixel).
 */

export const TILE_PX = 512;
/** the atlas is ATLAS x ATLAS tiles, laid over the base map; a view may need at most FOOTPRINT_TILES of them */
export const ATLAS = 4;
export const FOOTPRINT_TILES = 3;
/** level 3 equals the base map's resolution, so detail starts at 4 */
export const DETAIL_MIN_Z = 4;
export const DETAIL_MAX_Z = 6;

const KM_PER_DEG = 111.195;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface DetailView {
  /** the surface point the camera looks at, geodetic degrees */
  latDeg: number;
  lonDeg: number;
  /** distance from the camera to that point, km */
  groundDistKm: number;
  fovDeg: number;
  /** height of the drawing buffer, pixels */
  viewportPx: number;
  aspect: number;
}

export interface DetailWindow {
  z: number;
  /** column and row of the top-left tile of the ATLAS x ATLAS window */
  tx: number;
  ty: number;
}

/** Degrees of tile size at level z. */
export const tileDeg = (z: number): number => 180 / 2 ** z;

/** Ground size of one screen pixel at the looked-at point, km. */
export function kmPerScreenPx(v: Pick<DetailView, 'groundDistKm' | 'fovDeg' | 'viewportPx'>): number {
  return (2 * v.groundDistKm * Math.tan((v.fovDeg * Math.PI) / 360)) / Math.max(1, v.viewportPx);
}

/**
 * Tile level for a view: as fine as one tile pixel per screen pixel, but coarse enough that the view's footprint
 * spans at most FOOTPRINT_TILES tiles each way (the rest of the ATLAS leaves room to pan before the window moves).
 * Null when the base map is already as sharp as the screen needs (level below DETAIL_MIN_Z).
 */
export function detailLevel(v: DetailView): number | null {
  const km = kmPerScreenPx(v);
  const zRes = Math.ceil(Math.log2((KM_PER_DEG * 180) / (TILE_PX * Math.max(km, 1e-6))));
  const halfKm = v.groundDistKm * Math.tan((v.fovDeg * Math.PI) / 360) * Math.max(1, v.aspect) * 1.25;
  const halfLatDeg = halfKm / KM_PER_DEG;
  const halfLonDeg = halfKm / (KM_PER_DEG * Math.max(0.2, Math.cos((v.latDeg * Math.PI) / 180)));
  const spanDeg = 2 * Math.max(halfLatDeg, halfLonDeg);
  const zFit = Math.floor(Math.log2(180 / (spanDeg / FOOTPRINT_TILES)));
  const z = Math.min(zRes, zFit, DETAIL_MAX_Z);
  return z >= DETAIL_MIN_Z ? z : null;
}

/** Tile window of level z centred as well as the grid allows on the looked-at point. */
export function windowFor(z: number, latDeg: number, lonDeg: number): DetailWindow {
  const s = tileDeg(z);
  const fx = (lonDeg + 180) / s, fy = (90 - latDeg) / s;
  return {
    z,
    tx: clamp(Math.round(fx - ATLAS / 2), 0, 2 ** (z + 1) - ATLAS),
    ty: clamp(Math.round(fy - ATLAS / 2), 0, 2 ** z - ATLAS),
  };
}

/**
 * Keep the current window while the looked-at point stays within half a tile of its centre (that leaves at least
 * FOOTPRINT_TILES / 2 tiles on every side, which is what the level choice assumes) and the level is unchanged, so a small
 * pan does not rebuild the atlas; otherwise a freshly centred one.
 */
export function nextWindow(current: DetailWindow | null, z: number, latDeg: number, lonDeg: number): DetailWindow {
  if (current && current.z === z) {
    const s = tileDeg(z);
    const fx = (lonDeg + 180) / s - current.tx, fy = (90 - latDeg) / s - current.ty;
    if (Math.abs(fx - ATLAS / 2) <= 0.5 && Math.abs(fy - ATLAS / 2) <= 0.5) return current;
  }
  return windowFor(z, latDeg, lonDeg);
}

/** The window's rectangle in the base map's texture coordinates: [u0, v0, u1, v1] with v = 0 at the south pole. */
export function windowBox(w: DetailWindow): [number, number, number, number] {
  const s = tileDeg(w.z);
  const u0 = (w.tx * s) / 360, u1 = ((w.tx + ATLAS) * s) / 360;
  const v1 = 1 - (w.ty * s) / 180, v0 = 1 - ((w.ty + ATLAS) * s) / 180;
  return [u0, v0, u1, v1];
}

/** The tiles of the window in atlas order (row-major), with their atlas offsets in pixels. */
export function windowTiles(w: DetailWindow): { z: number; x: number; y: number; px: number; py: number }[] {
  const out: { z: number; x: number; y: number; px: number; py: number }[] = [];
  for (let j = 0; j < ATLAS; j++) {
    for (let i = 0; i < ATLAS; i++) out.push({ z: w.z, x: w.tx + i, y: w.ty + j, px: i * TILE_PX, py: j * TILE_PX });
  }
  return out;
}

/** Latitude (geodetic, degrees) to the texture's v coordinate; the inverse of what the Earth shader computes. */
export const vOfLat = (latDeg: number): number => latDeg / 180 + 0.5;
export const uOfLon = (lonDeg: number): number => lonDeg / 360 + 0.5;
