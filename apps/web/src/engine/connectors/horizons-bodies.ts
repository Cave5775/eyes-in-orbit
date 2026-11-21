import { bodyEntityRecords, bodyPeriodSec, defaultBodies, type BodyRegistry, type FrameId } from '@eio/core';
import { clearBackoff, isBackedOff, isBlockError, readBackoff, recordFailure } from '../backoff';
import { LimitedError } from '../net/limiter';
import type { Connector } from '../scheduler';
import { parseHorizonsVectors } from './horizons';

const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
/** planets move slowly: a day-old table is as good as a new one */
const TTL_MS = 24 * 3600_000;
const REFRESH_MS = 12 * 3600_000;

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
  /**
   * The last UTC date (`YYYY-MM-DD`) the Horizons record covers (cite it in a comment at the target), like `ended` in dsn-targets.ts.
   * `activeBodyTargets` leaves the target out once the request window (the fetch hour plus `futureDays`) would run past the end of that
   * day: no request, no failure, no degraded health; the body then keeps its analytic fallback orbit from `bodies.ts`.
   */
  validUntil?: string;
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
 * `test/engine/connectors/horizons-bodies.test.ts` checks the budget numerically against the registry orbits.
 */
export const MOON_STEPS_PER_REV = 24;
/** each side of a moon's window: this many steps (401 rows ~ 110 kB per response, 8.3 revolutions each side) */
export const MOON_WINDOW_STEPS = 200;
/**
 * Moons that need more steps per revolution than `MOON_STEPS_PER_REV`. Himalia, Phoebe (orbits of 11 and 13 million km around a
 * body of 85 and 106 km radius) and Hyperion (1.5 million km, 135 km) need the Hermite error under the body radius, which 24 steps
 * do not give (140 km for Himalia): 48, 48 and 36 steps per revolution cut it to under 10 km. Nereid's orbit has e = 0.751: at periapsis it moves
 * about 10.6 times faster than the mean motion, so 24 steps per revolution would sweep nearly 3 rad per step there and a cubic
 * Hermite segment would be useless. 240 steps per revolution keep that at 0.28 rad (the window is then +-0.8 revolutions).
 */
export const MOON_STEPS_OVERRIDE: Readonly<Record<string, number>> = { NEREID: 240, HIMALIA: 48, PHOEBE: 48, HYPERION: 36 };

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
  const stepMin = Math.max(5, Math.round(periodMin / (MOON_STEPS_OVERRIDE[bodyId] ?? MOON_STEPS_PER_REV) / 5) * 5);
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
 * Named asteroids (small-body designation with a semicolon, Horizons ids checked 2026-11-17): Vesta `4;`, Pallas `2;`, Hygiea `10;`,
 *   Psyche `16;` (Hygiea 10 d, +-2 y, 147 rows; Vesta, Pallas, Psyche 5 d, +-2 y, 293 rows); Bennu `101955;`, Ryugu `162173;`, Eros `433;`,
 *   Didymos `65803;` (the system barycentre), Itokawa `25143;` (2 d, +-1.5 y, 549 rows); Apophis `99942;` (1.5 d, +-1 y, 487 rows); Arrokoth
 *   `486958;` (60 d, +-10 y, 122 rows). The near-Earth orbits are fast and eccentric (e 0.19 to 0.38): perihelion speed is up to 2.4 times
 *   the mean motion, so the budget for the asteroids is the worst case over the real orbit, R (n h f)^4 / 384 with f = (1 + e)^2 / (1 - e^2)^1.5,
 *   under 5 km for every one (1.7 km Bennu, 1.2 Ryugu, 1.3 Apophis, 1.6 Didymos and Itokawa, 0.6 Eros, 0.6 Vesta, 1.0 Pallas, 2.8 Hygiea,
 *   0.3 Psyche); `test/engine/connectors/horizons-bodies.test.ts` asserts it.
 * Moons: see `moonTarget`. Dimorphos `120065803` is relative to the Didymos system barycentre `500@20065803` (the centre the
 *   Didymos record itself is on), not the primary body `920065803`: Didymos is drawn at that barycentre.
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
    planetTarget('VESTA', '4;', 5, 2),
    planetTarget('PALLAS', '2;', 5, 2),
    planetTarget('HYGIEA', '10;', 10, 2),
    planetTarget('PSYCHE', '16;', 5, 2),
    planetTarget('BENNU', '101955;', 2, 1.5),
    planetTarget('RYUGU', '162173;', 2, 1.5),
    planetTarget('DIDYMOS', '65803;', 2, 1.5),
    planetTarget('APOPHIS', '99942;', 1.5, 1),
    planetTarget('EROS', '433;', 2, 1.5),
    planetTarget('ITOKAWA', '25143;', 2, 1.5),
    planetTarget('ARROKOTH', '486958;', 60, 10),
  ];
  const moons: [string, string, string][] = [
    ['PHOBOS', '401', '499'], ['DEIMOS', '402', '499'],
    ['IO', '501', '599'], ['EUROPA', '502', '599'], ['GANYMEDE', '503', '599'], ['CALLISTO', '504', '599'],
    ['MIMAS', '601', '699'], ['ENCELADUS', '602', '699'], ['TETHYS', '603', '699'], ['DIONE', '604', '699'],
    ['RHEA', '605', '699'], ['TITAN', '606', '699'], ['IAPETUS', '608', '699'],
    ['MIRANDA', '705', '799'], ['ARIEL', '701', '799'], ['UMBRIEL', '702', '799'], ['TITANIA', '703', '799'], ['OBERON', '704', '799'],
    ['TRITON', '801', '899'], ['CHARON', '901', '999'],
    // smaller moons (all Horizons ids checked 2026-11-17 except Hydra, which shares Nix's PLU060 ephemeris)
    ['AMALTHEA', '505', '599'], ['THEBE', '514', '599'], ['HIMALIA', '506', '599'],
    ['HYPERION', '607', '699'], ['PHOEBE', '609', '699'], ['JANUS', '610', '699'], ['EPIMETHEUS', '611', '699'],
    ['PUCK', '715', '799'],
    ['NEREID', '802', '899'], ['DESPINA', '805', '899'], ['GALATEA', '806', '899'], ['LARISSA', '807', '899'], ['PROTEUS', '808', '899'],
    ['NIX', '902', '999'], ['HYDRA', '903', '999'],
    // Dimorphos: its own Horizons record (checked 2026-11-17), centred on the Didymos system barycentre (an SPK id, not a planet NAIF)
    ['DIMORPHOS', '120065803', '20065803'],
  ];
  // The Dimorphos record (JPL s547 + Hera latest, header "Updated: 2026-Oct-30", read 2026-11-17) ends with the ESA file
  // dimorphos_fsp_000005_260701_270701_v01 on 2027-06-30 TDB. After that Dimorphos stays on its registry fallback orbit (the
  // 2026-11-17 elements, period 11.92 h: right size and plane, the phase drifts), and every other target is unaffected.
  const validUntil: Record<string, string> = { DIMORPHOS: '2027-06-30' };
  return [...planets, ...moons.map(([id, cmd, planet]) => moonTarget(id, cmd, planet, registry))].map((t) => (validUntil[t.bodyId] ? { ...t, validUntil: validUntil[t.bodyId] } : t));
}

export const BODY_TARGETS: BodyTarget[] = buildBodyTargets();

/** End of the UTC day `validUntil`, ms. */
const endOfDayMs = (validUntil: string): number => Date.parse(`${validUntil}T00:00:00Z`) + DAY_MS;

/** The targets whose Horizons record still covers the request window at `nowMs` (every target without `validUntil`). */
export const activeBodyTargets = (nowMs: number, targets: readonly BodyTarget[] = BODY_TARGETS): BodyTarget[] =>
  targets.filter((t) => t.validUntil === undefined || Math.floor(nowMs / HOUR_MS) * HOUR_MS + Math.round(t.futureDays * DAY_MS) <= endOfDayMs(t.validUntil));

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



/**
 * The body registry's real data stream: JPL Horizons vector tables for the planets, dwarf planets, asteroids and moons (59
 * targets, `BODY_TARGETS`). Offline first: the `bodies` connector registers every body with the analytic fallback; this
 * one REPLACES only the provider of the same `body-*` entity: `{type:'body', bodyId, ephemeris:{frame, samples}}`, so the id,
 * kind, parent and hierarchy stay. The provider keeps type `body` on purpose (all the web's body handling, `bodyOf`,
 * `isBodyEntity`, `entityRank`, the orbit lines, keys off it); core's `BodyProvider` installs the samples in the body
 * registry (`setBodyStream`), where they replace the Kepler orbit inside the window.
 *
 * Per target soft failures (the others carry on), a persistent per-target backoff (IndexedDB), a block error (HTTP 403/429,
 * unreachable host) ends the run, requests are 1.5 s apart, cache TTL 24 h, refresh every 12 h. Offline only the
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
    const targets = activeBodyTargets(Date.now());
    for (const target of targets) {
      const id = `body-${target.bodyId.toLowerCase()}`;
      if (halted) {
        failed.push(`${target.bodyId}: skipped (${halted})`);
        continue;
      }
      const source = `horizons-bodies:${target.bodyId}`;
      const gate = await readBackoff(ctx.store, source);
      if (isBackedOff(gate)) {
        retryAt = Math.min(retryAt, gate.notBefore);
        failed.push(`${target.bodyId}: waiting (${gate.message?.slice(0, 60) ?? 'earlier failure'})`);
        continue;
      }
      try {
        const res = await ctx.cachedFetch(bodyCacheKey(target), bodyUrl(target, Date.now()), TTL_MS, parseHorizonsVectors, undefined, { source: 'horizons', mode: 'poll' });
        const prev = ctx.hub.graph.get(id) ?? records.get(id);
        if (!prev) throw new Error('no body entity');
        ctx.hub.upsert({ ...prev, provider: { type: 'body', bodyId: target.bodyId, ephemeris: { frame: target.frame, samples: res.value } } });
        n++;
        if (res.limitedUntil !== undefined) {
          // the limiter refused the download: not a failure of the source (no backoff gate); the rest of the run stays off the network
          retryAt = Math.min(retryAt, res.limitedUntil);
          failed.push(`${target.bodyId}: ${(res.error ?? 'rate limited').slice(0, 80)}`);
          halted = 'rate limited';
        } else if (res.stale) {
          // an old table is still good (planets move slowly): used, but the failure is counted and a block ends the run
          failed.push(`${target.bodyId}: stale cache (${(res.error ?? 'download failed').slice(0, 80)})`);
          if (!ctx.http.offline) {
            retryAt = Math.min(retryAt, (await recordFailure(ctx.store, source, res.error ?? 'download failed')).notBefore);
            if (isBlockError(res.error ?? '')) halted = `${target.bodyId} failed with a block or connect error`;
          }
        } else await clearBackoff(ctx.store, source);
        if (res.fromCache) cached++;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        failed.push(`${target.bodyId}: ${message.slice(0, 100)}`);
        if (ctx.http.offline) continue;
        if (err instanceof LimitedError) {
          retryAt = Math.min(retryAt, err.retryAt);
          halted = 'rate limited';
          continue;
        }
        retryAt = Math.min(retryAt, (await recordFailure(ctx.store, source, err)).notBefore);
        if (isBlockError(message)) halted = `${target.bodyId} failed with a block or connect error`;
      }
    }
    if (!n && ctx.http.offline) {
      ctx.health.note = 'offline: bodies keep the analytic fallback';
      return;
    }
    if (!n) throw new Error(`no body ephemerides: ${failed[0]}`);
    ctx.log(`${n} body ephemerides (${cached} cached)${failed.length ? `, failed: ${failed.join('; ')}` : ''}`);
    ctx.health.note = `${n} of ${targets.length} bodies streamed${failed.length ? `; ${failed.length} on the analytic fallback` : ''}`;
    if (failed.length && !ctx.http.offline) ctx.softFail(failed[0], Math.min(Math.max(retryAt - Date.now(), 5 * 60_000), 60 * 60_000));
  },
};
