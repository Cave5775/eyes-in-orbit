import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HUBBLE_NORAD, observatoryAttrs, type Omm, type StreamLink } from '@eio/core';
import { clearBackoff, isBackedOff, isBlockError, isConnectError, readBackoff, recordFailure } from '../backoff';
import type { Connector, ConnectorContext } from '../connector';
import type { NewEntity } from '../hub';
import { LimitedError } from '../net/limiter';

/**
 * Fragmentation-event debris clouds. GROUP names verified against the CelesTrak index page
 * (https://celestrak.org/NORAD/elements/). `cosmos-1408-debris` is not listed there any more, so it is
 * deliberately absent: an unknown GROUP returns plain text and would fail on every retry.
 */
export const DEBRIS_GROUPS = ['cosmos-2251-debris', 'iridium-33-debris', 'fengyun-1c-debris'] as const;
export type DebrisGroup = (typeof DEBRIS_GROUPS)[number];
/**
 * Navigation (GNSS) constellations: GPS, GLONASS, Galileo and BeiDou, in medium Earth orbit (about 19,100 to 23,200 km
 * altitude, 12 to 14 h periods; BeiDou also has GEO and inclined-GEO members). GROUP names from CelesTrak's current data
 * page (https://celestrak.org/NORAD/elements/): `gps-ops` (there is no `gps` group), `glo-ops`, `galileo`, `beidou`.
 * CelesTrak also has one combined `gnss` group, not used because the four constellations are shown as separate chips.
 */
export const NAV_GROUPS = ['gps-ops', 'glo-ops', 'galileo', 'beidou'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];
/** Amateur-radio satellites (CelesTrak `amateur`, a small group of about 100 objects). Same colour as other satellites. */
export const AMATEUR_GROUP = 'amateur';
export type SatGroup = 'stations' | 'starlink' | 'active' | DebrisGroup | NavGroup | typeof AMATEUR_GROUP;

const isDebrisGroup = (g: SatGroup): g is DebrisGroup => (DEBRIS_GROUPS as readonly string[]).includes(g);
const isNavGroup = (g: SatGroup): g is NavGroup => (NAV_GROUPS as readonly string[]).includes(g);

/**
 * Dedupe priority: a NORAD id seen in several groups keeps the most specific one (debris clouds, then navigation and
 * amateur, beat `active`; the catch-all `active` is last).
 */
const GROUP_PRIORITY: SatGroup[] = ['stations', 'starlink', ...DEBRIS_GROUPS, ...NAV_GROUPS, AMATEUR_GROUP, 'active'];
/**
 * Download order: the big, important groups first so a failure of a later group never delays them. Every group added
 * here is one more download (more exposure to the CelesTrak 403 rate limit, each with its own backoff gate).
 */
export const FETCH_ORDER: SatGroup[] = ['stations', 'starlink', 'active', ...DEBRIS_GROUPS, ...NAV_GROUPS, AMATEUR_GROUP];
const TTL_MS = 3 * 3600_000;
const ISS_NORAD = 25544;
const STATION_NAME = /^(ISS|CSS)\b|^(POISK|NAUKA|ZARYA|ZVEZDA|TIANGONG|TIANHE|WENTIAN|MENGTIAN)\b/i;
const STARLINK_NAME = /^STARLINK\b/i;

export const ISS_STREAMS: StreamLink[] = [
  { title: 'NASA Live: Official Stream of NASA TV', url: 'https://www.youtube.com/watch?v=21X5lGlDOfg', kind: 'youtube', live: true },
  { title: 'Sen 4K Earth views from the ISS (third party)', url: 'https://www.youtube.com/watch?v=fO9e9jnhYK8', kind: 'youtube', live: true },
  { title: 'NASA Live', url: 'https://www.nasa.gov/nasalive', kind: 'nasa-tv' },
];

/** Keep only the fields SGP4 needs (the cache holds ~25k rows). */
export function parseOmmJson(text: string): Omm[] {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error(`CelesTrak did not return a JSON array: ${text.slice(0, 120)}`);
  return rows.map((r): Omm => ({
    OBJECT_NAME: String(r.OBJECT_NAME),
    OBJECT_ID: r.OBJECT_ID,
    EPOCH: String(r.EPOCH),
    MEAN_MOTION: Number(r.MEAN_MOTION),
    ECCENTRICITY: Number(r.ECCENTRICITY),
    INCLINATION: Number(r.INCLINATION),
    RA_OF_ASC_NODE: Number(r.RA_OF_ASC_NODE),
    ARG_OF_PERICENTER: Number(r.ARG_OF_PERICENTER),
    MEAN_ANOMALY: Number(r.MEAN_ANOMALY),
    EPHEMERIS_TYPE: Number(r.EPHEMERIS_TYPE ?? 0),
    CLASSIFICATION_TYPE: r.CLASSIFICATION_TYPE ?? 'U',
    NORAD_CAT_ID: Number(r.NORAD_CAT_ID),
    ELEMENT_SET_NO: Number(r.ELEMENT_SET_NO ?? 0),
    REV_AT_EPOCH: Number(r.REV_AT_EPOCH ?? 0),
    BSTAR: Number(r.BSTAR),
    MEAN_MOTION_DOT: Number(r.MEAN_MOTION_DOT),
    MEAN_MOTION_DDOT: Number(r.MEAN_MOTION_DDOT),
  })).filter((o) => Number.isFinite(o.NORAD_CAT_ID) && Number.isFinite(o.MEAN_MOTION) && Number.isFinite(o.BSTAR));
}

export function satKind(omm: Omm): 'station' | 'debris' | 'satellite' {
  if (omm.NORAD_CAT_ID === ISS_NORAD || STATION_NAME.test(omm.OBJECT_NAME)) return 'station';
  if (/\bDEB\b|\bR\/B\b/.test(omm.OBJECT_NAME)) return 'debris';
  return 'satellite';
}

export function satelliteEntity(omm: Omm, sourceGroup: SatGroup): NewEntity {
  // Starlink shows up in `active` too, so it stays a Starlink (group, colour) when only `active` could be fetched
  const group: SatGroup = sourceGroup === 'active' && STARLINK_NAME.test(omm.OBJECT_NAME) ? 'starlink' : sourceGroup;
  const sk = satKind(omm);
  // everything in a fragmentation-event group is debris for display, even the defunct parent (no ' DEB' in its name)
  const kind = sk === 'satellite' && isDebrisGroup(group) ? 'debris' : sk;
  const norad = omm.NORAD_CAT_ID;
  const aliases: Record<string, string> = { norad: String(norad) };
  if (omm.OBJECT_ID) aliases.cospar = omm.OBJECT_ID;
  const rec: NewEntity = {
    id: `sat-${norad}`,
    name: omm.OBJECT_NAME,
    kind,
    bodyId: 'EARTH',
    aliases,
    group,
    provider: { type: 'sgp4', omm },
    render: {
      colorKey: kind === 'station' ? 'station' : kind === 'debris' ? 'debris' : group === 'starlink' ? 'starlink' : isNavGroup(group) ? 'navigation' : 'satellite',
    },
  };
  if (norad === ISS_NORAD) {
    aliases.common = 'ISS';
    rec.render = { colorKey: 'station', footprint: true, orbitLine: true, trailSeconds: 5400, label: true, model: 'iss' };
    rec.links = { streams: ISS_STREAMS, newsQuery: 'International Space Station' };
  }
  if (norad === HUBBLE_NORAD) {
    // Hubble: an optical/UV/near-infrared observatory (CelesTrak `active` group, NORAD 20580 = 1990-037B)
    rec.attrs = observatoryAttrs({ site: 'space', bands: ['optical', 'ultraviolet', 'near-infrared'], survey: 'CDS/P/DSS2/color' });
    rec.links = { newsQuery: 'Hubble Space Telescope' };
  }
  return rec;
}

/** Merge fetched groups, deduping by NORAD id (stations > starlink > debris clouds > navigation > amateur > active). */
export function normalizeCelestrak(groups: Partial<Record<SatGroup, Omm[]>>): NewEntity[] {
  const byNorad = new Map<number, NewEntity>();
  for (const group of GROUP_PRIORITY) {
    for (const omm of groups[group] ?? []) {
      if (!byNorad.has(omm.NORAD_CAT_ID)) byNorad.set(omm.NORAD_CAT_ID, satelliteEntity(omm, group));
    }
  }
  return [...byNorad.values()];
}

/**
 * A group file saved by hand (`data/celestrak/<group>.json`, the same JSON `gp.php?GROUP=<group>&FORMAT=json` returns).
 * The escape hatch when CelesTrak blocks this IP and nothing is cached yet.
 */
export function loadGroupFile(dir: string, group: SatGroup): Omm[] | undefined {
  try {
    return parseOmmJson(readFileSync(join(dir, `${group}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}

type Source = 'live' | 'cache' | 'file';

/** Like `loadGroupFile`, with the time the file was saved so it can be compared with the cache. */
export function loadGroupFileStamped(dir: string, group: SatGroup): { omms: Omm[]; savedAt: number } | undefined {
  try {
    const path = join(dir, `${group}.json`);
    const omms = parseOmmJson(readFileSync(path, 'utf8'));
    return { omms, savedAt: statSync(path).mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Everything that does not touch the network: the SQLite entry of any age or the saved file (`npm run celestrak:seed`,
 * or by hand), whichever is newer, so a file seeded on another network beats an old cache entry.
 */
function localGroup(ctx: ConnectorContext, group: SatGroup): { omms: Omm[]; source: Source } | undefined {
  const cached = ctx.store.get<Omm[]>(`celestrak:${group}`);
  const file = loadGroupFileStamped(join(ctx.config.dataDir, 'celestrak'), group);
  if (cached && (!file || cached.fetchedAt >= file.savedAt)) return { omms: cached.value, source: 'cache' };
  return file && { omms: file.omms, source: 'file' };
}

const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + 'Z';

/**
 * The spacing between downloads (2 s), the 15 requests per hour and the 24 h stop after repeated failures are the request
 * limiter's job (`net/limits.ts`, source `celestrak`); a group is downloaded at most once per 3 h by its cache TTL.
 */
export function createCelestrak(): Connector {
  return {
    id: 'celestrak',
    intervalMs: TTL_MS,
    startDelayMs: 500,
    async run(ctx) {
      const groups: Partial<Record<SatGroup, Omm[]>> = {};
      const failures: string[] = [];
      const degraded: string[] = [];
      const skipped: string[] = [];
      let retryAt = Infinity;
      /** set by the first block or connect error (or a stored connect-error gate): the rest of the run stays off the network */
      let halt: string | undefined;
      for (const group of FETCH_ORDER) {
        const source = `celestrak:${group}`;
        if (halt) {
          // one shared gate: no request, no failure counted for this group, one line in total
          const local = localGroup(ctx, group);
          if (local) groups[group] = local.omms;
          skipped.push(`${group} (${local ? (local.source === 'file' ? 'data file' : 'cache') : 'no data'})`);
          continue;
        }
        const gate = readBackoff(ctx.store, source);
        const give = (local: { omms: Omm[]; source: Source } | undefined, why: string): void => {
          if (local) {
            groups[group] = local.omms;
            degraded.push(`${group}: ${why}, using ${local.source === 'file' ? 'data file' : 'cache'}`);
          } else failures.push(`${group}: ${why}`);
        };
        if (isBackedOff(gate)) {
          // CelesTrak 403s clients that re-download; stay off the network until the stored retry time, even across restarts
          retryAt = Math.min(retryAt, gate.notBefore);
          give(localGroup(ctx, group), `waiting until ${hhmm(gate.notBefore)} (${gate.message ?? 'earlier failure'})`);
          // an unreachable host stays unreachable for the other groups too; a 403 on one group says nothing about them
          if (gate.message && isConnectError(gate.message)) halt = `${group} is waiting for its retry time`;
          continue;
        }
        const row = ctx.store.get<Omm[]>(source);
        // a stale copy with a fetch time lets CelesTrak answer 304 instead of resending an unchanged group
        const headers = row?.fetchedAt ? { 'if-modified-since': new Date(row.fetchedAt).toUTCString() } : undefined;
        try {
          const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
          const res = await ctx.cachedFetch(source, url, TTL_MS, parseOmmJson, headers, { source: 'celestrak', mode: 'poll' });
          groups[group] = res.value;
          if (res.limitedUntil !== undefined) {
            // the request limiter refused the download (cap or block): not a failure of the source, so no backoff gate; the rest of the run stays off the network
            retryAt = Math.min(retryAt, res.limitedUntil);
            const local = localGroup(ctx, group);
            if (local) groups[group] = local.omms;
            degraded.push(`${group}: ${res.error ?? 'rate limited'}, using ${local?.source === 'file' ? 'data file' : 'cache'}`);
            halt = `${group} is rate limited`;
          } else if (res.stale) {
            // cachedFetch fell back to an old entry because the download failed; a newer saved file beats it
            const next = recordFailure(ctx.store, source, res.error ?? 'download failed');
            retryAt = Math.min(retryAt, next.notBefore);
            const local = localGroup(ctx, group);
            if (local) groups[group] = local.omms;
            degraded.push(`${group}: ${res.error ?? 'download failed'}, using ${local?.source === 'file' ? 'data file' : 'cache'}`);
            if (isBlockError(res.error ?? '')) halt = `${group} failed`;
          } else clearBackoff(ctx.store, source);
        } catch (err) {
          if (err instanceof LimitedError) {
            retryAt = Math.min(retryAt, err.retryAt);
            give(localGroup(ctx, group), err.message);
            halt = `${group} is rate limited`;
            continue;
          }
          const next = recordFailure(ctx.store, source, err);
          retryAt = Math.min(retryAt, next.notBefore);
          give(localGroup(ctx, group), (err as Error).message);
          if (isBlockError((err as Error).message ?? '')) halt = `${group} failed`;
        }
      }
      const skippedNote = skipped.length ? `skipped ${skipped.length} group${skipped.length === 1 ? '' : 's'} (${halt}): ${skipped.join(', ')}` : '';
      if (!Object.keys(groups).length) throw new Error([...failures, skippedNote].filter(Boolean).join('; '));
      const changed = ctx.hub.upsert(...normalizeCelestrak(groups));
      const problems = [...failures, ...degraded, ...(skippedNote ? [skippedNote] : [])];
      ctx.log(`${ctx.hub.graph.size} entities, ${changed} changed${problems.length ? `; ${problems.join('; ')}` : ''}`);
      if (problems.length) {
        ctx.health.note = `partial: ${problems.join('; ')}`;
        ctx.softFail(problems[0], Math.max(retryAt - Date.now(), 60_000));
      }
    },
  };
}

export const celestrak: Connector = createCelestrak();
