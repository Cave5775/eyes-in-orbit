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
    console.warn('     The app falls back to a procedural Earth; download any equirectangular 2k JPG to that path to override.');
  }
}
