import { bodyEntityRecords, bodyPeriodSec, defaultBodies, type BodyRegistry, type FrameId } from '@eio/core';
import { clearBackoff, isBackedOff, isBlockError, readBackoff, recordFailure } from '../backoff';
import type { Connector } from '../connector';
import { parseHorizonsVectors } from './horizons';

const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
/** planets move slowly: a day-old table is as good as a new one */
const TTL_MS = 24 * 3600_000;
const REFRESH_MS = 12 * 3600_000;
const DELAY_MS = 1500;
const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;
/** Part of the cache key: bump on any change of what is requested or how it is read. */
const CACHE_VERSION = 'v1';

/**
 * How one registry body's real ephemeris is requested. The vectors are relative to `center` (the body's parent, body centre
 * `500@<NAIF id>`), ICRF axes (`REF_PLANE=FRAME`), so they are in `<PARENT>:inertial`, the frame the registry hops through.
 */
export interface BodyTarget {
  /** registry id (`JUPITER`, `IO`) */
  bodyId: string;
  /** Horizons COMMAND without quotes: a NAIF id (`599` is Jupiter's BODY CENTRE; `5` would be the system barycentre) or a small-body designation (`1;`) */
  horizons: string;
  /** Horizons CENTER: `500@10` Sun body centre, `500@599` Jupiter body centre */
  center: string;
  /** `<PARENT>:inertial` */
  frame: FrameId;
  /** STEP_SIZE, minutes */
  stepMin: number;
  /** window: days before / after the fetch hour */
  pastDays: number;
  futureDays: number;
}

/** Rows of a table: both ends and the start row. */
export const targetRows = (t: Pick<BodyTarget, 'stepMin' | 'pastDays' | 'futureDays'>): number =>
  Math.floor(((t.pastDays + t.futureDays) * 1440) / t.stepMin) + 1;

/**
 * Hermite interpolation error budget. Between two samples h apart with velocities, cubic Hermite on a circle of radius R
 * with mean motion n has a worst-case position error of about R (n h)^4 / 384 (the fourth derivative of a circle is
 * R n^4; the e term adds a factor of 1 + O(e)). The steps below keep n h at or under:
 *  - moons: 2 pi / 24 = 0.26 rad (24 steps per revolution): error <= 1.2e-5 of the orbit radius (Io 5 km, Callisto 23 km,
 *    Iapetus 43 km, always far under the body radius of 1.8k-2.6k / 0.7k km),
 *  - planets and dwarf planets: 0.15 rad for Mercury and Venus (error 75-110 km), 0.05 rad or less for the rest (Mars 40 km,
 *    Jupiter 7 km, Neptune and Pluto under 100 km: 1e-5 or less of the orbit radius, a few per cent of the body radius at worst).
 * `test/horizons-bodies.test.ts` checks the budget numerically against the registry orbits.
 */
export const MOON_STEPS_PER_REV = 24;
/** each side of a moon's window: this many steps (401 rows ~ 110 kB per response, 8.3 revolutions each side) */
export const MOON_WINDOW_STEPS = 200;

const SUN_CENTRE = '500@10';
const dayMin = (d: number): number => d * 1440;
const YEAR = 365.25;

function planetTarget(bodyId: string, horizons: string, stepDays: number, halfWindowYears: number): BodyTarget {
  return {
    bodyId, horizons, center: SUN_CENTRE, frame: 'SUN:inertial',
    stepMin: dayMin(stepDays), pastDays: Math.round(halfWindowYears * YEAR), futureDays: Math.round(halfWindowYears * YEAR),
  };
}

/**
 * A moon: step = one revolution / 24 rounded to 5 minutes, window +-200 steps. The revolution is the registry's own
 * (`bodyPeriodSec`, from a and the planet's GM; within about 1 per cent of the real period).
 */
export function moonTarget(bodyId: string, horizons: string, planetNaif: string, registry: BodyRegistry = defaultBodies): BodyTarget {
  const body = registry.get(bodyId);
  const periodMin = (bodyPeriodSec(body, registry) as number) / 60;
  const stepMin = Math.max(5, Math.round(periodMin / MOON_STEPS_PER_REV / 5) * 5);
  const days = (MOON_WINDOW_STEPS * stepMin) / 1440;
  return {
    bodyId, horizons, center: `500@${planetNaif}`, frame: `${body.parentId}:inertial` as FrameId,
    stepMin, pastDays: days, futureDays: days,
  };
}

/**
 * The streamed bodies. Earth, the Moon and the Sun are not here: the Sun sits at the origin of its own frame, and the Earth
 * and the Moon keep their analytic series (`sunPositionEci`, `moonStateEci`), which are what the rest of the scene is built on.
 *
 * Planets and dwarf planets (centre = Sun body centre, frame `SUN:inertial`, window and step chosen per body, <= 366 rows):
 *   Mercury 199: 2 d, +-1 y (366 rows)       Venus 299: 5 d, +-2 y (293)      Mars 499: 10 d, +-2 y (147)
 *   Jupiter 599: 20 d, +-4 y (147)           Saturn 699: 30 d, +-10 y (244)   Uranus 799, Neptune 899: 60 d, +-10 y (122)
 *   Ceres `1;`: 10 d, +-2 y (147)           Pluto 999, Eris, Haumea, Makemake: 60 d, +-10 y (122)
 * Moons: see `moonTarget`.
 *
 * Planet BODY centres are used (599 Jupiter, not the barycentre 5): the entity is drawn at the planet, and the moons are
 * relative to it. The offset between the two is up to the planet's wobble about the system barycentre (Jupiter 7.4e5 km).
 */
export function buildBodyTargets(registry: BodyRegistry = defaultBodies): BodyTarget[] {
  const planets: BodyTarget[] = [
    planetTarget('MERCURY', '199', 2, 1),
    planetTarget('VENUS', '299', 5, 2),
    planetTarget('MARS', '499', 10, 2),
    planetTarget('JUPITER', '599', 20, 4),
    planetTarget('SATURN', '699', 30, 10),
    planetTarget('URANUS', '799', 60, 10),
    planetTarget('NEPTUNE', '899', 60, 10),
    planetTarget('CERES', '1;', 10, 2),
    planetTarget('PLUTO', '999', 60, 10),
    planetTarget('ERIS', '136199;', 60, 10),
    planetTarget('HAUMEA', '136108;', 60, 10),
    planetTarget('MAKEMAKE', '136472;', 60, 10),
  ];
  const moons: [string, string, string][] = [
    ['PHOBOS', '401', '499'], ['DEIMOS', '402', '499'],
    ['IO', '501', '599'], ['EUROPA', '502', '599'], ['GANYMEDE', '503', '599'], ['CALLISTO', '504', '599'],
    ['MIMAS', '601', '699'], ['ENCELADUS', '602', '699'], ['TETHYS', '603', '699'], ['DIONE', '604', '699'],
    ['RHEA', '605', '699'], ['TITAN', '606', '699'], ['IAPETUS', '608', '699'],
    ['MIRANDA', '705', '799'], ['ARIEL', '701', '799'], ['UMBRIEL', '702', '799'], ['TITANIA', '703', '799'], ['OBERON', '704', '799'],
    ['TRITON', '801', '899'], ['CHARON', '901', '999'],
  ];
  return [...planets, ...moons.map(([id, cmd, planet]) => moonTarget(id, cmd, planet, registry))];
}

export const BODY_TARGETS: BodyTarget[] = buildBodyTargets();

/** Cache key of one target's table: includes command, centre, step and window so a changed request never reuses older data. */
export function bodyCacheKey(t: BodyTarget): string {
  return `horizons-bodies:${CACHE_VERSION}:${t.horizons}:${t.center}:${t.stepMin}m:-${t.pastDays}d+${t.futureDays}d`;
}

/** Horizons API query for one body: ICRF vectors (km, km/s) relative to `t.center`, CSV, `t.stepMin` steps over the window around `nowMs` (floored to the hour). */
export function bodyUrl(t: BodyTarget, nowMs: number): string {
  const hour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const q = new URLSearchParams({
    format: 'json',
    COMMAND: `'${t.horizons}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: `'${t.center}'`,
    REF_PLANE: 'FRAME',
    START_TIME: `'${fmt(hour - Math.round(t.pastDays * DAY_MS))}'`,
    STOP_TIME: `'${fmt(hour + Math.round(t.futureDays * DAY_MS))}'`,
    STEP_SIZE: `'${t.stepMin} m'`,
    VEC_TABLE: '2',
    CSV_FORMAT: 'YES',
    OUT_UNITS: 'KM-S',
  });
  return `${API}?${q}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The body registry's real data stream: JPL Horizons vector tables for the planets, dwarf planets and major moons (32
 * targets, `BODY_TARGETS`). Offline first: the `bodies` connector registers every body with the analytic fallback; this
 * one REPLACES only the provider of the same `body-*` entity: `{type:'body', bodyId, ephemeris:{frame, samples}}`, so the id,
 * kind, parent and hierarchy stay. The provider keeps type `body` on purpose (all the web's body handling, `bodyOf`,
 * `isBodyEntity`, `entityRank`, the orbit lines, keys off it); core's `BodyProvider` installs the samples in the body
 * registry (`setBodyStream`), where they replace the Kepler orbit inside the window.
 *
 * Per target soft failures (the others carry on), a persistent per-target backoff (SQLite), a block error (HTTP 403/429,
 * unreachable host) ends the run, requests are 1.5 s apart, cache TTL 24 h, refresh every 12 h. Under OFFLINE=1 only the
 * cache is read; without it the entities keep the analytic fallback and the run is not an error.
 */
export const horizonsBodies: Connector = {
  id: 'horizons-bodies',
  intervalMs: REFRESH_MS,
  startDelayMs: 8000,
  async run(ctx) {
    const failed: string[] = [];
    let cached = 0, n = 0, retryAt = Infinity;
    let halted: string | undefined;
    const records = new Map(bodyEntityRecords().map((r) => [r.id, r]));
    for (const target of BODY_TARGETS) {
      const id = `body-${target.bodyId.toLowerCase()}`;
      if (halted) {
        failed.push(`${target.bodyId}: skipped (${halted})`);
        continue;
      }
      const source = `horizons-bodies:${target.bodyId}`;
      const gate = readBackoff(ctx.store, source);
      if (isBackedOff(gate)) {
        retryAt = Math.min(retryAt, gate.notBefore);
        failed.push(`${target.bodyId}: waiting (${gate.message?.slice(0, 60) ?? 'earlier failure'})`);
        continue;
      }
      try {
        const res = await ctx.cachedFetch(bodyCacheKey(target), bodyUrl(target, Date.now()), TTL_MS, parseHorizonsVectors);
        const prev = ctx.hub.graph.get(id) ?? records.get(id);
        if (!prev) throw new Error('no body entity');
        ctx.hub.upsert({ ...prev, provider: { type: 'body', bodyId: target.bodyId, ephemeris: { frame: target.frame, samples: res.value } } });
        n++;
        if (res.stale) {
          // an old table is still good (planets move slowly): used, but the failure is counted and a block ends the run
          failed.push(`${target.bodyId}: stale cache (${(res.error ?? 'download failed').slice(0, 80)})`);
          if (!ctx.http.offline) {
            retryAt = Math.min(retryAt, recordFailure(ctx.store, source, res.error ?? 'download failed').notBefore);
            if (isBlockError(res.error ?? '')) halted = `${target.bodyId} failed with a block or connect error`;
          }
        } else clearBackoff(ctx.store, source);
        if (res.fromCache) cached++;
        else await sleep(DELAY_MS);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        failed.push(`${target.bodyId}: ${message.slice(0, 100)}`);
        if (ctx.http.offline) continue;
        retryAt = Math.min(retryAt, recordFailure(ctx.store, source, err).notBefore);
        if (isBlockError(message)) halted = `${target.bodyId} failed with a block or connect error`;
        else await sleep(DELAY_MS);
      }
    }
    if (!n && ctx.http.offline) {
      ctx.health.note = 'offline: bodies keep the analytic fallback';
      return;
    }
    if (!n) throw new Error(`no body ephemerides: ${failed[0]}`);
    ctx.log(`${n} body ephemerides (${cached} cached)${failed.length ? `, failed: ${failed.join('; ')}` : ''}`);
    ctx.health.note = `${n} of ${BODY_TARGETS.length} bodies streamed${failed.length ? `; ${failed.length} on the analytic fallback` : ''}`;
    if (failed.length && !ctx.http.offline) ctx.softFail(failed[0], Math.min(Math.max(retryAt - Date.now(), 5 * 60_000), 60 * 60_000));
  },
};
