import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, TIMEOUT_MS, diagnosticHeaders, requestHeaders, withCauseCode } from '../http-util';
import { FETCH_ORDER, parseOmmJson, type SatGroup } from './celestrak';

/** A saved file younger than this is not downloaded again (CelesTrak refreshes about every 2 h and asks clients not to repeat). */
export const SEED_MAX_AGE_MS = 3 * 3600_000;

export interface SeedOptions {
  /** `data/celestrak` */
  dir: string;
  groups?: readonly SatGroup[];
  maxAgeMs?: number;
  /** download even when the saved file is recent */
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** pause before a download that follows another one (default 1 to 2 s) */
  spacingMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface SeedResult {
  /** downloaded and written */
  saved: SatGroup[];
  /** left alone: the saved file is recent enough */
  fresh: SatGroup[];
  /** the first group that failed; the rest of the run stays off the network */
  failed?: { group: SatGroup; error: string };
  /** not tried because an earlier group failed */
  skipped: SatGroup[];
}

/**
 * Downloads the CelesTrak groups into `dir/<group>.json`, the files the server falls back to when CelesTrak cannot be
 * reached from its own network (`npm run celestrak:seed`, run once on a network that can reach it, e.g. through a VPN).
 * Polite by design: a recent file is kept, downloads are spaced, and the first failure ends the run instead of trying
 * the other groups. A response that does not parse as OMM JSON never replaces a good file.
 */
export async function seedGroups(opts: SeedOptions): Promise<SeedResult> {
  const groups = opts.groups ?? FETCH_ORDER;
  const maxAge = opts.maxAgeMs ?? SEED_MAX_AGE_MS;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const spacing = opts.spacingMs ?? (() => 1000 + Math.random() * 1000);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const result: SeedResult = { saved: [], fresh: [], skipped: [] };
  mkdirSync(opts.dir, { recursive: true });
  let downloaded = false;
  for (const group of groups) {
    if (result.failed) {
      result.skipped.push(group);
      continue;
    }
    const path = join(opts.dir, `${group}.json`);
    const age = savedAge(path, now());
    if (!opts.force && age !== undefined && age < maxAge) {
      result.fresh.push(group);
      log(`${group}: saved ${Math.round(age / 60_000)} min ago, kept`);
      continue;
    }
    if (downloaded) await sleep(spacing());
    downloaded = true;
    try {
      const res = await doFetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`, {
        headers: requestHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.text();
      if (!res.ok) throw new HttpError(res.status, res.url || group, body, diagnosticHeaders(res.headers));
      const omms = parseOmmJson(body);
      if (!omms.length) throw new Error('the response holds no objects');
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, path);
      result.saved.push(group);
      log(`${group}: ${omms.length} objects saved`);
    } catch (err) {
      const error = withCauseCode(err).message;
      result.failed = { group, error };
      log(`${group}: FAILED ${error}`);
    }
  }
  return result;
}

/** Milliseconds since the file was last written, or undefined when it does not exist. */
function savedAge(path: string, now: number): number | undefined {
  try {
    return Math.max(now - statSync(path).mtimeMs, 0);
  } catch {
    return undefined;
  }
}
