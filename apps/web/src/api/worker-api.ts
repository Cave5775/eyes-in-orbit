import { localTilePath } from '@eio/core';
import type { Api } from './types';
import type { DataLink } from './data-link';

/** The `Api` over the data worker: every method but `mapTile` (which only builds an address) is one RPC. */
export function createWorkerApi(link: DataLink): Api {
  return {
    entities: (since, page) => link.call('entities', since, page),
    search: (q, limit) => link.call('search', q, limit),
    match: (q) => link.call('match', q),
    launches: () => link.call('launches'),
    news: (o) => link.call('news', o),
    dsn: () => link.call('dsn'),
    describe: (entityId) => link.call('describe', entityId),
    archiveImages: (observatoryId, bodyId) => link.call('archiveImages', observatoryId, bodyId),
    iss: () => link.call('iss'),
    health: () => link.call('health'),
    ascent: (launchId) => link.call('ascent', launchId).catch(() => null),
    traverse: (entityId) => link.call('traverse', entityId).catch(() => null),
    mapTile: (layer, z, x, y) => localTilePath(layer, z, x, y),
    minorPlanetIndex: () => link.call('minorPlanetIndex').catch(() => null),
    minorPlanetChunk: (k) => link.call('minorPlanetChunk', k),
    minorPlanetsStatus: () => link.call('minorPlanetsStatus'),
    minorPlanetsDownload: (opts) => link.call('minorPlanetsDownload', opts),
    minorPlanetsCancel: () => link.call('minorPlanetsCancel'),
    credentials: () => link.call('credentials'),
    saveCredentials: (values) => link.call('saveCredentials', values),
    clearCredentials: () => link.call('clearCredentials'),
  };
}
