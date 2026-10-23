// Downloads optional runtime assets. The web app works without them (procedural Earth fallback).
//   npm run assets
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS = [
  {
    // three.js example texture derived from NASA Blue Marble imagery (public domain source data)
    url: 'https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg',
    out: 'apps/web/public/textures/earth.jpg',
    minBytes: 50_000,
  },
  {
    // NASA Blue Marble Next Generation (topography and bathymetry, August), 5400 x 2700. The scene prefers this file over
    // earth.jpg when the GPU can hold it. NASA imagery is generally free to use; check NASA's media usage guidelines.
    // EARTH_HIRES_URL swaps in any other equirectangular JPEG (an 8192 x 4096 map, say).
    url: process.env.EARTH_HIRES_URL ?? 'https://assets.science.nasa.gov/dynamicimage/assets/science/esd/eo/images/bmng/bmng-topography-bathymetry/august/world.topo.bathy.200408.3x5400x2700.jpg',
    out: 'apps/web/public/textures/earth-hires.jpg',
    minBytes: 500_000,
  },
];

for (const a of ASSETS) {
  const dest = resolve(root, a.out);
  try {
    const res = await fetch(a.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < a.minBytes || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('response is not a valid JPEG');
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    console.log(`ok   ${a.out} (${(buf.length / 1024).toFixed(0)} KiB)`);
  } catch (err) {
    console.warn(`skip ${a.out}: ${err instanceof Error ? err.message : err}`);
    console.warn('     The app falls back to a lower-resolution or procedural Earth; download any equirectangular JPG to that path to override.');
  }
}
