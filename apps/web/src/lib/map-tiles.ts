import {
  MIN_CONTEXT_Z, MMGIS_TILE_PX, layerCoversTile, layerHasTile, lonLatOfTms, missionBbox, mmgisLayersOf, tileBounds, tmsOf, type MmgisLayer,
} from '@eio/core';
import type { V3 } from './camera';

/**
 * The Mars surface patch (scene/surface-patch.ts), pure planning: which MMGIS tiles (core `MMGIS_LAYERS`) to draw for a camera,
 * how each tile becomes a grid on the sphere, and the texture budget. No three.js.
 *
 * Everything is in Mars body-fixed km (planetocentric, east longitude: the frame `surfaceShape` and the traverse use), so a
 * tile corner lands where the waypoint layer puts the rover. The tiles form a quadtree from level `MIN_CONTEXT_Z` over the
 * mission's layers: a tile is split while it would cover more than `TILE_TARGET_PX` screen pixels and a layer still has a finer
 * level there, nearest (largest on screen) first, until `MAX_TILES` leaves. Tiles beyond the horizon or outside the view cone
 * are dropped. Each leaf is drawn with the sharpest layer that covers it whole plus, above it, the sharper ones that cover part
 * of it (their PNG is transparent outside the mosaic); a leaf finer than a layer's last level shows a part of that level's tile.
 */

/** split a tile while it would be drawn larger than this, px (a 256 px tile is then shown at 192 to 384 px) */
export const TILE_TARGET_PX = 384;
/** most leaves drawn at once */
export const MAX_TILES = 48;
/** most textures held (the leaves plus the coarser tiles kept as stand-ins while finer ones load) */
export const MAX_TEXTURES = 96;
/** most tile downloads at once */
export const MAX_IN_FLIGHT = 6;
/** grid cells per tile side (sag of a level-6 tile's cell: 3 m) */
export const GRID_N = 16;
/** the patch lies this far over the sphere (the globe's facets are under it; log-depth precision at 600 km is about 1 m), km */
export const PATCH_LIFT_KM = 0.003;
/** each layer drawn over another one is lifted this much more, km (the traverse line is at 10 m: above all of them) */
export const STACK_LIFT_KM = 0.002;
/** the patch fades in between these camera altitudes, km */
export const FADE_FAR_KM = 600;
export const FADE_NEAR_KM = 250;

const DEG = Math.PI / 180;

export interface PatchView {
  /** camera position, Mars body-fixed, km */
  cam: V3;
  /** view direction, body-fixed, unit */
  dir: V3;
  fovDeg: number;
  aspect: number;
  /** height of the drawing buffer, px */
  viewportPx: number;
  radiusKm: number;
}

/** One drawn tile: the leaf's place and the texture shown on it (the leaf itself, or an ancestor at the layer's last level). */
export interface TileDraw {
  /** unique per drawn mesh */
  key: string;
  /** the leaf (grid) */
  z: number;
  x: number;
  y: number;
  layer: MmgisLayer;
  /** the texture tile */
  tz: number;
  tx: number;
  ty: number;
  /** 0 = bottom of the leaf's stack */
  stack: number;
  /** screen size of the leaf, px (priority: largest first) */
  px: number;
}

export const texKey = (layer: Pick<MmgisLayer, 'mission' | 'id'>, z: number, x: number, y: number): string => `${layer.mission}/${layer.id}/${z}/${x}/${y}`;

/** Body-fixed point (km) at longitude / latitude (degrees) on the sphere of radius r. */
export function fixedOf(lonDeg: number, latDeg: number, r: number): V3 {
  const lon = lonDeg * DEG, lat = latDeg * DEG, c = Math.cos(lat);
  return [r * c * Math.cos(lon), r * c * Math.sin(lon), r * Math.sin(lat)];
}

/** Longitude, latitude (degrees) and height over the sphere (km) of a body-fixed point. */
export function lonLatAlt(p: V3, r: number): { lonDeg: number; latDeg: number; altKm: number } {
  const n = Math.hypot(p[0], p[1], p[2]);
  return { lonDeg: Math.atan2(p[1], p[0]) / DEG, latDeg: Math.asin(n ? p[2] / n : 0) / DEG, altKm: n - r };
}

/** Opacity of the patch at a camera altitude: 0 over `FADE_FAR_KM`, 1 under `FADE_NEAR_KM`, smooth in between. */
export function patchOpacity(altKm: number): number {
  const t = Math.min(1, Math.max(0, (FADE_FAR_KM - altKm) / (FADE_FAR_KM - FADE_NEAR_KM)));
  return t * t * (3 - 2 * t);
}

/**
 * The mission whose maps are under the camera, or null: the camera is lower than `FADE_FAR_KM` and its ground point lies within
 * the mission's layers (widened by the ground distance the camera can see, so the patch is there before the view reaches it).
 */
export function missionUnder(lonDeg: number, latDeg: number, altKm: number, radiusKm: number, missions: readonly string[] = ['M20', 'MSL']): string | null {
  if (altKm >= FADE_FAR_KM) return null;
  const marginDeg = Math.acos(radiusKm / (radiusKm + Math.max(altKm, 0))) / DEG;
  for (const m of missions) {
    const b = missionBbox(m);
    if (!b) continue;
    const mLon = marginDeg / Math.max(0.1, Math.cos(latDeg * DEG));
    if (lonDeg >= b[0] - mLon && lonDeg <= b[2] + mLon && latDeg >= b[1] - marginDeg && latDeg <= b[3] + marginDeg) return m;
  }
  return null;
}

interface Node {
  z: number;
  x: number;
  y: number;
  px: number;
  /** a layer has a finer level here */
  deeper: boolean;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/** Screen size (px) of a tile, or -1 when it cannot be seen (beyond the horizon, outside the view cone). */
export function tileScreenPx(z: number, x: number, y: number, v: PatchView): number {
  const c = lonLatOfTms(x + 0.5, y + 0.5, z);
  const centre = fixedOf(c.lonDeg, c.latDeg, v.radiusKm);
  // a mercator tile is square on the ground: 2 pi R cos(lat) / 2^z on a side
  const edge = (2 * Math.PI * v.radiusKm * Math.cos(c.latDeg * DEG)) / 2 ** z;
  const half = edge * 0.75; // centre to corner, with room for the curvature
  const camR = len(v.cam);
  // horizon: the angle from the camera's ground point to the tile centre must be under the horizon angle plus the tile's own
  const horizon = Math.acos(Math.min(1, v.radiusKm / camR));
  const ang = Math.acos(Math.max(-1, Math.min(1, dot(v.cam, centre) / (camR * v.radiusKm))));
  if (ang - half / v.radiusKm > horizon) return -1;
  const d = sub(centre, v.cam);
  const dist = len(d);
  // view cone: the half diagonal of the field of view, plus the tile's angular radius
  const tanHalf = Math.tan((v.fovDeg * DEG) / 2);
  const coneHalf = Math.atan(tanHalf * Math.hypot(1, v.aspect));
  const off = Math.acos(Math.max(-1, Math.min(1, dot(d, v.dir) / (dist || 1))));
  if (dist > half && off - Math.asin(Math.min(1, half / dist)) > coneHalf) return -1;
  const near = Math.max(dist - half, 1e-3);
  return (edge / near) * (v.viewportPx / (2 * tanHalf));
}

/** The leaves to draw for a view, each with its layer stack, largest on screen first. Empty when the mission has no layers. */
export function selectTiles(mission: string, v: PatchView, maxTiles = MAX_TILES, targetPx = TILE_TARGET_PX): TileDraw[] {
  const layers = mmgisLayersOf(mission);
  const box = missionBbox(mission);
  if (!layers.length || !box) return [];
  const node = (z: number, x: number, y: number): Node | null => {
    const b = tileBounds(z, x, y);
    // some layer has imagery here, and some has a finer level
    const over = layers.filter((l) => overlaps(b, l.bbox));
    if (!over.length) return null;
    const px = tileScreenPx(z, x, y, v);
    return px < 0 ? null : { z, x, y, px, deeper: over.some((l) => z + 1 <= l.maxNativeZoom) };
  };
  const z0 = MIN_CONTEXT_Z;
  const sw = tmsOf(box[0], box[1], z0), ne = tmsOf(box[2], box[3], z0);
  let leaves: Node[] = [];
  for (let x = Math.floor(sw.x); x <= Math.floor(ne.x); x++) {
    for (let y = Math.floor(sw.y); y <= Math.floor(ne.y); y++) {
      const n = node(z0, x, y);
      if (n) leaves.push(n);
    }
  }
  for (;;) {
    let best = -1;
    for (let i = 0; i < leaves.length; i++) {
      const n = leaves[i];
      if (n.deeper && n.px > targetPx && (best < 0 || n.px > leaves[best].px)) best = i;
    }
    if (best < 0) break;
    const p = leaves[best];
    const kids: Node[] = [];
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const k = node(p.z + 1, p.x * 2 + dx, p.y * 2 + dy);
      if (k) kids.push(k);
    }
    if (leaves.length - 1 + kids.length > maxTiles) break;
    leaves = [...leaves.slice(0, best), ...kids, ...leaves.slice(best + 1)];
  }
  leaves.sort((a, b) => b.px - a.px);
  const out: TileDraw[] = [];
  for (const n of leaves) out.push(...stackFor(n, layers));
  return out;
}

/** The layers drawn on one leaf, bottom first: the sharpest that covers it whole, then the sharper ones that cover part of it. */
function stackFor(n: Node, layers: readonly MmgisLayer[]): TileDraw[] {
  const top: MmgisLayer[] = [];
  for (const l of layers) {
    if (n.z < l.minZoom) continue;
    const tz = Math.min(n.z, l.maxNativeZoom), k = n.z - tz;
    if (!layerHasTile(l, tz, n.x >> k, n.y >> k) || !overlaps(tileBounds(n.z, n.x, n.y), l.bbox)) continue;
    top.push(l);
    if (layerCoversTile(l, n.z, n.x, n.y)) break;
  }
  return top.reverse().map((l, stack) => {
    const tz = Math.min(n.z, l.maxNativeZoom), k = n.z - tz;
    return { key: `${n.z}/${n.x}/${n.y}/${l.id}`, z: n.z, x: n.x, y: n.y, layer: l, tz, tx: n.x >> k, ty: n.y >> k, stack, px: n.px };
  });
}

const overlaps = (a: readonly number[], b: readonly number[]): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/**
 * The part of texture tile (tz, tx, ty) that covers leaf (z, x, y), as [u0, v0, size] in the texture's uv (v = 0 at the south
 * edge, as the PNG is drawn with its first row north): the whole texture for the leaf itself, a 2^-(z - tz) square of an ancestor.
 */
export function uvRect(z: number, x: number, y: number, tz: number, tx: number, ty: number): [number, number, number] {
  const k = z - tz, s = 2 ** -k;
  return [(x - tx * 2 ** k) * s, (y - ty * 2 ** k) * s, s];
}

/** The coarser tiles of the same layer that can stand in for (tz, tx, ty) while it loads, nearest first. */
export function* ancestors(layer: MmgisLayer, tz: number, tx: number, ty: number): Generator<[number, number, number]> {
  for (let z = tz - 1; z >= layer.minZoom; z--) {
    const k = tz - z;
    yield [z, tx >> k, ty >> k];
  }
}

/** a tile still loading is covered meanwhile by its ancestor this many levels up (one download for up to 64 leaves) */
export const STAND_IN_LEVELS = 3;

export type TexState = 'ready' | 'loading' | 'failed' | undefined;

/**
 * The texture to fetch so that a draw has something to show while its own tile is missing, or null: nothing while a coarser one
 * is ready; for a tile still loading (or not asked yet) its ancestor `STAND_IN_LEVELS` up; for a tile that failed (none at the
 * server, or none in the mock) the nearest ancestor that has not failed.
 */
export function standIn(d: Pick<TileDraw, 'layer' | 'tz' | 'tx' | 'ty'>, state: (key: string) => TexState): string | null {
  const own = state(texKey(d.layer, d.tz, d.tx, d.ty));
  if (own === 'ready') return null;
  const up = [...ancestors(d.layer, d.tz, d.tx, d.ty)].map(([z, x, y]) => texKey(d.layer, z, x, y));
  if (up.some((k) => state(k) === 'ready')) return null;
  if (own === 'failed') return up.find((k) => state(k) !== 'failed') ?? null;
  return up[Math.min(STAND_IN_LEVELS, up.length) - 1] ?? null;
}

export interface TileGrid {
  /** the tile centre on the sphere, body-fixed km (float64) */
  centre: V3;
  /** (n+1)^2 vertices relative to `centre`, km */
  position: Float32Array;
  /** unit radial direction, body-fixed */
  normal: Float32Array;
  /** u east, v north, 0..1 over the tile */
  uv: Float32Array;
  index: Uint16Array;
}

/**
 * The tile as a grid on the sphere of radius `r`: vertices evenly spaced in tile (mercator) coordinates, so the image maps
 * linearly onto them; positions relative to the tile centre (kept in float64 by the caller), so float32 holds them to a centimetre.
 */
export function tileGrid(z: number, x: number, y: number, r: number, n = GRID_N): TileGrid {
  const c = lonLatOfTms(x + 0.5, y + 0.5, z);
  const centre = fixedOf(c.lonDeg, c.latDeg, r);
  const m = n + 1;
  const position = new Float32Array(m * m * 3), normal = new Float32Array(m * m * 3), uv = new Float32Array(m * m * 2);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const p = lonLatOfTms(x + i / n, y + j / n, z);
      const q = fixedOf(p.lonDeg, p.latDeg, r);
      const k = j * m + i;
      position[k * 3] = q[0] - centre[0];
      position[k * 3 + 1] = q[1] - centre[1];
      position[k * 3 + 2] = q[2] - centre[2];
      normal[k * 3] = q[0] / r;
      normal[k * 3 + 1] = q[1] / r;
      normal[k * 3 + 2] = q[2] / r;
      uv[k * 2] = i / n;
      uv[k * 2 + 1] = j / n;
    }
  }
  const index = new Uint16Array(n * n * 6);
  let o = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * m + i, b = a + 1, c2 = a + m, d = c2 + 1;
      // counter-clockwise seen from outside (east = +u, north = +v)
      index.set([a, b, d, a, d, c2], o);
      o += 6;
    }
  }
  return { centre, position, normal, uv, index };
}

/** Keys to drop to get back under `cap`: least recently used first, never one in `keep`. */
export function evictions(entries: Iterable<[string, { used: number }]>, keep: ReadonlySet<string>, cap: number): string[] {
  const all = [...entries];
  if (all.length <= cap) return [];
  return all.filter(([k]) => !keep.has(k)).sort((a, b) => a[1].used - b[1].used).slice(0, all.length - cap).map(([k]) => k);
}

/** Texture keys to start loading now: wanted order, skipping those held or loading, up to `maxInFlight` loads in total. */
export function requestsFor(wanted: readonly string[], held: (key: string) => boolean, inFlight: number, maxInFlight = MAX_IN_FLIGHT): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of wanted) {
    if (inFlight + out.length >= maxInFlight) break;
    if (seen.has(k) || held(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** GPU bytes of `n` tile textures with mipmaps (RGBA8). */
export const textureBytes = (n: number): number => Math.round((n * MMGIS_TILE_PX * MMGIS_TILE_PX * 4 * 4) / 3);
