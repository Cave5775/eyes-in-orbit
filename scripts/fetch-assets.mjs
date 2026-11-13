// Downloads optional runtime assets: the Earth map (8192 px), the Moon map and the Mars map. The web app works without them (procedural / tinted fallback).
//   npm run assets
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// An asset has one `url` or a ladder of `urls` tried in order (the first that passes the checks wins). `minWidth` guards against
// image services that answer with a small preview instead of the full image.

/** USGS Astrogeology WMS GetMap URL for the whole globe (simple cylindrical, -180..180 east, 90 S..90 N) at `width` x `width / 2` px. */
function usgsMarsUrl(width) {
  const q = new URLSearchParams({
    map: '/maps/mars/mars_simp_cyl.map', SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap', LAYERS: 'MDIM21_color',
    STYLES: '', FORMAT: 'image/jpeg', SRS: 'EPSG:4326', BBOX: '-180,-90,180,90', WIDTH: String(width), HEIGHT: String(width / 2),
  });
  return `https://planetarymaps.usgs.gov/cgi-bin/mapserv?${q}`;
}

const ASSETS = [
  {
    // three.js example texture of the Moon (equirectangular, from NASA LRO imagery); used by the Moon view
    url: 'https://threejs.org/examples/textures/planets/moon_1024.jpg',
    out: 'apps/web/public/textures/moon.jpg',
    minBytes: 50_000,
    minWidth: 1000,
  },
  {
    // NASA Blue Marble Next Generation (topography and bathymetry, August), resized by NASA's image service from the
    // 21600 x 10800 original (500 m per pixel at the equator) to 8192 x 4096 (4.9 km per texel). It is the only Earth map: the
    // scene scales it down on GPUs with a smaller texture limit (and streams finer DETAIL tiles for close views); it takes
    // about 180 MB of video memory with mipmaps. The service returns a 1280 x 640 preview unless the size is requested, and refuses sizes above 8192.
    // NASA imagery is generally free to use; check NASA's media usage guidelines. EARTH_HIRES_URL swaps in any other
    // equirectangular JPEG (a 4096 x 2048 map for a small GPU, say).
    url: process.env.EARTH_HIRES_URL
      ?? 'https://assets.science.nasa.gov/dynamicimage/assets/science/esd/eo/images/bmng/bmng-topography-bathymetry/august/world.topo.bathy.200408.3x21600x10800.jpg?w=8192&h=4096',
    out: 'apps/web/public/textures/earth-hires.jpg',
    minBytes: 500_000,
    minWidth: 4000,
  },
  {
    // Viking Mars Digital Image Mosaic 2.1 (231 m/px, colourised by NASA Ames) from the USGS Astrogeology planetary WMS: free,
    // no key, US government work (the service states no access constraints). Longitude is east-positive, centred on the prime
    // meridian (-180..180), so it is the Moon's and the Earth's map layout; the scene maps it on a sphere of Mars' equatorial radius.
    // The server refuses sizes above 4096 px (an XML error, not a JPEG), so the ladder starts at 8192 in case that limit is lifted,
    // then 4096 x 2048 (about 1.5 MB), then 2048 x 1024. MARS_URL swaps in any other equirectangular JPEG.
    urls: process.env.MARS_URL ? [process.env.MARS_URL] : [8192, 4096, 2048].map(usgsMarsUrl),
    out: 'apps/web/public/textures/mars.jpg',
    minBytes: 100_000,
    minWidth: 2000,
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

/** Same agent as the server (`apps/server/src/http-util.ts`); no personal contact detail. */
const USER_AGENT = 'EyesInOrbit/0.1 (+https://github.com/Cave5775/eyes-in-orbit)';

/** One download attempt: the validated JPEG bytes and size, or an Error saying what was wrong. */
async function download(a, url) {
  // a manual, run-once download of three static images (not a data feed): the one script allowed to call fetch outside apps/server/src/net
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(`response is not a JPEG (${res.headers.get('content-type') ?? 'unknown type'}, ${buf.length} bytes)`);
  const size = jpegSize(buf);
  if (buf.length < a.minBytes) throw new Error(`image is only ${(buf.length / 1024).toFixed(0)} KiB${size ? ` (${size.w} x ${size.h})` : ''}, expected at least ${(a.minBytes / 1024).toFixed(0)} KiB`);
  if (size && size.w < a.minWidth) throw new Error(`image is ${size.w} x ${size.h}, expected at least ${a.minWidth} px wide (the server may have sent a preview)`);
  return { buf, size };
}

for (const a of ASSETS) {
  const dest = resolve(root, a.out);
  const urls = a.urls ?? [a.url];
  const failures = [];
  let done = false;
  for (const url of urls) {
    try {
      const { buf, size } = await download(a, url);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      console.log(`ok   ${a.out} (${(buf.length / 1024).toFixed(0)} KiB${size ? `, ${size.w} x ${size.h}` : ''})`);
      done = true;
      break;
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (!done) {
    console.warn(`skip ${a.out}: ${failures.join('; ')}`);
    console.warn('     The app falls back to the procedural Earth (a tinted Mars, or the Moon without a map); download any equirectangular JPG to that path to override.');
  }
}
