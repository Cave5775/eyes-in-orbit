import type { CredentialInfo } from '@eio/core';
import type { Api } from '../api/types';
import { rankEntities } from '../lib/filters';
import {
  mockAscentSeries, mockBodies, mockDsn, mockGroundAndProbes, mockHealth, mockIssFix, mockIssTelemetry, mockLaunches, mockNews, mockSatellites,
} from './generators';

/** Offline stand-in for the server: same shapes as the REST contract, synthesised in memory. */
export function createMockApi(nowMs = Date.now(), satCount = 2000): Api {
  const { launches, entities: launchEntities } = mockLaunches(nowMs);
  const entities = [...mockBodies(nowMs), ...mockSatellites(nowMs, satCount), ...launchEntities, ...mockGroundAndProbes(nowMs)];
  const iss = entities.find((e) => e.id === 'sat-25544');
  const issOmm = iss?.provider?.type === 'sgp4' ? iss.provider.omm : undefined;

  // in-memory stand-in for the server's credential store, so the settings panel can be tried with ?mock=1
  const creds: CredentialInfo[] = [
    { key: 'spacetrackUser', label: 'Space-Track username (e-mail)', connector: 'spacetrack', secret: false, set: false, source: null },
    { key: 'spacetrackPassword', label: 'Space-Track password', connector: 'spacetrack', secret: true, set: false, source: null },
    { key: 'll2Token', label: 'Launch Library 2 token', connector: 'launchlibrary', secret: true, set: false, source: null },
  ];

  return {
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
    ascent: async (launchId) => {
      const launch = launches.find((l) => l.id === launchId);
      return launch ? mockAscentSeries(launch) : null;
    },
  };
}
