// Downloads optional runtime assets. The web app works without them (procedural Earth fallback).
//   npm run assets
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `minWidth` guards against image services that answer with a small preview instead of the full image.
const ASSETS = [
  {
    // three.js example texture derived from NASA Blue Marble imagery (public domain source data)
    url: 'https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg',
    out: 'apps/web/public/textures/earth.jpg',
    minBytes: 50_000,
    minWidth: 2000,
  },
  {
    // three.js example texture of the Moon (equirectangular, from NASA LRO imagery); used by the Moon view
    url: 'https://threejs.org/examples/textures/planets/moon_1024.jpg',
    out: 'apps/web/public/textures/moon.jpg',
    minBytes: 50_000,
    minWidth: 1000,
  },
  {
    // NASA Blue Marble Next Generation (topography and bathymetry, August), resized by NASA's image service from the
    // 21600 x 10800 original (500 m per pixel at the equator) to 8192 x 4096 (4.9 km per texel). The scene prefers this file
    // over earth.jpg and scales it down on GPUs with a smaller texture limit; it takes about 180 MB of video memory with
    // mipmaps. The service returns a 1280 x 640 preview unless the size is requested, and refuses sizes above 8192.
    // NASA imagery is generally free to use; check NASA's media usage guidelines. EARTH_HIRES_URL swaps in any other
    // equirectangular JPEG (a 4096 x 2048 map for a small GPU, say).
    url: process.env.EARTH_HIRES_URL
      ?? 'https://assets.science.nasa.gov/dynamicimage/assets/science/esd/eo/images/bmng/bmng-topography-bathymetry/august/world.topo.bathy.200408.3x21600x10800.jpg?w=8192&h=4096',
    out: 'apps/web/public/textures/earth-hires.jpg',
    minBytes: 500_000,
    minWidth: 4000,
  },
];

/** Pixel size from the first start-of-frame marker of a JPEG, or null when none is found. */
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

for (const a of ASSETS) {
  const dest = resolve(root, a.out);
  try {
    const res = await fetch(a.url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(`response is not a JPEG (${res.headers.get('content-type') ?? 'unknown type'}, ${buf.length} bytes)`);
    const size = jpegSize(buf);
    if (buf.length < a.minBytes) throw new Error(`image is only ${(buf.length / 1024).toFixed(0)} KiB${size ? ` (${size.w} x ${size.h})` : ''}, expected at least ${(a.minBytes / 1024).toFixed(0)} KiB`);
    if (size && size.w < a.minWidth) throw new Error(`image is ${size.w} x ${size.h}, expected at least ${a.minWidth} px wide (the server may have sent a preview)`);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    console.log(`ok   ${a.out} (${(buf.length / 1024).toFixed(0)} KiB${size ? `, ${size.w} x ${size.h}` : ''})`);
  } catch (err) {
    console.warn(`skip ${a.out}: ${err instanceof Error ? err.message : err}`);
    console.warn('     The app falls back to a lower-resolution or procedural Earth; download any equirectangular JPG to that path to override.');
  }
}
