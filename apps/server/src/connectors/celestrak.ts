import type { Omm, StreamLink } from '@eio/core';
import type { Connector } from '../connector';
import type { NewEntity } from '../hub';

/**
 * Fragmentation-event debris clouds. GROUP names verified against the CelesTrak index page
 * (https://celestrak.org/NORAD/elements/). `cosmos-1408-debris` is not listed there any more, so it is
 * deliberately absent: an unknown GROUP returns plain text and would fail on every retry.
 */
export const DEBRIS_GROUPS = ['cosmos-2251-debris', 'iridium-33-debris', 'fengyun-1c-debris'] as const;
export type DebrisGroup = (typeof DEBRIS_GROUPS)[number];
export type SatGroup = 'stations' | 'starlink' | 'active' | DebrisGroup;

const isDebrisGroup = (g: SatGroup): g is DebrisGroup => (DEBRIS_GROUPS as readonly string[]).includes(g);

/** Dedupe priority: a NORAD id seen in several groups keeps the most specific one (debris clouds beat `active`). */
const GROUP_PRIORITY: SatGroup[] = ['stations', 'starlink', ...DEBRIS_GROUPS, 'active'];
/** Download order: the big, important groups first so a debris failure never delays them. */
const FETCH_ORDER: SatGroup[] = ['stations', 'starlink', 'active', ...DEBRIS_GROUPS];
const TTL_MS = 3 * 3600_000;
const ISS_NORAD = 25544;
const STATION_NAME = /^(ISS|CSS)\b|^(POISK|NAUKA|ZARYA|ZVEZDA|TIANGONG|TIANHE|WENTIAN|MENGTIAN)\b/i;

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

export function satelliteEntity(omm: Omm, group: SatGroup): NewEntity {
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
    render: { colorKey: kind === 'station' ? 'station' : kind === 'debris' ? 'debris' : group === 'starlink' ? 'starlink' : 'satellite' },
  };
  if (norad === ISS_NORAD) {
    aliases.common = 'ISS';
    rec.render = { colorKey: 'station', footprint: true, orbitLine: true, trailSeconds: 5400, label: true, model: 'iss' };
    rec.links = { streams: ISS_STREAMS, newsQuery: 'International Space Station' };
  }
  return rec;
}

/** Merge fetched groups, deduping by NORAD id (stations > starlink > debris clouds > active). */
export function normalizeCelestrak(groups: Partial<Record<SatGroup, Omm[]>>): NewEntity[] {
  const byNorad = new Map<number, NewEntity>();
  for (const group of GROUP_PRIORITY) {
    for (const omm of groups[group] ?? []) {
      if (!byNorad.has(omm.NORAD_CAT_ID)) byNorad.set(omm.NORAD_CAT_ID, satelliteEntity(omm, group));
    }
  }
  return [...byNorad.values()];
}

export const celestrak: Connector = {
  id: 'celestrak',
  intervalMs: TTL_MS,
  startDelayMs: 500,
  async run(ctx) {
    const groups: Partial<Record<SatGroup, Omm[]>> = {};
    const failures: string[] = [];
    for (const group of FETCH_ORDER) {
      try {
        const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
        groups[group] = (await ctx.cachedFetch(`celestrak:${group}`, url, TTL_MS, parseOmmJson)).value;
      } catch (err) {
        failures.push(`${group}: ${(err as Error).message}`);
      }
    }
    if (!Object.keys(groups).length) throw new Error(failures.join('; '));
    const changed = ctx.hub.upsert(...normalizeCelestrak(groups));
    ctx.log(`${ctx.hub.graph.size} entities, ${changed} changed${failures.length ? `, failed: ${failures.join('; ')}` : ''}`);
    if (failures.length) {
      ctx.health.note = `partial: ${failures.join('; ')}`;
      // CelesTrak answers 403 until its data changes (every ~2 h); do not hammer it
      ctx.softFail(failures[0], 30 * 60_000);
    }
  },
};
