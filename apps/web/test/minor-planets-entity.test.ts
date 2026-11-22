import { describe, expect, it } from 'vitest';
import { EntityGraph, SUN, designationText, keplerState, precessDir, readContainer } from '@eio/core';
import { eclipticToDate, orbitPosition, pickedOrbit } from '../src/lib/minor-planets';
import { mockMinorPlanetChunk, mockMinorPlanetIndex } from '../src/mock/minor-planets';
import { minorPlanetRecord } from '../src/scene/minor-planets';
import { createViewStore, MINOR_PLANETS_KEY } from '../src/state/view';
import { createMockApi } from '../src/mock/mock-api';

const T = Date.UTC(2026, 10, 18, 12);

describe('mock mode', () => {
  it('serves the 20 real MPCORB lines of the fixture as one chunk, brightest first', async () => {
    const idx = await mockMinorPlanetIndex(T);
    expect(idx).toMatchObject({ count: 20, chunkSize: 65536, stale: false });
    expect(idx.chunks).toEqual([{ chunk: 0, count: 20, hFirst: 3.25, hLast: 9.54 }]);
    expect(idx.credit).toMatch(/Minor Planet Center/);
    const u = readContainer(await mockMinorPlanetChunk(0));
    expect(u.count).toBe(20);
    expect(designationText(u.desig[0])).toBe('4');
    expect(readContainer(await mockMinorPlanetChunk(1)).count).toBe(0);
  });
  it('is part of the mock API, and the mock health list shows the connector', async () => {
    const api = createMockApi(T, 10);
    expect((await api.minorPlanetIndex())?.count).toBe(20);
    expect((await api.minorPlanetChunk(0)).length).toBeGreaterThan(600);
  });
});

describe('the picked point as an entity', () => {
  it('is a lightweight asteroid entity with designation, H, epoch and the word approximate', async () => {
    const u = readContainer(await mockMinorPlanetChunk(0));
    const rec = minorPlanetRecord(pickedOrbit(u, 0), T);
    expect(rec).toMatchObject({ id: 'mpc-4', name: '(4)', kind: 'asteroid', bodyId: 'SUN', group: 'minor-planets', aliases: { mpc: '4' } });
    expect(rec.attrs).toMatchObject({ designation: '4', elementsEpoch: '2026-06-09', source: 'Minor Planet Center (MPCORB)' });
    expect(rec.attrs?.absoluteMagnitudeH).toBeCloseTo(3.25, 2);
    expect(String(rec.attrs?.positionNote)).toBe('approximate (osculating elements at epoch 2026-06-09)');
    expect(rec.provider?.type).toBe('keplerian');
  });

  it('the entity (keplerian provider through the entity graph, Sun-centred) is where the point cloud puts the point', async () => {
    const u = readContainer(await mockMinorPlanetChunk(0));
    const tm = eclipticToDate(T);
    const graph = new EntityGraph();
    for (let i = 0; i < u.count; i++) {
      const rec = minorPlanetRecord(pickedOrbit(u, i), T);
      graph.upsert(rec);
      const cloud = orbitPosition(u, i, T, tm);
      // the entity's state in the Sun's inertial frame (J2000 axes) is the cloud position before the precession of the date
      const s = graph.stateIn(rec.id, T, 'SUN:inertial');
      expect(s).not.toBeNull();
      const j2000 = precessDir(cloud, T, true);
      expect(Math.hypot(s!.r[0] - j2000[0], s!.r[1] - j2000[1], s!.r[2] - j2000[2])).toBeLessThan(1e-3);
      const k = (rec.provider as { elements: Parameters<typeof keplerState>[0] }).elements;
      expect(keplerState(k, SUN.gm, T).r[0]).toBeCloseTo(s!.r[0], 3);
    }
  });
});

describe('View > Minor planets', () => {
  const mem = (init: Record<string, string> = {}) => {
    const data = { ...init };
    return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
  };
  it('is off by default (the download is opt-in), remembered, off when stored off', () => {
    expect(createViewStore(mem()).getState().minorPlanets).toBe(false);
    const storage = mem({ [MINOR_PLANETS_KEY]: 'off' });
    const store = createViewStore(storage);
    expect(store.getState().minorPlanets).toBe(false);
    store.getState().toggleMinorPlanets();
    expect(store.getState().minorPlanets).toBe(true);
    expect(storage.data[MINOR_PLANETS_KEY]).toBe('on');
    store.getState().toggleMinorPlanets();
    expect(storage.data[MINOR_PLANETS_KEY]).toBe('off');
  });
});

describe('the cloud material follows the point conventions', () => {
  it('shares the occluder and disc-cone uniforms and the hiding code of the entity point material, within the uniform budget', async () => {
    const { createMinorPlanetMaterial, createPointMaterial, POINT_HIDE_GLSL, POINT_UNIFORM_VECTORS, MIN_VERTEX_UNIFORM_VECTORS } = await import('../src/scene/materials');
    const pm = createPointMaterial(1), mm = createMinorPlanetMaterial(pm.uniforms, 1);
    for (const k of ['uOccN', 'uOccS', 'uOccE', 'uOccP', 'uGroup', 'uGroupD', 'uGroupE']) expect(mm.uniforms[k]).toBe(pm.uniforms[k]);
    expect(pm.vertexShader).toContain(POINT_HIDE_GLSL);
    expect(mm.vertexShader).toContain(POINT_HIDE_GLSL);
    expect(mm.vertexShader).toMatch(/bodyHides\(rel\) \|\| discHides\(rel\)/);
    // the cloud adds uOffset (1 vector), uPx and the position attribute is not a uniform
    expect(POINT_UNIFORM_VECTORS + 2).toBeLessThanOrEqual(MIN_VERTEX_UNIFORM_VECTORS);
    expect(mm.transparent && !mm.depthTest && !mm.depthWrite).toBe(true);
  });
});
