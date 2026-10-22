import { describe, expect, it } from 'vitest';
import type { DsnSnapshot, EntityRecord, Launch } from '@eio/core';
import { relatedFor } from '../src/lib/related';

const rec = (over: Partial<EntityRecord> & { id: string }): EntityRecord => ({
  name: over.id, kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0, ...over,
});
const geo = (latDeg: number, lonDeg: number) => ({ type: 'geodetic', bodyId: 'EARTH', latDeg, lonDeg, altKm: 0 }) as const;
const mapOf = (...rs: EntityRecord[]) => new Map(rs.map((r) => [r.id, r]));

describe('relatedFor', () => {
  it('returns just the entity when nothing is related', () => {
    const a = rec({ id: 'sat-1' });
    expect(relatedFor(a, { entities: mapOf(a), launches: [], dsn: null })).toEqual({ ids: ['sat-1'], points: [] });
  });

  it('includes the parent and the children via parentId', () => {
    const parent = rec({ id: 'parent' });
    const mid = rec({ id: 'mid', parentId: 'parent' });
    const kid = rec({ id: 'kid', parentId: 'mid' });
    const other = rec({ id: 'other' });
    const ctx = { entities: mapOf(parent, mid, kid, other), launches: [], dsn: null };
    expect(relatedFor(mid, ctx).ids.sort()).toEqual(['kid', 'mid', 'parent']);
    expect(relatedFor(parent, ctx).ids.sort()).toEqual(['mid', 'parent']);
    // a dangling parent is ignored
    const orphan = rec({ id: 'orphan', parentId: 'gone' });
    expect(relatedFor(orphan, { entities: mapOf(orphan), launches: [], dsn: null }).ids).toEqual(['orphan']);
  });

  it('frames a launch vehicle with its pad point and nearby pad entities', () => {
    const veh = rec({ id: 'launch-1', kind: 'launch_vehicle', provider: geo(28.6082, -80.6041), links: { launchId: 'L1' } });
    const pad = rec({ id: 'pad-39a', kind: 'pad', provider: geo(28.6083, -80.604) });
    const far = rec({ id: 'pad-far', kind: 'pad', provider: geo(34.6, -120.6) });
    const launch = { id: 'L1', entityId: 'launch-1', pad: { name: '39A', latitude: 28.6082, longitude: -80.6041 } } as Launch;
    const r = relatedFor(veh, { entities: mapOf(veh, pad, far), launches: [launch], dsn: null });
    expect(r.ids.sort()).toEqual(['launch-1', 'pad-39a']);
    expect(r.points).toEqual([{ latDeg: 28.6082, lonDeg: -80.6041 }]);
  });

  it('follows the relative parents and the pad of a composite booster', () => {
    const lz = rec({ id: 'demo-lz', kind: 'pad', provider: geo(28.5, -80.55) });
    const pad = rec({ id: 'demo-pad', kind: 'pad', provider: geo(28.6082, -80.6041) });
    const booster = rec({
      id: 'demo-booster', kind: 'stage',
      provider: {
        type: 'composite',
        segments: [
          { fromMs: 0, toMs: 9, phase: 'pad', spec: geo(28.6082, -80.6041) },
          { fromMs: 10, toMs: 19, phase: 'landing', spec: { type: 'relative', parentId: 'demo-lz', mode: 'enu', offsetKm: [0, 0, 1] } },
        ],
      },
    });
    const drone = rec({ id: 'demo-drone', kind: 'drone', parentId: 'demo-booster' });
    const r = relatedFor(booster, { entities: mapOf(lz, pad, booster, drone), launches: [], dsn: null });
    expect(r.ids.sort()).toEqual(['demo-booster', 'demo-drone', 'demo-lz', 'demo-pad']);
    expect(r.points).toEqual([{ latDeg: 28.6082, lonDeg: -80.6041 }]);
  });

  it('links a DSN ground station with the probes it is linked to (not the other way round)', () => {
    const gold = rec({ id: 'dsn-goldstone', name: 'Goldstone DSN Complex', kind: 'ground_station', aliases: { dsn: 'GDSCC' } });
    const madrid = rec({ id: 'dsn-madrid', name: 'Madrid DSN Complex', kind: 'ground_station', aliases: { dsn: 'Madrid' } });
    const vgr = rec({ id: 'dsn-VGR1', kind: 'probe', aliases: { dsn: 'VGR1' } });
    const jwst = rec({ id: 'dsn-JWST', kind: 'probe', aliases: { dsn: 'JWST' } });
    const mro = rec({ id: 'dsn-MRO', kind: 'probe', aliases: { dsn: 'MRO' } });
    const dsn: DsnSnapshot = {
      fetchedAt: 0,
      links: [
        { dish: 'DSS-14', complex: 'Goldstone', spacecraft: ['VGR1', 'MRO'] },
        { dish: 'DSS-63', complex: 'Madrid', spacecraft: ['JWST'] },
      ],
    };
    const ctx = { entities: mapOf(gold, madrid, vgr, jwst, mro), launches: [], dsn };
    expect(relatedFor(gold, ctx).ids.sort()).toEqual(['dsn-MRO', 'dsn-VGR1', 'dsn-goldstone']);
    // a probe is framed alone: with an Earth station in the set its own path would be dwarfed
    expect(relatedFor(jwst, ctx).ids).toEqual(['dsn-JWST']);
    expect(relatedFor(vgr, ctx).ids).toEqual(['dsn-VGR1']);
    // a probe code with no entity is skipped
    const withGhost = { ...ctx, dsn: { fetchedAt: 0, links: [{ dish: 'x', complex: 'Madrid', spacecraft: ['NOPE', 'JWST'] }] } };
    expect(relatedFor(madrid, withGhost).ids.sort()).toEqual(['dsn-JWST', 'dsn-madrid']);
  });
});
