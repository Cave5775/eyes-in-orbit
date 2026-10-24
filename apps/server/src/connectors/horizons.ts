import type { Sample } from '@eio/core';
import type { Connector } from '../connector';
import { DEFAULT_HORIZONS, DSN_TARGETS, horizonsSpecOf, probeEntity, probeId, type HorizonsSpec } from './dsn-targets';

const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const TTL_MS = 23 * 3600_000;
const REFRESH_MS = 12 * 3600_000;
const DELAY_MS = 1500;
const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;
const JD_UNIX_EPOCH = 2440587.5;
/** Horizons tags rows in TDB; TDB - UTC is TAI-UTC (37 s) + 32.184 s */
const TDB_MINUS_UTC_MS = 69_184;

/**
 * Default data window around the fetch time, in days (`DEFAULT_HORIZONS`). The top bar's time fields reach days
 * away from now, so the window is wider than the default view needs: 481 rows per target at 30 min steps, still a
 * small payload. A target may override centre, frame, body, step and window in `dsn-targets.ts` (LRO: Moon centre,
 * 5 min steps, -1 d .. +3 d = 1153 rows; Horizons allows ~90 000 rows per request, the 1.5 s spacing below applies
 * to every request).
 */
export const HORIZONS_PAST_DAYS = DEFAULT_HORIZONS.pastDays;
export const HORIZONS_FUTURE_DAYS = DEFAULT_HORIZONS.futureDays;
/** Part of the cache key (together with target, centre, step and window): bump on any change of what is requested or how it is read. */
const CACHE_VERSION = 'v2';

/** Cache key of one target's ephemeris: includes centre, step and window so a changed request never reuses older data. */
export function horizonsCacheKey(horizonsId: string, spec: HorizonsSpec = DEFAULT_HORIZONS): string {
  return `horizons:${CACHE_VERSION}:${horizonsId}:${spec.center}:${spec.stepMin}m:-${spec.pastDays}d+${spec.futureDays}d`;
}

/**
 * Horizons API query: ICRF vectors (km, km/s) relative to `spec.center`, CSV, `spec.stepMin` steps over
 * [hour - pastDays, hour + futureDays]. Without a spec: geocentric, 30 min steps, -3 d .. +7 d.
 */
export function horizonsUrl(horizonsId: string, nowMs: number, spec: HorizonsSpec = DEFAULT_HORIZONS): string {
  const hour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const q = new URLSearchParams({
    format: 'json',
    COMMAND: `'${horizonsId}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: `'${spec.center}'`,
    REF_PLANE: 'FRAME',
    START_TIME: `'${fmt(hour - spec.pastDays * DAY_MS)}'`,
    STOP_TIME: `'${fmt(hour + spec.futureDays * DAY_MS)}'`,
    STEP_SIZE: `'${spec.stepMin} m'`,
    VEC_TABLE: '2',
    CSV_FORMAT: 'YES',
    OUT_UNITS: 'KM-S',
  });
  return `${API}?${q}`;
}

/**
 * Parse a Horizons JSON response whose `result` text holds a CSV table between $$SOE and $$EOE:
 * `JDTDB, Calendar Date (TDB), X, Y, Z, VX, VY, VZ,`. Returns `[tMs, x, y, z, vx, vy, vz]` samples.
 */
export function parseHorizonsVectors(text: string): Sample[] {
  const result: string = JSON.parse(text).result ?? '';
  const start = result.indexOf('$$SOE'), end = result.indexOf('$$EOE');
  if (start < 0 || end < 0) throw new Error(`no ephemeris in Horizons response: ${result.trim().slice(0, 200)}`);
  const samples = result.slice(start + 5, end).split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const c = line.split(',').map((x) => x.trim());
    const t = Math.round((Number(c[0]) - JD_UNIX_EPOCH) * DAY_MS - TDB_MINUS_UTC_MS);
    return [t, ...c.slice(2, 8).map(Number)];
  });
  if (samples.length < 2 || samples.some((s) => s.some((x) => !Number.isFinite(x)))) throw new Error('malformed Horizons vector table');
  return samples;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const horizons: Connector = {
  id: 'horizons',
  intervalMs: REFRESH_MS,
  startDelayMs: 4000,
  async run(ctx) {
    const failed: string[] = [];
    let cached = 0, n = 0;
    for (const [code, target] of Object.entries(DSN_TARGETS)) {
      try {
        const spec = horizonsSpecOf(target);
        const res = await ctx.cachedFetch(horizonsCacheKey(target.horizons, spec), horizonsUrl(target.horizons, Date.now(), spec), TTL_MS, parseHorizonsVectors);
        const prev = ctx.hub.graph.get(probeId(code)) ?? probeEntity(code);
        ctx.hub.upsert({ ...prev, bodyId: spec.bodyId, provider: { type: 'sampled', frame: spec.frame, samples: res.value } });
        n++;
        if (res.fromCache) cached++;
        else await sleep(DELAY_MS);
      } catch (err) {
        failed.push(`${code}: ${(err as Error).message.slice(0, 100)}`);
        if (ctx.http.offline) continue;
        await sleep(DELAY_MS);
      }
    }
    if (!n) throw new Error(`no ephemerides: ${failed[0]}`);
    ctx.log(`${n} ephemerides (${cached} cached)${failed.length ? `, failed: ${failed.join('; ')}` : ''}`);
    if (failed.length) {
      ctx.health.note = `${failed.length} targets failed: ${failed.join('; ')}`;
      ctx.softFail(failed[0], 60 * 60_000);
    }
  },
};
