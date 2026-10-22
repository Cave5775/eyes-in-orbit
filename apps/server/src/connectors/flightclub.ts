import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Connector } from '../connector';
import { parseTrajectory, type Trajectory } from '../trajectory';
import { syncLaunchEntities } from './launchlibrary';

/** Load every `*.json|csv` in a directory; broken files are reported, not fatal. */
export function loadTrajectories(dir: string): { trajectories: Trajectory[]; errors: string[]; signature: string } {
  const trajectories: Trajectory[] = [], errors: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.(json|csv)$/i.test(f)).sort();
  } catch { /* no directory: nothing to load */ }
  const signature = files.map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`).join('|');
  for (const f of files) {
    try {
      trajectories.push(parseTrajectory(readFileSync(join(dir, f), 'utf8'), f));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { trajectories, errors, signature };
}

let lastSignature: string | undefined;

/**
 * Flight Club style trajectory files dropped into `data/trajectories/`. They attach to LL2 launches
 * by id or name (see `trajectory.ts` for the format) and turn the launch entity into a pad -> ascent composite.
 */
export const flightclub: Connector = {
  id: 'flightclub',
  intervalMs: 30_000,
  startDelayMs: 200,
  network: false,
  async run(ctx) {
    const { trajectories, errors, signature } = loadTrajectories(join(ctx.config.dataDir, 'trajectories'));
    ctx.health.note = `${trajectories.length} trajectory file(s)${errors.length ? `; ignored: ${errors.join('; ')}` : ''}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    ctx.hub.trajectories = trajectories;
    syncLaunchEntities(ctx.hub);
  },
};
