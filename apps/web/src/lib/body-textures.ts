/**
 * Surface maps of the bodies other than the Earth and the Moon: which registry body uses which downloaded file
 * (`npm run assets`, scripts/fetch-assets.mjs, git-ignored, /textures/<file>), when the file is loaded, and how a longitude
 * lands on the map. A body without a file keeps its tinted / banded procedural look (lib/body-style.ts); a missing file
 * changes nothing.
 *
 * Every map here is simple cylindrical (equirectangular), north up, covering 360 deg of longitude and 180 deg of latitude, with the
 * IAU prime meridian (the registry rotation's x axis, packages/core/src/bodies.ts) at the centre column and east to the right,
 * i.e. the layout `createMapSphere` expects (scene/celestial.ts): u = 0.5 + eastLongitude / 360. The USGS maps get that by
 * requesting the WMS box -180..180 in the IAU 2015 east-positive planetocentric system the server's layers are declared in;
 * the Jupiter map is a plain image whose own axis (checked 2026-11) reads longitude 0 at the centre and increasing to the LEFT
 * (west-positive, System III style), so east is to the right as well. The gas giant has no surface: its cloud pattern is a 2000 snapshot
 * and the centre meridian is nominal (the IAU System III prime meridian), so the Great Red Spot sits where that map puts it,
 * not where it is today.
 */

/** How the map's columns relate to longitude. Only the first is used today; the others are for a source in another layout. */
export type MapLayout =
  /** -180..180 east, prime meridian at the centre column, east to the right (also a west-positive axis drawn with east to the right) */
  | 'centred-east'
  /** 0..360 east from the left edge */
  | 'zero-left-east'
  /** mirrored: west-positive increasing to the right, prime meridian at the centre (a view from inside; needs a flip) */
  | 'centred-west';

export interface BodyTexture {
  /** file in apps/web/public/textures */
  file: string;
  layout: MapLayout;
  /** loaded at once when the body is built (Mars, as before) instead of when its disc is `loadPx` px wide */
  eager?: boolean;
  /** one line for the README credits and docs */
  credit: string;
}

/** Disc radius, px, at which a body's map is loaded (kept until under 40 % of it, like the mesh tier: `meshWanted`). 2048 px maps are about 11 MB with mipmaps. */
export const MAP_LOAD_PX = 24;

const USGS = 'USGS Astrogeology planetary WMS';

/** Registry id to map. The sources, licences and layers are in scripts/fetch-assets.mjs and docs/models.md. */
export const BODY_TEXTURES: Readonly<Record<string, BodyTexture>> = {
  MARS: { file: 'mars.jpg', layout: 'centred-east', eager: true, credit: `${USGS} (Viking MDIM 2.1)` },
  MERCURY: { file: 'mercury.jpg', layout: 'centred-east', credit: `${USGS} (MESSENGER MDIS global mosaic)` },
  VENUS: { file: 'venus.jpg', layout: 'centred-east', credit: `${USGS} (Magellan colourised global mosaic)` },
  JUPITER: { file: 'jupiter.jpg', layout: 'centred-east', credit: 'NASA/JPL/Space Science Institute (Cassini cylindrical map PIA07782)' },
  IO: { file: 'io.jpg', layout: 'centred-east', credit: `${USGS} (Galileo/Voyager)` },
  EUROPA: { file: 'europa.jpg', layout: 'centred-east', credit: `${USGS} (Galileo/Voyager)` },
  GANYMEDE: { file: 'ganymede.jpg', layout: 'centred-east', credit: `${USGS} (Galileo/Voyager)` },
  CALLISTO: { file: 'callisto.jpg', layout: 'centred-east', credit: `${USGS} (Galileo/Voyager)` },
  MIMAS: { file: 'mimas.jpg', layout: 'centred-east', credit: `${USGS} (Cassini)` },
  ENCELADUS: { file: 'enceladus.jpg', layout: 'centred-east', credit: `${USGS} (Cassini)` },
  TETHYS: { file: 'tethys.jpg', layout: 'centred-east', credit: `${USGS} (Cassini)` },
  DIONE: { file: 'dione.jpg', layout: 'centred-east', credit: `${USGS} (Cassini/Voyager)` },
  RHEA: { file: 'rhea.jpg', layout: 'centred-east', credit: `${USGS} (Cassini/Voyager)` },
  TITAN: { file: 'titan.jpg', layout: 'centred-east', credit: `${USGS} (Cassini ISS)` },
  IAPETUS: { file: 'iapetus.jpg', layout: 'centred-east', credit: `${USGS} (Cassini/Voyager)` },
  TRITON: { file: 'triton.jpg', layout: 'centred-east', credit: `${USGS} (Voyager 2)` },
  CERES: { file: 'ceres.jpg', layout: 'centred-east', credit: `${USGS} (Dawn Framing Camera global mosaic)` },
  PLUTO: { file: 'pluto.jpg', layout: 'centred-east', credit: `${USGS} (New Horizons)` },
  CHARON: { file: 'charon.jpg', layout: 'centred-east', credit: `${USGS} (New Horizons)` },
};

/** Texture column u (0..1, left to right) of an east longitude in degrees, for a map in `layout`. */
export function textureU(eastLonDeg: number, layout: MapLayout = 'centred-east'): number {
  const wrap = (x: number) => x - Math.floor(x);
  switch (layout) {
    case 'centred-east': return wrap(0.5 + eastLonDeg / 360);
    case 'zero-left-east': return wrap(eastLonDeg / 360);
    case 'centred-west': return wrap(0.5 - eastLonDeg / 360);
  }
}

/** The map of a registry body, or undefined (it keeps the procedural look). */
export function textureOf(bodyId: string, table: Readonly<Record<string, BodyTexture>> = BODY_TEXTURES): BodyTexture | undefined {
  return table[bodyId];
}

/** The distinct credits, in table order, for the README / About text. */
export function textureCredits(): string[] {
  return [...new Set(Object.values(BODY_TEXTURES).map((t) => t.credit))];
}
