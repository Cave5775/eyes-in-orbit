import type { Connector } from '../scheduler';
import { parseTrajectory, type Trajectory } from '../trajectory';
import { syncLaunchEntities } from './launchlibrary';

/**
 * The trajectory files bundled with the app (`data/trajectories/*.json|csv`, read at build time; the glob is relative to this
 * file; `*.local.*` files are git-ignored private ones and are never bundled). A file added or changed there is picked up by the next build, not while the app runs.
 */
const BUNDLED = import.meta.glob(['../../../../../data/trajectories/*.{json,csv}', '!../../../../../data/trajectories/*.local.*'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Parse files given as `path -> text` (`*.json|csv`, in file-name order); broken files are reported, not fatal. */
export function loadTrajectories(files: Record<string, string>): { trajectories: Trajectory[]; errors: string[]; signature: string } {
  const trajectories: Trajectory[] = [], errors: string[] = [];
  const names = Object.keys(files).filter((p) => /\.(json|csv)$/i.test(p)).sort((a, b) => (baseName(a) < baseName(b) ? -1 : baseName(a) > baseName(b) ? 1 : 0));
  const signature = names.map((p) => `${baseName(p)}:${files[p].length}`).join('|');
  for (const p of names) {
    try {
      trajectories.push(parseTrajectory(files[p], baseName(p)));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { trajectories, errors, signature };
}

/**
 * Flight Club style trajectory files bundled with the app. They attach to LL2 launches by id or name (see `trajectory.ts` for the
 * format) and turn the launch entity into a pad -> ascent composite.
 */
export function createFlightclub(files: Record<string, string> = BUNDLED): Connector {
  let lastSignature: string | undefined;
  return {
    id: 'flightclub',
    intervalMs: 30_000,
    startDelayMs: 200,
    network: false,
    async run(ctx) {
      const { trajectories, errors, signature } = loadTrajectories(files);
      ctx.health.note = `${trajectories.length} trajectory file(s)${errors.length ? `; ignored: ${errors.join('; ')}` : ''}`;
      if (signature === lastSignature) return;
      lastSignature = signature;
      ctx.hub.trajectories = trajectories;
      syncLaunchEntities(ctx.hub);
    },
  };
}

export const flightclub: Connector = createFlightclub();
