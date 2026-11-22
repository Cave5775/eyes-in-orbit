import { hasTraverse, surfaceSiteOf, surfaceSiteRecords, type CredentialInfo, type RoverTraverse } from '@eio/core';
import type { Api } from '../api/types';
import { rankEntities } from '../lib/filters';
import { pageSlice } from '../lib/paging';
import { mockArchiveImages } from './archive-images';
import mmgis from './fixtures/mmgis-traverse.json';
// trimmed real MMGIS map tiles (fixtures/mmgis-tiles/<mission>-<layer>-<z>-<x>-<y>.png): the mock's Mars surface patch near Perseverance
const MOCK_TILES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('./fixtures/mmgis-tiles/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>)
    .map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -'.png'.length).toUpperCase(), url]),
);
import { mockDescription } from './describe';
import { mockMinorPlanetChunk, mockMinorPlanetIndex } from './minor-planets';
import {
  mockAscentSeries, mockBodies, mockDsn, mockGroundAndProbes, mockHealth, mockIssFix, mockIssTelemetry, mockLaunches, mockNews, mockObservatories, mockSatellites,
} from './generators';

/** The mock rover traverses: the trimmed real MMGIS localizations (fixtures/mmgis-traverse.json), the same shape as `api.traverse`. */
function mockTraverse(id: string, nowMs: number): RoverTraverse | null {
  const points = (mmgis as unknown as Record<string, [number, number, number][] | undefined>)[id];
  const site = surfaceSiteOf(id);
  if (!hasTraverse(id) || !points || !site) return null;
  return { entityId: id, bodyId: site.bodyId, source: mmgis.source, fetchedAt: nowMs, stale: false, points };
}

/** Offline stand-in for the server: same shapes as the REST contract, synthesised in memory. */
export function createMockApi(nowMs = Date.now(), satCount = 2000): Api {
  const { launches, entities: launchEntities } = mockLaunches(nowMs);
  const entities = [...mockBodies(nowMs), ...mockSatellites(nowMs, satCount), ...launchEntities, ...mockGroundAndProbes(nowMs), ...mockObservatories(nowMs), ...surfaceSiteRecords(nowMs).map((r) => {
    // a rover stands at the end of its traverse, as on the server (its latest waypoint)
    const end = mockTraverse(r.id, nowMs)?.points.at(-1);
    return end && r.provider?.type === 'geodetic' ? { ...r, provider: { ...r.provider, latDeg: end[0], lonDeg: end[1] } } : r;
  })];
  const iss = entities.find((e) => e.id === 'sat-25544');
  const issOmm = iss?.provider?.type === 'sgp4' ? iss.provider.omm : undefined;

  // in-memory stand-in for the server's credential store, so the settings panel can be tried with ?mock=1
  const creds: CredentialInfo[] = [
    { key: 'spacetrackUser', label: 'Space-Track username (e-mail)', connector: 'spacetrack', secret: false, set: false, source: null },
    { key: 'spacetrackPassword', label: 'Space-Track password', connector: 'spacetrack', secret: true, set: false, source: null },
    { key: 'll2Token', label: 'Launch Library 2 token', connector: 'launchlibrary', secret: true, set: false, source: null },
    { key: 'discosToken', label: 'ESA DISCOS API token', connector: 'discos', secret: true, set: false, source: null },
  ];

  return {
    minorPlanetIndex: async () => mockMinorPlanetIndex(nowMs),
    minorPlanetChunk: async (k) => mockMinorPlanetChunk(k),
    // the mock's sample is always "stored": nothing to download
    minorPlanetsStatus: async () => ({ state: 'ready', count: (await mockMinorPlanetIndex(nowMs)).count, fetchedAt: nowMs }),
    minorPlanetsDownload: async () => ({ state: 'ready', count: (await mockMinorPlanetIndex(nowMs)).count, fetchedAt: nowMs }),
    minorPlanetsCancel: async () => undefined,
    clearCredentials: async () => {
      for (const c of creds) Object.assign(c, { set: false, source: null, value: undefined });
      return creds.map((c) => ({ ...c }));
    },
    credentials: async () => creds.map((c) => ({ ...c })),
    saveCredentials: async (values) => {
      for (const c of creds) {
        if (!(c.key in values)) continue;
        const v = values[c.key]?.trim();
        c.set = !!v;
        c.source = v ? 'ui' : null;
        if (!c.secret) c.value = v || undefined;
      }
      return creds.map((c) => ({ ...c }));
    },
    entities: async (since = 0, page) => {
      const changed = entities.filter((e) => e.updatedAt > since);
      const { items, next } = pageSlice(changed, page?.offset, page?.limit);
      return { serverTime: Date.now(), entities: items, ...(next !== undefined ? { next } : {}), ...(page?.limit && !page.offset ? { total: changed.length } : {}) };
    },
    search: async (q, limit = 20) => rankEntities(entities, q, limit),
    match: async (q) => {
      const ids = rankEntities(entities, q, Infinity).map((h) => h.id);
      return { q, ids, total: ids.length, truncated: false, via: 'scan' };
    },
    launches: async () => launches,
    news: async ({ entity, q, limit = 20 } = {}) => {
      const rec = entity ? entities.find((e) => e.id === entity) : undefined;
      const query = q ?? rec?.links?.newsQuery ?? rec?.name;
      return mockNews(Date.now(), query).slice(0, limit);
    },
    dsn: async () => mockDsn(Date.now()),
    describe: async (entityId) => {
      const rec = entities.find((e) => e.id === entityId);
      if (!rec) throw new Error(`unknown entity ${entityId}`);
      return mockDescription(rec);
    },
    archiveImages: async (observatoryId, bodyId) => {
      const rec = entities.find((e) => e.id === observatoryId);
      if (!rec) throw new Error(`unknown entity ${observatoryId}`);
      return mockArchiveImages(rec, bodyId);
    },
    iss: async () => ({
      fix: issOmm ? mockIssFix(issOmm, Date.now()) : undefined,
      telemetry: mockIssTelemetry(Date.now()),
    }),
    health: async () => ({ serverTime: Date.now(), entityCount: entities.length, connectors: mockHealth(Date.now()) }),
    traverse: async (entityId) => mockTraverse(entityId, nowMs),
    mapTile: (layer, z, x, y) => MOCK_TILES[`${layer.mission}-${layer.id}-${z}-${x}-${y}`.toUpperCase()] ?? null,
    ascent: async (launchId) => {
      const launch = launches.find((l) => l.id === launchId);
      return launch ? mockAscentSeries(launch) : null;
    },
  };
}
