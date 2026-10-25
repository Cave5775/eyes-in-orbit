import { describe, expect, it } from 'vitest';
import {
  BodyProvider, bodyDepth, bodyEntityId, bodyEntityRecords, bodyOf, bodyPeriodSec, bodyStateEci, compareHierarchy, convert,
  defaultBodies, entityRank, isBodyEntity, isOrbitable, moonPositionEci, moonStateEci, providerFromSpec, sunPositionEci,
  type EntityRecord,
} from '../src';

const T = Date.UTC(2026, 9, 24, 12);
const DAY = 86400;

const byId = (recs: EntityRecord[]) => Object.fromEntries(recs.map((r) => [r.id, r]));

function obj(id: string, bodyId: string, extra: Partial<EntityRecord> = {}): EntityRecord {
  return { id, name: id, kind: 'probe', bodyId, aliases: {}, updatedAt: 1000, ...extra };
}

describe('BodyProvider', () => {
  it('equals the scene positions exactly', () => {
    for (const t of [T, Date.UTC(2000, 0, 1), Date.UTC(2031, 4, 5)]) {
      const moon = new BodyProvider('MOON').stateAt(t);
      expect(moon.frame).toBe('EARTH:inertial');
      expect(moon.r).toEqual(moonPositionEci(t));
      expect(moon.v).toEqual(moonStateEci(t).v);
      expect(moon.confidence).toBe(1);
      const sun = new BodyProvider('SUN').stateAt(t);
      expect(sun.r).toEqual(sunPositionEci(t));
      expect(Math.hypot(...(sun.v as [number, number, number]))).toBeGreaterThan(20); // about 30 km/s
      expect(Math.hypot(...(sun.v as [number, number, number]))).toBeLessThan(35);
      const earth = new BodyProvider('EARTH').stateAt(t);
      expect(earth.r).toEqual([0, 0, 0]);
      expect(earth.v).toEqual([0, 0, 0]);
    }
  });

  it('puts other bodies through the frame hop', () => {
    const want = convert({ frame: 'MARS:inertial', r: [0, 0, 0], v: [0, 0, 0] }, 'EARTH:inertial', T);
    const got = new BodyProvider('MARS').stateAt(T);
    expect(got.r).toEqual(want.r);
    expect(got.v).toEqual(want.v);
    expect(bodyStateEci('MARS', T)).toEqual(want);
    expect(Math.hypot(...got.r)).toBeGreaterThan(5e7);
  });

  it('survives a JSON round trip of its spec for every body record', () => {
    for (const rec of bodyEntityRecords()) {
      const spec = JSON.parse(JSON.stringify(rec.provider));
      const p = providerFromSpec(spec);
      expect(p.type).toBe('body');
      expect(p.toSpec()).toEqual(spec);
      expect(p.stateAt(T)).toEqual(new BodyProvider(spec.bodyId).stateAt(T));
    }
  });
});

describe('bodyEntityRecords', () => {
  const recs = bodyEntityRecords();
  const r = byId(recs);

  it('has one record per registry body with the documented ids and kinds', () => {
    expect(recs.map((x) => x.id)).toEqual(['body-sun', 'body-earth', 'body-moon', 'body-mars']);
    expect(recs.map((x) => x.kind)).toEqual(['star', 'planet', 'moon', 'planet']);
    expect(recs.map((x) => x.name)).toEqual(['Sun', 'Earth', 'Moon', 'Mars']);
    for (const x of recs) {
      expect(x.group).toBe('bodies');
      expect(x.aliases.body).toBe(x.id.slice(5).toUpperCase());
      expect(x.provider).toEqual({ type: 'body', bodyId: x.aliases.body });
      expect(x.render).toMatchObject({ label: true, colorKey: 'body' });
      expect(x.attrs).toMatchObject({ radiusKm: expect.any(Number), gm: expect.any(Number), approx: expect.any(Boolean) });
      expect(x.updatedAt).toBe(0);
      expect(JSON.parse(JSON.stringify(x))).toEqual(x);
    }
  });

  it('links each body to the body it orbits', () => {
    expect(r['body-moon']).toMatchObject({ bodyId: 'EARTH', parentId: 'body-earth' });
    expect(r['body-earth']).toMatchObject({ bodyId: 'SUN', parentId: 'body-sun' });
    expect(r['body-mars']).toMatchObject({ bodyId: 'SUN', parentId: 'body-sun' });
    expect(r['body-sun'].bodyId).toBe('SUN');
    expect('parentId' in r['body-sun']).toBe(false);
  });

  it('draws orbit lines for everything but the Sun and has search aliases and periods', () => {
    expect(r['body-sun'].render?.orbitLine).toBeUndefined();
    for (const id of ['body-earth', 'body-moon', 'body-mars']) expect(r[id].render?.orbitLine).toBe(true);
    expect(r['body-sun'].aliases.alt).toBe('Sol');
    expect(r['body-earth'].aliases.alt).toBe('Terra');
    expect(r['body-moon'].aliases.alt).toBe('Luna');
    expect(r['body-sun'].attrs).not.toHaveProperty('periodDays');
    expect(r['body-moon'].attrs?.periodDays).toBeCloseTo(bodyPeriodSec(defaultBodies.get('MOON')) as number / DAY, 9);
  });

  it('takes updatedAt', () => {
    expect(bodyEntityRecords(defaultBodies, 42).every((x) => x.updatedAt === 42)).toBe(true);
  });
});

describe('bodyPeriodSec', () => {
  const days = (id: string) => (bodyPeriodSec(defaultBodies.get(id)) as number) / DAY;
  it('is about the real sidereal period', () => {
    expect(days('MOON')).toBeGreaterThan(27.2);
    expect(days('MOON')).toBeLessThan(27.5);
    expect(days('EARTH')).toBeGreaterThan(364.5);
    expect(days('EARTH')).toBeLessThan(366);
    expect(days('MARS')).toBeGreaterThan(685);
    expect(days('MARS')).toBeLessThan(689);
  });
  it('is undefined for the Sun', () => {
    expect(bodyPeriodSec(defaultBodies.get('SUN'))).toBeUndefined();
  });
});

describe('hierarchy', () => {
  const recs = byId(bodyEntityRecords());

  it('bodyDepth is the lineage length minus one', () => {
    expect(['SUN', 'EARTH', 'MARS', 'MOON'].map((id) => bodyDepth(id, defaultBodies))).toEqual([0, 1, 1, 2]);
  });

  it('orders bodies before objects, higher primaries first', () => {
    const sat = obj('sat-1', 'EARTH', { kind: 'satellite' });
    const lroLike = obj('probe-moon', 'MOON');
    const sunProbe = obj('probe-sun', 'SUN');
    const marsProbe = obj('probe-mars', 'MARS');
    const shuffled = [lroLike, sat, recs['body-moon'], sunProbe, recs['body-mars'], recs['body-earth'], marsProbe, recs['body-sun']];
    const sorted = shuffled.sort((a, b) => compareHierarchy(a, b)).map((x) => x.id);
    expect(sorted.slice(0, 4)).toEqual(['body-sun', 'body-earth', 'body-mars', 'body-moon']);
    expect(sorted[4]).toBe('probe-sun');
    expect(sorted.slice(5, 7).sort()).toEqual(['probe-mars', 'sat-1']); // same level: recency / id
    expect(sorted[7]).toBe('probe-moon');
  });

  it('ranks a body before everything that orbits it', () => {
    for (const id of ['SUN', 'EARTH', 'MOON', 'MARS']) {
      const body = recs[`body-${id.toLowerCase()}`];
      expect(entityRank(body)).toBeLessThan(entityRank(obj('x', id)));
    }
  });

  it('puts the most recent first within a level: createdAt, else updatedAt', () => {
    const old = obj('a-old', 'EARTH', { createdAt: 100, updatedAt: 9000 });
    const fresh = obj('b-new', 'EARTH', { createdAt: 500, updatedAt: 600 });
    expect([old, fresh].sort((a, b) => compareHierarchy(a, b)).map((x) => x.id)).toEqual(['b-new', 'a-old']);
    const u1 = obj('u1', 'EARTH', { updatedAt: 10 });
    const u2 = obj('u2', 'EARTH', { updatedAt: 20 });
    const c = obj('c', 'EARTH', { createdAt: 15, updatedAt: 1 });
    expect([u1, c, u2].sort((a, b) => compareHierarchy(a, b)).map((x) => x.id)).toEqual(['u2', 'c', 'u1']);
    // equal time: by id
    expect(compareHierarchy(obj('a', 'EARTH'), obj('b', 'EARTH'))).toBeLessThan(0);
    // rank beats recency
    expect(compareHierarchy(obj('moon', 'MOON', { createdAt: 9e9 }), obj('earth', 'EARTH', { createdAt: 1 }))).toBeGreaterThan(0);
  });

  it('ranks an unknown primary body last', () => {
    expect(entityRank(obj('x', 'PLUTO'))).toBeGreaterThan(entityRank(obj('y', 'MOON')));
  });

  it('bodyOf is the one converter from a body entity to its registry id', () => {
    expect(isBodyEntity(recs['body-moon'])).toBe(true);
    expect(bodyOf(recs['body-moon'])).toBe('MOON');
    expect(bodyOf(recs['body-sun'])).toBe('SUN');
    expect(bodyOf(recs['body-earth'])).toBe('EARTH');
    expect(isBodyEntity(obj('sat-1', 'EARTH'))).toBe(false);
    expect(bodyOf(obj('sat-1', 'EARTH'))).toBeUndefined();
    // a flagged entity is orbitable but is not a body: no registry id
    expect(bodyOf(obj('ast-1', 'SUN', { kind: 'asteroid', attrs: { orbitable: true } }))).toBeUndefined();
    // and the entity id is the registry id lower-cased with the body- prefix
    for (const b of defaultBodies.all()) expect(bodyOf(recs[bodyEntityId(b.id)])).toBe(b.id);
  });

  it('isOrbitable: body entities and entities flagged attrs.orbitable', () => {
    for (const id of ['body-sun', 'body-earth', 'body-moon', 'body-mars']) expect(isOrbitable(recs[id])).toBe(true);
    expect(isOrbitable(obj('sat-1', 'EARTH'))).toBe(false);
    expect(isOrbitable(obj('ast-1', 'SUN', { kind: 'asteroid', attrs: { orbitable: true } }))).toBe(true);
    expect(isOrbitable(obj('x', 'SUN', { attrs: { orbitable: false } }))).toBe(false);
    expect(isOrbitable(obj('y', 'SUN', { attrs: { orbitable: 'yes' } }))).toBe(false); // only the boolean true counts
  });
});
