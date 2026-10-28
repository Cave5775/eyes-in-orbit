/**
 * Saves the CelesTrak groups as files for a network that cannot reach CelesTrak:
 *   npm run celestrak:seed [-- --force] [-- --groups=stations,starlink]
 * Run it ONCE on a network that can (for example with a VPN on), then start the server on the blocked network: it reads
 * `data/celestrak/<group>.json` when CelesTrak cannot be reached and the cache is older than the file.
 * A file younger than 3 h is kept (CelesTrak refreshes about every 2 h and asks clients not to repeat), downloads are spaced
 * 1 to 2 s apart and the first failure ends the run. `--force` downloads anyway; use it sparingly.
 */
import { join } from 'node:path';
import { loadConfig, loadDotEnv } from './config';
import { FETCH_ORDER, type SatGroup } from './connectors/celestrak';
import { seedGroups } from './connectors/celestrak-seed';

loadDotEnv();
const config = loadConfig();
const args = process.argv.slice(2);
const force = args.includes('--force');
const groupsArg = args.find((a) => a.startsWith('--groups='))?.slice('--groups='.length);
const groups = groupsArg ? (groupsArg.split(',').map((g) => g.trim()).filter(Boolean) as SatGroup[]) : undefined;
const unknown = groups?.filter((g) => !FETCH_ORDER.includes(g)) ?? [];
if (unknown.length) {
  console.error(`unknown group(s): ${unknown.join(', ')}; known: ${FETCH_ORDER.join(', ')}`);
  process.exit(2);
}

const dir = join(config.dataDir, 'celestrak');
console.log(`saving CelesTrak groups to ${dir}${force ? ' (forced)' : ''}`);
const result = await seedGroups({ dir, groups, force, log: (line) => console.log(`  ${line}`) });
console.log(`saved ${result.saved.length}, kept ${result.fresh.length} recent${result.skipped.length ? `, not tried ${result.skipped.length}` : ''}`);
if (result.failed) {
  console.log(`stopped at ${result.failed.group}: ${result.failed.error}`);
  console.log('Nothing else was requested. Run `npm run celestrak:probe` to see what CelesTrak answers from this network.');
  process.exitCode = 1;
} else {
  console.log('Done. Start the server on the blocked network: it uses these files when CelesTrak cannot be reached.');
}
