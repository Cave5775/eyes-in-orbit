// How much would a server-side, scope-driven entity filter remove? (docs/perf.md, 'Phase 4: viewport filtering'.)
// The server does not propagate, so the most it can prune on is the orbit SHELL (perigee to apogee radius from the mean motion and
// eccentricity): an object can only be inside a ball around the camera focus if its shell meets the ball's radial range.
// Reads the real CelesTrak files in data/celestrak (offline; run 'npm run celestrak:seed' to fetch them). Run: node scripts/shell-prune-analysis.mjs
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../data/celestrak') + '/';
const all = new Map();
for (const f of fs.readdirSync(dir)) {
  const j = JSON.parse(fs.readFileSync(dir + f, 'utf8'));
  if (Array.isArray(j)) for (const o of j) if (o.MEAN_MOTION && o.NORAD_CAT_ID) all.set(o.NORAD_CAT_ID, o);
}
const MU = 398600.4418; // km^3/s^2, Earth GM (WGS84 / EGM96)
const shell = (o) => {
  const n = (o.MEAN_MOTION * 2 * Math.PI) / 86400;
  const a = Math.cbrt(MU / (n * n));
  return [a * (1 - o.ECCENTRICITY), a * (1 + o.ECCENTRICITY)];
};
const shells = [...all.values()].map(shell);
const SCOPE_FACTOR = 80, SCOPE_MIN = 100;
const radius = (dist) => Math.max(SCOPE_MIN, SCOPE_FACTOR * dist);
const views = [
  ['default Earth view (camera 24,000 km)', 0, 24000],
  ['Earth centre, camera 8,000 km', 0, 8000],
  ['follow ISS (6,780 km), camera 200 km', 6780, 200],
  ['follow ISS, camera 50 km', 6780, 50],
  ['follow ISS, camera 5 km', 6780, 5],
  ['pad close-up (6,378 km), camera 4 km', 6378, 4],
  ['follow a Starlink (6,920 km), camera 20 km', 6920, 20],
  ['follow a GPS sat (26,560 km), camera 2,000 km', 26560, 2000],
  ['follow a GEO sat (42,164 km), camera 500 km', 42164, 500],
];
console.log('catalogue:', all.size, 'objects (real CelesTrak files in data/celestrak, deduplicated by NORAD id)');
const bins = [['< 2,000 km altitude (LEO)', (s) => s[1] - 6378 < 2000], ['2,000 to 35,000 km', (s) => s[1] - 6378 >= 2000 && s[1] - 6378 < 35000], ['GEO and beyond / HEO apogee', (s) => s[1] - 6378 >= 35000]];
for (const [name, f] of bins) console.log('  ', name.padEnd(30), shells.filter(f).length);
console.log('\nview'.padEnd(50), 'scope R km'.padStart(11), 'kept by shell'.padStart(14), 'of all');
for (const [name, rf, dist] of views) {
  const R = radius(dist);
  const lo = rf - R, hi = rf + R;
  const kept = shells.filter(([rp, ra]) => ra >= lo && rp <= hi).length;
  console.log(name.padEnd(50), String(Math.round(R)).padStart(11), String(kept).padStart(14), ((100 * kept) / shells.length).toFixed(0).padStart(5) + ' %');
}
