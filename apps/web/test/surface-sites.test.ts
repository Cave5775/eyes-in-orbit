import * as THREE from 'three';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EntityGraph, SURFACE_SITES, bodyEntityRecords, defaultBodies, providerFromSpec, surfaceSiteRecords, DEG, type EntityRecord,
} from '@eio/core';
import { buildTreeRows, type TreeBody } from '../src/lib/entity-tree';
import { categoryOf } from '../src/lib/browser-ui';
import { classify, isDrawn, termFromWord, type Query } from '../src/lib/query';
import { refPositionEci } from '../src/lib/ref-body';
import { CelestialLayer } from '../src/scene/celestial';
import { useStore } from '../src/state/store';
import { EARTH_CENTRE } from '../src/lib/frame';
import { viewClass, typeOf, primaryOf } from '../src/lib/view-class';
import { inScope, scopeBodies } from '../src/lib/scope';
import { createMockApi } from '../src/mock/mock-api';

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const NOW = Date.UTC(2026, 10, 17);
const sites = surfaceSiteRecords(NOW);
const byId = Object.fromEntries(sites.map((r) => [r.id, r])) as Record<string, EntityRecord>;

function layerOf(bodyIds: string[]) {
  const scene = new THREE.Scene();
  const layer = new CelestialLayer(scene, new THREE.Vector3(1, 0, 0), { loadTexture: () => undefined });
  layer.setBodies(bodyEntityRecords().filter((r) => bodyIds.includes(r.id)));
  return { scene, layer };
}
const sphereOf = (scene: THREE.Scene, radius: number) =>
  scene.children.find((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.type === 'SphereGeometry' && Math.abs(((o as THREE.Mesh).geometry as THREE.SphereGeometry).parameters.radius - radius) < 1e-6) as THREE.Mesh;

describe('a surface point is on the drawn mesh (the sphere the scene draws for the Moon, Mars and Titan)', () => {
  // the Moon layer starts a TextureLoader for moon.jpg: an element that never loads is enough (there is no DOM in the test)
  const g = globalThis as { document?: unknown };
  beforeAll(() => {
    g.document = { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, set src(_v: string) {} }) };
  });
  afterAll(() => {
    delete g.document;
  });
  for (const id of ['MOON', 'MARS', 'TITAN']) {
    it(`${id}: the lat/lon of every sampled mesh vertex (from its map coordinates) placed by the provider is that vertex, within a metre`, () => {
      const { scene, layer } = layerOf([`body-${id.toLowerCase()}`]);
      layer.update(T0, new THREE.Vector3(...refPositionEci(id, T0)).add(new THREE.Vector3(9000, 0, 0)));
      const body = defaultBodies.get(id);
      const mesh = sphereOf(scene, body.radiusKm);
      expect(mesh, id).toBeDefined();
      expect(mesh.scale.toArray()).toEqual([1, 1, 1]); // drawn as a sphere: no flattening the placement would have to follow
      const pos = mesh.geometry.getAttribute('position'), uv = mesh.geometry.getAttribute('uv');
      let n = 0, worst = 0;
      for (let i = 0; i < pos.count; i += 37) {
        const lat = (uv.getY(i) - 0.5) * 180, lon = (uv.getX(i) - 0.5) * 360; // the equirectangular map: u grows east, v north
        const r = providerFromSpec({ type: 'geodetic', bodyId: id, latDeg: lat, lonDeg: lon, altKm: 0 }).stateAt(T0)!.r;
        const d = Math.hypot(pos.getX(i) - r[0], pos.getY(i) - r[1], pos.getZ(i) - r[2]) * 1000;
        worst = Math.max(worst, d);
        n++;
      }
      expect(n).toBeGreaterThan(100);
      expect(worst, `${id} worst vertex miss, m`).toBeLessThan(1);
    });
  }

  it('Moon and Mars: the rotated mesh point of each site is the position the entity graph gives in the Earth-inertial scene frame, within a metre', () => {
    const graph = new EntityGraph();
    for (const r of sites) graph.upsert(r);
    const origin = new THREE.Vector3(1e6, -2e6, 3e5);
    const { scene, layer } = layerOf(['body-moon', 'body-mars']);
    layer.update(T0, origin);
    let checked = 0;
    for (const s of SURFACE_SITES.filter((x) => x.bodyId === 'MOON' || x.bodyId === 'MARS')) {
      const mesh = sphereOf(scene, defaultBodies.get(s.bodyId).radiusKm);
      const fixed = providerFromSpec(byId[s.id].provider!).stateAt(T0)!.r;
      const onMesh = mesh.localToWorld(new THREE.Vector3(...fixed)); // camera-relative, like the scene
      const state = graph.stateIn(s.id, T0, 'EARTH:inertial')!;
      const d = Math.hypot(onMesh.x - (state.r[0] - origin.x), onMesh.y - (state.r[1] - origin.y), onMesh.z - (state.r[2] - origin.z)) * 1000;
      expect(d, s.id).toBeLessThan(1);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('the placement matches the map: Apollo 11 (23.47 E, 0.67 N) is right of the prime meridian on the texture and Apollo 12 (23.42 W) left of it', () => {
    const u = (id: string) => (byId[id].provider as { lonDeg: number }).lonDeg / 360 + 0.5;
    const wrap = (x: number) => x - Math.floor(x);
    expect(wrap(u('site-apollo-11'))).toBeCloseTo(0.5 + 23.47314 / 360, 9);
    expect(wrap(u('site-apollo-12'))).toBeCloseTo(0.5 - 23.4219 / 360, 9);
    expect(0.67416 * DEG).toBeGreaterThan(0);
  });
});

describe('entities of the surface sites in the browser (tree, classification, scope, selection)', () => {
  const TREE: TreeBody[] = defaultBodies.all().map((b) => ({ id: b.id, name: b.name, parentId: b.parentId }));

  it('every site is listed under its body in the tree (MOON, MARS, TITAN), none under the Earth', () => {
    const rows = buildTreeRows(sites, { bodies: TREE, frameId: 'body-sun', frameBodyId: 'SUN', openAll: true, groupMin: 1000 });
    let current = '';
    const under = new Map<string, string>();
    for (const r of rows) {
      if (r.type === 'body') current = r.bodyId;
      else if (r.type === 'entity') under.set(r.id, current);
    }
    for (const s of SURFACE_SITES) expect(under.get(s.id), s.id).toBe(s.bodyId);
    expect([...under.values()].includes('EARTH')).toBe(false);
  });

  it('rovers and landers are probes in the browser, the helicopter keeps the existing `drone` rule (Other); all are measured from their body, not Earth orbiters nor deep-space probes', () => {
    for (const r of sites) {
      expect(categoryOf(r), r.id).toBe(r.kind === 'drone' ? 'other' : 'probes');
      expect(viewClass(r), r.id).toBe('surface');
      expect(primaryOf(r), r.id).toBeUndefined();
      expect(typeOf(r), r.id).toBe(r.kind);
    }
  });

  it('a lander with no position yet is still a probe, a rover on the Earth is not a surface site', () => {
    expect(viewClass({ kind: 'rover', bodyId: 'MARS' })).toBe('probe');
    expect(viewClass({ kind: 'rover', bodyId: 'EARTH', provider: { type: 'geodetic', bodyId: 'EARTH', latDeg: 0, lonDeg: 0, altKm: 0 } })).toBe('probe');
    expect(viewClass({ kind: 'ground_station', bodyId: 'EARTH', provider: { type: 'geodetic', bodyId: 'EARTH', latDeg: 0, lonDeg: 0, altKm: 0 } })).toBe('other');
  });

  it('the query rules see them: type:rover, type:lander, type:probes and the body tag', () => {
    const hit = (words: string) => {
      const query: Query = { terms: [termFromWord(words, 'only')!] };
      return sites.filter((r) => isDrawn(classify(r, query))).map((r) => r.id);
    };
    expect(hit('type:rover')).toEqual(expect.arrayContaining(['dsn-M20', 'dsn-MSL', 'site-lunokhod-1', 'site-spirit']));
    expect(hit('type:rover')).not.toContain('site-apollo-11');
    expect(hit('type:lander')).toContain('site-apollo-11');
    expect(hit('type:probes')).toHaveLength(sites.length - 1); // all but the helicopter
    expect(hit('type:other')).toEqual(['site-ingenuity']);
    expect(hit('type:drone')).toEqual(['site-ingenuity']);
  });

  it('scope: they show at their own body and above, not in the Earth view of the whole catalogue', () => {
    const lander = (id: string) => ({ parent: byId[id].bodyId, keep: false, kind: byId[id].kind });
    expect(inScope(lander('site-apollo-11'), scopeBodies('MOON'))).toBe(true);
    expect(inScope(lander('dsn-M20'), scopeBodies('MARS'))).toBe(true);
    expect(inScope(lander('dsn-M20'), scopeBodies('EARTH'))).toBe(false);
    expect(inScope(lander('site-apollo-11'), scopeBodies('EARTH'))).toBe(false);
    expect(inScope({ ...lander('site-apollo-11'), keep: true }, scopeBodies('EARTH'))).toBe(true);
  });

  describe('selection', () => {
    beforeEach(() => {
      useStore.setState({ selectedId: null, follow: false, frame: EARTH_CENTRE, frameLocked: false, focus: null, entities: new Map() });
      useStore.getState().upsertEntities([...bodyEntityRecords(), ...sites], true);
      useStore.setState({ selectedId: null, follow: false, frame: EARTH_CENTRE, frameLocked: false, focus: null });
    });

    it('selectObject selects and follows a lander on the Moon and a rover on Mars with one focus request, leaving the frame alone', () => {
      for (const id of ['site-apollo-11', 'dsn-M20', 'site-huygens']) {
        useStore.setState({ selectedId: null, follow: false, frame: EARTH_CENTRE, focus: null });
        useStore.getState().selectObject(id);
        const s = useStore.getState();
        expect(s.selectedId, id).toBe(id);
        expect(s.follow, id).toBe(true);
        expect(s.frame, id).toBe(EARTH_CENTRE);
        expect(s.focus, id).toMatchObject({ id });
      }
    });
  });

  it('the mock catalogue carries the sites too, so ?mock=1 shows them', async () => {
    const all = (await createMockApi(NOW, 10).entities()).entities;
    for (const id of ['site-apollo-11', 'dsn-M20', 'dsn-MSL', 'site-ingenuity']) expect(all.find((r) => r.id === id), id).toBeDefined();
    expect(all.filter((r) => r.aliases.dsn === 'M20')).toHaveLength(1);
  });
});
