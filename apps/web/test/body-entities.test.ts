import { describe, expect, it } from 'vitest';
import { bodyEntityRecords, type EntityRecord } from '@eio/core';
import { withBodyEntities } from '../src/api/body-entities';
import { createMockApi } from '../src/mock/mock-api';
import { mockBodies } from '../src/mock/generators';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const ids = (r: EntityRecord[]) => r.map((e) => e.id).sort();
const probe: EntityRecord = { id: 'p', name: 'P', kind: 'probe', bodyId: 'EARTH', aliases: {}, updatedAt: 1 };

describe('body entities in the web app', () => {
  it('the mock catalog carries exactly the core body entities, stamped with the mock now', async () => {
    expect(mockBodies(NOW)).toEqual(bodyEntityRecords(undefined, NOW));
    const { entities } = await createMockApi(NOW, 20).entities();
    const bodies = entities.filter((e) => e.group === 'bodies');
    expect(ids(bodies)).toEqual(ids(bodyEntityRecords()));
    expect(bodies.every((b) => b.updatedAt === NOW && b.provider?.type === 'body')).toBe(true);
    const found = await createMockApi(NOW, 20).search('moon');
    expect(found.some((e) => e.id === 'body-moon')).toBe(true);
  });

  it('withBodyEntities adds the missing bodies and nothing else', () => {
    const out = withBodyEntities([probe], NOW);
    expect(ids(out)).toEqual(ids([probe, ...bodyEntityRecords()]));
    expect(out.find((e) => e.id === 'body-moon')?.updatedAt).toBe(NOW);
  });

  it('withBodyEntities keeps server-sent bodies and returns the same list when none are missing', () => {
    const server = bodyEntityRecords(undefined, 5).map((b) => ({ ...b, createdAt: 3 }));
    const full = [probe, ...server];
    expect(withBodyEntities(full, NOW)).toBe(full);

    const moon = server.find((b) => b.id === 'body-moon')!;
    const partial = withBodyEntities([probe, moon], NOW);
    expect(ids(partial)).toEqual(ids([probe, ...server]));
    expect(partial.find((e) => e.id === 'body-moon')).toBe(moon);
    expect(withBodyEntities([], NOW)).toHaveLength(4);
  });
});
