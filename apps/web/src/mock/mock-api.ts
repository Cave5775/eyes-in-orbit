import type { Api } from '../api/types';
import { rankEntities } from '../lib/filters';
import {
  mockDsn, mockGroundAndProbes, mockHealth, mockIssFix, mockIssTelemetry, mockLaunches, mockNews, mockSatellites,
} from './generators';

/** Offline stand-in for the server: same shapes as the REST contract, synthesised in memory. */
export function createMockApi(nowMs = Date.now(), satCount = 2000): Api {
  const { launches, entities: launchEntities } = mockLaunches(nowMs);
  const entities = [...mockSatellites(nowMs, satCount), ...launchEntities, ...mockGroundAndProbes(nowMs)];
  const iss = entities.find((e) => e.id === 'sat-25544');
  const issOmm = iss?.provider?.type === 'sgp4' ? iss.provider.omm : undefined;

  return {
    entities: async (since = 0) => ({ serverTime: Date.now(), entities: entities.filter((e) => e.updatedAt > since) }),
    search: async (q, limit = 20) => rankEntities(entities, q, limit),
    launches: async () => launches,
    news: async ({ entity, q, limit = 20 } = {}) => {
      const rec = entity ? entities.find((e) => e.id === entity) : undefined;
      const query = q ?? rec?.links?.newsQuery ?? rec?.name;
      return mockNews(Date.now(), query).slice(0, limit);
    },
    dsn: async () => mockDsn(Date.now()),
    iss: async () => ({
      fix: issOmm ? mockIssFix(issOmm, Date.now()) : undefined,
      telemetry: mockIssTelemetry(Date.now()),
    }),
    health: async () => ({ serverTime: Date.now(), entityCount: entities.length, connectors: mockHealth(Date.now()) }),
  };
}
