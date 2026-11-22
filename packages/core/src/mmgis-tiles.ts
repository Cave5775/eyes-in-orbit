import { surfaceSiteOf } from './surface-sites';

/**
 * Map tiles of the NASA rover maps (MMGIS, https://github.com/NASA-AMMOS/MMGIS) as ONE cited table, shared by the server's tile
 * route (its allow-list: nothing else is ever fetched) and the web's surface patch (which tiles exist where, at which levels).
 *
 * Read 2026-11-17 from the mission configurations https://mars.nasa.gov/maps/api/configure/get?mission=M20 and ?mission=MSL
 * (trimmed copies in packages/core/test/fixtures/mmgis-config-*.json; the test checks this table against them). Both say
 * `projection.custom: false` and a sphere of 3396190 m (`msv.radius`, the registry's Mars radius), so the layers are MMGIS's
 * default web-mercator pyramids: the M20 colour basemap's `tilemapresource.xml` (fixture `mmgis-m20-color-tilemapresource.ts`)
 * says SRS EPSG:3857, profile `mercator`, 256 px PNG tiles, levels 8 to 19. `tileformat: tms` means row 0 is the SOUTH edge
 * (y flipped against the XYZ scheme). Longitude is planetocentric east, latitude planetocentric: the convention of the traverse
 * and of `surfaceShape`, so a tile corner lands on the sphere where the waypoint layer puts the rover.
 *
 * Levels: `minZoom` / `maxNativeZoom` from the configuration (MMGIS draws no tile below `minZoom` and upsamples above
 * `maxNativeZoom`), narrowed where the configuration says 0: the context layers start at level 6 (`MIN_CONTEXT_Z`, the patch never wants
 * anything coarser) and the grayscale HiRISE mosaic at 10 like the colour one (a 37 km mosaic has nothing to show coarser than that).
 */

export type MmgisMission = 'M20' | 'MSL';

export interface MmgisLayer {
  mission: MmgisMission;
  /** short id of the layer (with the mission it names the layer in `mmgisTileUrlFor`) */
  id: string;
  /** the layer's name in the MMGIS configuration */
  name: string;
  /** the folder under https://mars.nasa.gov/mmgis-maps/<mission>/Layers/ (the configuration's `url` without `/{z}/{x}/{y}.png`) */
  dir: string;
  minZoom: number;
  maxNativeZoom: number;
  /** [west, south, east, north], degrees (the configuration's `boundingBox`) */
  bbox: readonly [number, number, number, number];
  /** who made the imagery, for the credits */
  credit: string;
}

export const MMGIS_TILE_BASE = 'https://mars.nasa.gov/mmgis-maps';
export const MMGIS_TILE_PX = 256;
/** the coarsest level the patch asks of any layer */
export const MIN_CONTEXT_Z = 6;

const HIRISE = 'NASA/JPL-Caltech/University of Arizona (MRO HiRISE)';
const CTX = 'NASA/JPL-Caltech/MSSS (MRO CTX)';

/** Layers in order of preference per mission: the first that covers a place wins (the sharpest first). */
export const MMGIS_LAYERS: readonly MmgisLayer[] = [
  {
    mission: 'M20', id: 'color', name: 'Color Basemap', dir: 'M20_HiRISE_RGB_CTX_mosaic_25cm_v7_Merge_LERC_clip',
    minZoom: 10, maxNativeZoom: 19, bbox: [77.15751489, 18.23712426, 77.51146566, 18.52055001], credit: `${HIRISE}, ${CTX}`,
  },
  {
    mission: 'M20', id: 'gray', name: 'Grayscale Basemap', dir: 'JEZ_hirise_soc_007_orthoMosaic_25cm_Ortho_blend120',
    minZoom: 10, maxNativeZoom: 18, bbox: [77.22301769118585, 18.30679609379406, 77.58390755795912, 18.66935502209909], credit: HIRISE,
  },
  {
    mission: 'M20', id: 'syrtis', name: 'Northeast Syrtis Base Map', dir: 'HMC_13E10_co5_colorcorrect_rect',
    minZoom: MIN_CONTEXT_Z, maxNativeZoom: 12, bbox: [67.49927040089868, 14.99999904610347, 78.74915542839875, 30.00056617658278], credit: 'ESA/DLR/FU Berlin (Mars Express HRSC; HMC 13E10 quadrangle mosaic, per the layer name)',
  },
  {
    mission: 'MSL', id: 'color', name: 'Basemap', dir: 'MSL_Gale_HiRISE-LRGB_78quads',
    minZoom: 10, maxNativeZoom: 18, bbox: [137.32672354505786, -4.87560429259321, 137.4785574965306, -4.55506331169111], credit: HIRISE,
  },
  {
    mission: 'MSL', id: 'gale', name: 'Gale Crater Map', dir: 'MSL_CTX_ortho_mosaic_6m',
    minZoom: MIN_CONTEXT_Z, maxNativeZoom: 13, bbox: [135.97876221689464, -7.84409099977539, 139.48590357790334, -3.39706499423008], credit: CTX,
  },
];

export const mmgisLayersOf = (mission: string): MmgisLayer[] => MMGIS_LAYERS.filter((l) => l.mission === mission);
export const mmgisLayer = (mission: string, id: string): MmgisLayer | undefined => MMGIS_LAYERS.find((l) => l.mission === mission && l.id === id);

/** [west, south, east, north] of all layers of a mission. */
export function missionBbox(mission: string): [number, number, number, number] | undefined {
  const ls = mmgisLayersOf(mission);
  if (!ls.length) return undefined;
  return [Math.min(...ls.map((l) => l.bbox[0])), Math.min(...ls.map((l) => l.bbox[1])), Math.max(...ls.map((l) => l.bbox[2])), Math.max(...ls.map((l) => l.bbox[3]))];
}

// ---------------------------------------------------------------------------------------------------------------- TMS math

/** Web mercator stops here (the square world). */
export const MERCATOR_MAX_LAT = 85.0511287798066;
const DEG = Math.PI / 180;

/**
 * Fractional tile coordinates of a point at level z: `x` east from 180 W, `y` north from the bottom edge (TMS), both in tiles.
 * The integer parts name the tile; the fraction is the position inside it (0 = west / south edge).
 */
export function tmsOf(lonDeg: number, latDeg: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const lat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, latDeg)) * DEG;
  const lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  const yXyz = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n;
  return { x: ((lon + 180) / 360) * n, y: n - yXyz };
}

/** Longitude and latitude (degrees) of fractional TMS coordinates at level z (the inverse of `tmsOf`). */
export function lonLatOfTms(x: number, y: number, z: number): { lonDeg: number; latDeg: number } {
  const n = 2 ** z;
  const yXyz = n - y;
  return { lonDeg: (x / n) * 360 - 180, latDeg: Math.atan(Math.sinh(Math.PI * (1 - (2 * yXyz) / n))) / DEG };
}

/** [west, south, east, north] of a TMS tile, degrees. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const sw = lonLatOfTms(x, y, z), ne = lonLatOfTms(x + 1, y + 1, z);
  return [sw.lonDeg, sw.latDeg, ne.lonDeg, ne.latDeg];
}

const overlaps = (a: readonly number[], b: readonly number[]): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const inside = (a: readonly number[], b: readonly number[]): boolean => a[0] >= b[0] && a[2] <= b[2] && a[1] >= b[1] && a[3] <= b[3];

/** Does the layer have this tile (a level it publishes, and the tile meets its bounding box)? */
export function layerHasTile(layer: MmgisLayer, z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (z < layer.minZoom || z > layer.maxNativeZoom || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return false;
  return overlaps(tileBounds(z, x, y), layer.bbox);
}

/** Does the layer cover the whole tile (no transparent edge)? */
export const layerCoversTile = (layer: MmgisLayer, z: number, x: number, y: number): boolean => inside(tileBounds(z, x, y), layer.bbox);

/** The tile's address at NASA. */
export const mmgisTileUrl = (layer: MmgisLayer, z: number, x: number, y: number): string =>
  `${MMGIS_TILE_BASE}/${layer.mission}/Layers/${layer.dir}/${z}/${x}/${y}.png`;

/**
 * The address at NASA of a tile named by mission and layer id, or null when the browser should not ask for it: an unknown
 * layer (only the cited table is ever requested), a level the layer does not publish, a tile outside its box, or
 * non-integer / negative indices (`layerHasTile`). NASA sends `Access-Control-Allow-Origin: *`, so the browser loads it directly.
 */
export function mmgisTileUrlFor(layer: Pick<MmgisLayer, 'mission' | 'id'>, z: number, x: number, y: number): string | null {
  if (![z, x, y].every(Number.isInteger)) return null;
  const l = mmgisLayer(layer.mission, layer.id);
  return l && layerHasTile(l, z, x, y) ? mmgisTileUrl(l, z, x, y) : null;
}

/** The mission's public MMGIS map (no deep-link parameters: the ones MMGIS reads could not be confirmed), or undefined. */
export function mmgisMapUrl(entityId: string): string | undefined {
  const live = surfaceSiteOf(entityId)?.live;
  return live ? `https://mars.nasa.gov/maps/?mission=${live}` : undefined;
}
