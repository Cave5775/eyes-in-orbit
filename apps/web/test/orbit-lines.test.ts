import { describe, expect, it } from 'vitest';
import { BodyRegistry, ORIGINAL_BODIES, bodyEntityRecords as allBodyEntityRecords, type EntityRecord } from '@eio/core';
import { DIM, dimmed } from '../src/lib/dim';
import { CHILD_ORBIT_LIMIT, orbitLines, type OrbitLineSpec } from '../src/lib/orbit-lines';

/** these tests describe the original Sun, Earth, Moon, Mars hierarchy */
const bodyEntityRecords = () => allBodyEntityRecords(new BodyRegistry(ORIGINAL_BODIES));
const sgp4 = { type: 'sgp4' as const, omm: {} as never };
const sampled = (frame: 'EARTH:inertial' | 'MOON:inertial') => ({ type: 'sampled' as const, frame, samples: [] });
const obj = (id: string, bodyId: string, extra: Partial<EntityRecord> = {}): EntityRecord => ({
  id, name: id, kind: 'satellite', bodyId, aliases: {}, provider: sgp4, updatedAt: 0, ...extra,
});
const iss = obj('sat-25544', 'EARTH', { render: { orbitLine: true, footprint: true } });
const payload = obj('launch-1-payload', 'EARTH', { render: { orbitLine: true } });
const lro = obj('dsn-LRO', 'MOON', { kind: 'probe', provider: sampled('MOON:inertial') });
const starlink = (i: number) => obj(`sat-${i}`, 'EARTH');
const probe = obj('dsn-VGR', 'SUN', { kind: 'probe', provider: sampled('EARTH:inertial') });

const catalog = (...extra: EntityRecord[]): Map<string, EntityRecord> => new Map([...bodyEntityRecords(), ...extra].map((r) => [r.id, r]));
const ids = (l: OrbitLineSpec[]) => l.map((x) => x.id);
const roles = (l: OrbitLineSpec[], role: string) => l.filter((x) => x.role === role).map((x) => x.id);

describe('orbitLines: the one rule', () => {
  it('draws nothing without a selection or with an unknown one', () => {
    const recs = catalog(iss, lro);
    expect(orbitLines(recs, null)).toEqual([]);
    expect(orbitLines(recs, 'nope')).toEqual([]);
  });

  it('a selected object is its own trajectory only: it has no children', () => {
    const recs = catalog(iss, payload, lro);
    expect(orbitLines(recs, 'sat-25544')).toEqual([{ id: 'sat-25544', role: 'selected' }]);
    expect(orbitLines(recs, 'dsn-LRO')).toEqual([{ id: 'dsn-LRO', role: 'selected' }]);
  });

  it('the Earth: its own orbit in full, the Moon and its flagged satellites dimmed, nothing from other bodies', () => {
    const recs = catalog(iss, payload, lro, probe, starlink(1), starlink(2));
    const l = orbitLines(recs, 'body-earth');
    expect(roles(l, 'selected')).toEqual(['body-earth']);
    expect(roles(l, 'child').sort()).toEqual(['body-moon', 'launch-1-payload', 'sat-25544']);
    // LRO orbits the Moon, Voyager the Sun, an unflagged SGP4 satellite has no line
    expect(ids(l)).not.toContain('dsn-LRO');
    expect(ids(l)).not.toContain('dsn-VGR');
    expect(ids(l)).not.toContain('sat-1');
  });

  it('the Moon: its own orbit and its probes dimmed (LRO needs no flag: it has an ephemeris)', () => {
    const l = orbitLines(catalog(iss, lro), 'body-moon');
    expect(l).toEqual([{ id: 'body-moon', role: 'selected' }, { id: 'dsn-LRO', role: 'child' }]);
  });

  it('the Sun: no orbit line of its own, the planets and its probes dimmed', () => {
    const l = orbitLines(catalog(iss, probe), 'body-sun');
    expect(roles(l, 'selected')).toEqual([]);
    expect(roles(l, 'child')).toEqual(['body-earth', 'body-mars', 'dsn-VGR']);
  });

  it('Mars: its own orbit, no children of the other bodies', () => {
    expect(orbitLines(catalog(iss, lro), 'body-mars')).toEqual([{ id: 'body-mars', role: 'selected' }]);
  });

  it('a hidden child keeps no line, the selection is always drawn', () => {
    const recs = catalog(iss, payload);
    const l = orbitLines(recs, 'body-earth', (r) => r.id !== 'sat-25544');
    expect(ids(l)).not.toContain('sat-25544');
    expect(ids(l)).toContain('launch-1-payload');
    expect(orbitLines(recs, 'sat-25544', () => false)).toEqual([{ id: 'sat-25544', role: 'selected' }]);
  });

  it('depends on the selection and the catalog only: the frame is not an input', () => {
    // two calls for the same selection are the same lines, whatever the frame or the lock of the view is
    expect(orbitLines.length).toBeLessThanOrEqual(3);
    const recs = catalog(iss, payload, lro);
    expect(orbitLines(recs, 'dsn-LRO')).toEqual(orbitLines(recs, 'dsn-LRO'));
  });
});

describe('orbitLines: the cap on children', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => obj(`flag-${String(i).padStart(3, '0')}`, 'EARTH', { render: { orbitLine: true }, updatedAt: i }));

  it('never draws more than CHILD_ORBIT_LIMIT children, thousands of satellites included', () => {
    const recs = catalog(iss, ...many(40), ...Array.from({ length: 3000 }, (_, i) => starlink(100 + i)));
    const l = orbitLines(recs, 'body-earth');
    expect(roles(l, 'child')).toHaveLength(CHILD_ORBIT_LIMIT);
    expect(roles(l, 'selected')).toEqual(['body-earth']);
    expect(CHILD_ORBIT_LIMIT).toBe(12);
  });

  it('orders bodies first, then flagged objects, then the other objects, newest first within a group', () => {
    const plain = obj('dsn-A', 'EARTH', { provider: sampled('EARTH:inertial'), updatedAt: 1000 });
    const flagOld = obj('flag-old', 'EARTH', { render: { orbitLine: true }, updatedAt: 1 });
    const flagNew = obj('flag-new', 'EARTH', { render: { orbitLine: true }, updatedAt: 2 });
    expect(roles(orbitLines(catalog(plain, flagOld, flagNew), 'body-earth'), 'child')).toEqual(['body-moon', 'flag-new', 'flag-old', 'dsn-A']);
  });

  it('keeps the bodies and the flagged objects when the cap cuts the rest', () => {
    const plain = Array.from({ length: 30 }, (_, i) => obj(`dsn-${i}`, 'EARTH', { provider: sampled('EARTH:inertial'), updatedAt: i }));
    const l = orbitLines(catalog(...plain, iss), 'body-earth');
    expect(roles(l, 'child').slice(0, 2)).toEqual(['body-moon', 'sat-25544']);
    expect(roles(l, 'child')).toHaveLength(CHILD_ORBIT_LIMIT);
  });

  it('is the same set on every call: it does not depend on the camera or the clock', () => {
    const recs = catalog(...many(30));
    expect(orbitLines(recs, 'body-earth')).toEqual(orbitLines(recs, 'body-earth'));
  });
});

describe('dim: one amount for points and lines', () => {
  it('dims a colour channel by the shared factor', () => {
    expect(dimmed(1)).toBe(DIM.colour);
    expect(dimmed(0.5)).toBeCloseTo(0.5 * DIM.colour, 12);
    expect(DIM.colour).toBeLessThan(1);
    expect(DIM.size).toBeLessThan(1);
  });
});
