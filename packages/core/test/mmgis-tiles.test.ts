import { describe, expect, it } from 'vitest';
import {
  MMGIS_LAYERS, defaultBodies, layerCoversTile, layerHasTile, mmgisTileUrlFor,lonLatOfTms, missionBbox, mmgisLayer, mmgisMapUrl, mmgisTileUrl,
  tileBounds, tmsOf,
} from '../src';
import m20 from './fixtures/mmgis-config-m20.json';
import msl from './fixtures/mmgis-config-msl.json';
import { M20_COLOR_TILEMAP } from './fixtures/mmgis-m20-color-tilemapresource';

interface ConfigLayer { name: string; type: string; url: string; tileformat: string; minZoom: number; maxNativeZoom: number; boundingBox: number[] }
const config = (m: string) => (m === 'm20' ? m20 : msl) as unknown as { msv: { radius: { major: string; minor: string } }; projection: { custom: boolean }; layers: ConfigLayer[] };

describe('MMGIS layer table against the mission configurations (trimmed real answers, 2026-11-17)', () => {
  it('every layer is a TMS tile layer of the configuration with the same folder and bounding box', () => {
    for (const l of MMGIS_LAYERS) {
      const c = config(l.mission.toLowerCase()).layers.find((x) => x.name === l.name);
      expect(c, l.name).toBeDefined();
      expect(c!.type).toBe('tile');
      expect(c!.tileformat).toBe('tms');
      expect(c!.url).toBe(`${mmgisTileUrl(l, 0, 0, 0).replace(/\/0\/0\/0\.png$/, '')}/{z}/{x}/{y}.png`);
      for (let i = 0; i < 4; i++) expect(l.bbox[i]).toBeCloseTo(c!.boundingBox[i], 8);
      expect(l.maxNativeZoom).toBe(c!.maxNativeZoom);
      // the table may only narrow the levels the configuration allows
      expect(l.minZoom).toBeGreaterThanOrEqual(c!.minZoom);
    }
  });

  it('both missions use the default projection on the registry Mars sphere', () => {
    for (const m of ['m20', 'msl']) {
      const c = config(m);
      expect(c.projection.custom).toBe(false);
      expect(Number(c.msv.radius.major) / 1000).toBe(defaultBodies.get('MARS').radiusKm);
      expect(c.msv.radius.minor).toBe(c.msv.radius.major);
    }
  });

  it('the colour basemap pyramid is EPSG:3857 / mercator with 256 px PNG tiles and the same bounding box (tilemapresource.xml)', () => {
    const xml = M20_COLOR_TILEMAP;
    expect(xml).toContain('<SRS>EPSG:3857</SRS>');
    expect(xml).toContain('profile="mercator"');
    expect(xml).toContain('<TileFormat width="256" height="256" mime-type="image/png"');
    expect(xml).toContain('href="19"');
    expect(xml).not.toContain('href="20"');
    const bb = /minx="([\d.]+)" miny="([\d.]+)" maxx="([\d.]+)" maxy="([\d.]+)"/.exec(xml)!.slice(1).map(Number);
    const l = mmgisLayer('M20', 'color')!;
    for (let i = 0; i < 4; i++) expect(l.bbox[i]).toBeCloseTo(bb[i], 8);
    // units per pixel at level 8 = the web-mercator 2 pi a / (256 2^8): the pyramid is the standard grid
    expect(Number(/href="8" units-per-pixel="([\d.]+)"/.exec(xml)![1])).toBeCloseTo((2 * Math.PI * 6378137) / 256 / 2 ** 8, 6);
  });
});

describe('TMS tile math (web mercator, row 0 at the south)', () => {
  it('round-trips lon/lat through fractional tile coordinates', () => {
    for (const z of [0, 6, 11, 19]) {
      for (const [lon, lat] of [[77.233223, 18.435594], [137.388886, -4.826023], [-179.9, 84.9], [0, 0], [179.99, -84.9]]) {
        const t = tmsOf(lon, lat, z);
        const back = lonLatOfTms(t.x, t.y, z);
        expect(back.lonDeg).toBeCloseTo(lon, 9);
        expect(back.latDeg).toBeCloseTo(lat, 9);
      }
    }
  });

  it('puts Perseverance (sol 2022 waypoint) in the two real tiles fetched at level 11 and Jezero in the north-east quadrant', () => {
    // 11/1463/1130.png and 11/1464/1130.png answered with imagery (apps/web/src/mock/fixtures/mmgis-tiles/)
    const t = tmsOf(77.233223, 18.435594, 11);
    expect([Math.floor(t.x), Math.floor(t.y)]).toEqual([1463, 1130]);
    const first = tmsOf(77.450886, 18.444627, 11);
    expect([Math.floor(first.x), Math.floor(first.y)]).toEqual([1464, 1130]);
    // row 0 is the south: the northern hemisphere has rows in the upper half
    expect(t.y).toBeGreaterThan(2 ** 10);
    // XYZ row would be 2^11 - 1 - 1130 = 917
    expect(2 ** 11 - 1 - Math.floor(t.y)).toBe(917);
  });

  it('tile bounds: neighbours share edges, level 0 is the mercator square', () => {
    const [w, s, e, n] = tileBounds(0, 0, 0);
    expect(w).toBe(-180);
    expect(e).toBe(180);
    expect(n).toBeCloseTo(85.0511287798, 8);
    expect(s).toBeCloseTo(-85.0511287798, 8);
    const a = tileBounds(11, 1463, 1130), b = tileBounds(11, 1464, 1130), up = tileBounds(11, 1463, 1131);
    expect(a[2]).toBe(b[0]);
    expect(a[3]).toBeCloseTo(up[1], 12);
    expect(a[3]).toBeGreaterThan(a[1]);
  });

  it('the configured bounding-box corners fall in the tiles the layer is said to have, and nowhere else', () => {
    for (const l of MMGIS_LAYERS) {
      const z = l.maxNativeZoom;
      for (const [lon, lat] of [[l.bbox[0], l.bbox[1]], [l.bbox[2], l.bbox[3]]]) {
        // a hair inside the corner
        const t = tmsOf(lon + (lon === l.bbox[0] ? 1e-9 : -1e-9), lat + (lat === l.bbox[1] ? 1e-9 : -1e-9), z);
        expect(layerHasTile(l, z, Math.floor(t.x), Math.floor(t.y)), `${l.mission}/${l.id}`).toBe(true);
      }
      const out = tmsOf(l.bbox[0] - 720 / 2 ** z, l.bbox[1] - 720 / 2 ** z, z); // two tiles beyond the corner
      expect(layerHasTile(l, z, Math.floor(out.x), Math.floor(out.y))).toBe(false);
    }
  });

  it('refuses levels and indices the layer does not publish', () => {
    const l = mmgisLayer('M20', 'color')!;
    expect(layerHasTile(l, 11, 1463, 1130)).toBe(true);
    expect(layerHasTile(l, 9, 731, 565)).toBe(false); // under minZoom
    expect(layerHasTile(l, 20, 0, 0)).toBe(false);
    expect(layerHasTile(l, 11, 1463.5, 1130)).toBe(false);
    expect(layerHasTile(l, 11, -1, 1130)).toBe(false);
    expect(layerHasTile(l, 11, 4096, 1130)).toBe(false);
    // the eastern level-11 tile reaches past the mosaic's east edge (77.511 E): not fully covered; the western one is
    expect(layerCoversTile(l, 11, 1464, 1130)).toBe(false);
    expect(layerCoversTile(l, 11, 1463, 1130)).toBe(true);
    const deep = tmsOf(77.3, 18.4, 16);
    expect(layerCoversTile(l, 16, Math.floor(deep.x), Math.floor(deep.y))).toBe(true);
  });

  it('builds the NASA and local addresses, the mission box and the public map link', () => {
    const l = mmgisLayer('MSL', 'gale')!;
    expect(mmgisTileUrl(l, 12, 3611, 1993)).toBe('https://mars.nasa.gov/mmgis-maps/MSL/Layers/MSL_CTX_ortho_mosaic_6m/12/3611/1993.png');
    expect(mmgisTileUrlFor(l, 12, 3611, 1993)).toBe(mmgisTileUrl(l, 12, 3611, 1993));
    expect(mmgisTileUrlFor({ mission: 'MSL', id: 'nope' }, 12, 3611, 1993)).toBeNull();
    expect(mmgisTileUrlFor(l, 2, 0, 0)).toBeNull(); // a level the layer does not publish
    expect(mmgisTileUrlFor(l, 12, 0, 0)).toBeNull(); // outside the box
    expect(mmgisTileUrlFor(l, 12, 3611.5, 1993)).toBeNull();
    expect(mmgisTileUrlFor(l, 12, -1, 1993)).toBeNull();
    expect(missionBbox('M20')![0]).toBeCloseTo(67.49927, 4);
    expect(missionBbox('XYZ')).toBeUndefined();
    expect(mmgisMapUrl('dsn-M20')).toBe('https://mars.nasa.gov/maps/?mission=M20');
    expect(mmgisMapUrl('dsn-MSL')).toBe('https://mars.nasa.gov/maps/?mission=MSL');
    expect(mmgisMapUrl('site-apollo-11')).toBeUndefined();
  });
});
