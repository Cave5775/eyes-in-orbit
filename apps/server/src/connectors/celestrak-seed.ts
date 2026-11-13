import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, TIMEOUT_MS, diagnosticHeaders, requestHeaders, withCauseCode } from '../http-util';
import { guardedFetch } from '../net/guarded-fetch';
import type { Limiter } from '../net/limiter';
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
  /** every download passes this limiter (source `celestrak`: 2 s spacing, 15 requests per hour, blocks persist across runs) */
  limiter: Limiter;
  fetchImpl?: typeof fetch;
  now?: () => number;
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
  const log = opts.log ?? (() => {});
  const result: SeedResult = { saved: [], fresh: [], skipped: [] };
  mkdirSync(opts.dir, { recursive: true });
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
    try {
      const r = await guardedFetch(opts.limiter, 'celestrak', `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`, {
        headers: requestHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }, { mode: 'poll', fetch: opts.fetchImpl });
      if ('limited' in r) throw new Error(`rate limited until ${new Date(r.retryAt).toISOString().slice(11, 16)}Z (${r.reason})`);
      const res = r.response;
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
