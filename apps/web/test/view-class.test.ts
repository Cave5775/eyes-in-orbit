import { describe, expect, it } from 'vitest';
import { bodyEntityRecords, type EntityRecord } from '@eio/core';
import { categoryOf, matchesType } from '../src/lib/browser-ui';
import { settleView } from '../src/lib/camera';
import { NEAR_ORBIT_KM, primaryOf, viewClass } from '../src/lib/view-class';
import { mockBodies, mockGroundAndProbes, mockLaunches, mockSatellites } from '../src/mock/generators';
import { DSN_TARGETS, probeEntity } from '../../server/src/connectors/dsn-targets';

const rec = (kind: string, bodyId: string, provider?: EntityRecord['provider']): EntityRecord => ({ id: 'x', name: 'x', kind, bodyId, aliases: {}, provider, updatedAt: 0 });

describe('viewClass', () => {
  it('table of the rule', () => {
    const sampled = { type: 'sampled', frame: 'MARS:inertial', samples: [] } as unknown as EntityRecord['provider'];
    const geodetic = { type: 'geodetic', bodyId: 'MARS', latDeg: 0, lonDeg: 0, altKm: 0 } as EntityRecord['provider'];
    const cases: [string, EntityRecord, number | undefined, string][] = [
      ['Mars orbiter', rec('probe', 'MARS', sampled), undefined, 'orbiter'],
      ['Moon orbiter', rec('probe', 'MOON', sampled), undefined, 'orbiter'],
      ['Mars-bound satellite', rec('satellite', 'MARS', sampled), undefined, 'orbiter'],
      ['Mars rover on the ground', rec('rover', 'MARS', geodetic), undefined, 'probe'],
      ['lander', rec('lander', 'MARS', geodetic), undefined, 'probe'],
      ['probe fixed on a surface', rec('probe', 'MARS', geodetic), undefined, 'probe'],
      ['Voyager (far, Earth bodyId)', rec('probe', 'EARTH'), 2.5e10, 'probe'],
      ['JWST at L2', rec('probe', 'EARTH'), 1.5e6, 'probe'],
      ['probe without position', rec('probe', 'EARTH'), undefined, 'probe'],
      ['probe in near-Earth orbit', rec('probe', 'EARTH'), NEAR_ORBIT_KM - 1, 'satellite'],
      ['heliocentric probe', rec('probe', 'SUN'), undefined, 'probe'],
      ['ISS', rec('station', 'EARTH'), 6800, 'satellite'],
      ['Earth satellite', rec('satellite', 'EARTH'), 7000, 'satellite'],
      ['launch vehicle', rec('launch_vehicle', 'EARTH'), undefined, 'other'],
      ['ground station', rec('ground_station', 'EARTH'), undefined, 'other'],
      ['unknown body id', rec('probe', 'CERES9'), undefined, 'probe'],
    ];
    for (const [name, r, km, want] of cases) expect(viewClass(r, km), name).toBe(want);
  });

  it('body entities are bodies', () => {
    for (const b of bodyEntityRecords()) expect(viewClass(b), b.id).toBe('body');
  });

  it('primaryOf is the body of an orbiter only', () => {
    expect(primaryOf(rec('probe', 'MARS'))).toBe('MARS');
    expect(primaryOf(rec('probe', 'EARTH'))).toBeUndefined();
  });

  it('server connector kinds: Mars orbiters and LRO are orbiters, the rest probes', () => {
    const cls: Record<string, string> = {};
    for (const code of Object.keys(DSN_TARGETS)) cls[code] = viewClass(probeEntity(code) as EntityRecord);
    for (const code of ['MRO', 'ODY', 'MVN', 'TGO', 'MEX', 'LRO']) expect(cls[code], code).toBe('orbiter');
    for (const code of ['VGR1', 'JWST', 'NHPC', 'M20', 'MSL', 'JNO', 'PSP']) expect(cls[code], code).toBe('probe');
  });

  it('mock catalogue', () => {
    const now = Date.UTC(2026, 5, 1);
    const probes = Object.fromEntries(mockGroundAndProbes(now).filter((e) => e.group === 'dsn' && e.kind === 'probe').map((e) => [e.id, e]));
    expect(viewClass(probes['dsn-MRO'])).toBe('orbiter');
    expect(viewClass(probes['dsn-LRO'])).toBe('orbiter');
    expect(viewClass(probes['dsn-VGR1'])).toBe('probe');
    expect(viewClass(probes['dsn-JWST'])).toBe('probe');
    for (const b of mockBodies(now)) expect(viewClass(b)).toBe('body');
    for (const s of mockSatellites(now, 40)) expect(viewClass(s, 7000)).toBe(['satellite', 'station'].includes(s.kind) ? 'satellite' : 'other');
    for (const e of mockLaunches(now).entities) expect(['satellite', 'other']).toContain(viewClass(e, 7000));
  });

  it('category: orbiters of other bodies are satellites, deep-space probes stay probes', () => {
    const now = Date.UTC(2026, 5, 1);
    const all = Object.fromEntries(mockGroundAndProbes(now).map((e) => [e.id, e]));
    expect(categoryOf(all['dsn-MRO'])).toBe('satellites');
    expect(categoryOf(all['dsn-LRO'])).toBe('satellites');
    expect(categoryOf(all['dsn-VGR1'])).toBe('probes');
    expect(categoryOf(all['dsn-JWST'])).toBe('probes');
    expect(categoryOf(rec('rover', 'MARS'))).toBe('probes');
    expect(matchesType(all['dsn-MRO'], 'probes')).toBe(false);
    expect(matchesType(all['dsn-MRO'], 'satellites')).toBe(true);
    expect(matchesType(all['dsn-MRO'], 'probe')).toBe(true); // `probe` is still its kind
  });
});

describe('settleView', () => {
  it('an orbiter is viewed from its primary, not from the Earth', () => {
    const mars: [number, number, number] = [1e8, 0, 0];
    const orbiter: [number, number, number] = [1e8 + 3800, 0, 0];
    expect(settleView(orbiter).dist).toBeGreaterThan(1e7);
    expect(settleView(orbiter, mars).dist).toBe(3200);
  });
});
