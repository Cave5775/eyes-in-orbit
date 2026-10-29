import { afterEach, describe, expect, it } from 'vitest';
import {
  BodyProvider, BodyRegistry, DEFAULT_BODY_LIST, EntityGraph, bodyDepth, bodyEntityRecords, bodyOf, bodyPeriodSec, bodyStateEci,
  bodyStateInParent, compareHierarchy, convert, defaultBodies, entityRank, equatorToInertialMatrix, isBodyEntity, isOrbitable,
  mulMV, providerFromSpec, setBodyStream, type Sample,
} from '../src';

const DAY = 86400;
const T = Date.UTC(2026, 9, 29, 12);
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const PLANETS = ['MERCURY', 'VENUS', 'EARTH', 'MARS', 'JUPITER', 'SATURN', 'URANUS', 'NEPTUNE'];
const DWARFS = ['CERES', 'PLUTO', 'ERIS', 'HAUMEA', 'MAKEMAKE'];
const MOONS: Record<string, string[]> = {
  EARTH: ['MOON'], MARS: ['PHOBOS', 'DEIMOS'], JUPITER: ['IO', 'EUROPA', 'GANYMEDE', 'CALLISTO'],
  SATURN: ['MIMAS', 'ENCELADUS', 'TETHYS', 'DIONE', 'RHEA', 'TITAN', 'IAPETUS'],
  URANUS: ['MIRANDA', 'ARIEL', 'UMBRIEL', 'TITANIA', 'OBERON'], NEPTUNE: ['TRITON'], PLUTO: ['CHARON'],
};

describe('the solar system registry', () => {
  const bodies = defaultBodies.all();

  it('has 35 bodies with unique ids, every one with a known parent, radius > 0 and GM > 0', () => {
    expect(bodies).toHaveLength(35);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(bodies.length);
    expect(new Set(bodies.map((b) => b.name)).size).toBe(bodies.length);
    for (const b of bodies) {
      expect(b.radiusKm, b.id).toBeGreaterThan(0);
      expect(b.gm, b.id).toBeGreaterThan(0);
      expect(b.flattening, b.id).toBeGreaterThanOrEqual(0);
      expect(b.flattening, b.id).toBeLessThan(0.1);
      if (b.id === 'SUN') expect(b.parentId).toBeUndefined();
      else {
        expect(defaultBodies.has(b.parentId!), b.id).toBe(true);
        expect(b.orbit, b.id).toBeDefined();
        expect(b.orbit!.a, b.id).toBeGreaterThan(0);
        expect(b.orbit!.e, b.id).toBeGreaterThanOrEqual(0);
        expect(b.orbit!.e, b.id).toBeLessThan(0.5);
        // a moon is outside its planet's surface and inside a few million km
        if (b.parentId !== 'SUN') {
          const p = defaultBodies.get(b.parentId!);
          expect(b.orbit!.a * (1 - b.orbit!.e), b.id).toBeGreaterThan(p.radiusKm);
          expect(b.orbit!.a, b.id).toBeLessThan(4e6);
        }
      }
    }
  });

  it('puts the planets and dwarf planets under the Sun and each moon under its planet', () => {
    for (const id of [...PLANETS, ...DWARFS]) expect(defaultBodies.get(id).parentId, id).toBe('SUN');
    for (const [planet, moons] of Object.entries(MOONS)) {
      for (const m of moons) expect(defaultBodies.get(m).parentId, m).toBe(planet);
    }
    expect(defaultBodies.lineage('IO').map((b) => b.id)).toEqual(['IO', 'JUPITER', 'SUN']);
    expect(defaultBodies.lineage('CHARON').map((b) => b.id)).toEqual(['CHARON', 'PLUTO', 'SUN']);
    expect(bodies.filter((b) => b.parentId === 'SUN')).toHaveLength(PLANETS.length + DWARFS.length);
  });

  it('keeps the original four first with unchanged ids, radii and ranks', () => {
    expect(DEFAULT_BODY_LIST.slice(0, 4).map((b) => b.id)).toEqual(['SUN', 'EARTH', 'MOON', 'MARS']);
    expect(defaultBodies.get('MARS').radiusKm).toBe(3396.19);
    expect(defaultBodies.get('EARTH').radiusKm).toBe(6378.137);
    expect(defaultBodies.get('MOON').radiusKm).toBe(1737.4);
    const recs = Object.fromEntries(bodyEntityRecords().map((r) => [r.id, r]));
    expect([recs['body-sun'], recs['body-earth'], recs['body-mars'], recs['body-moon']].map((r) => entityRank(r))).toEqual([0, 1001, 1003, 2002]);
  });

  it('has the real periods (the Kepler orbit around the parent)', () => {
    const days = (id: string) => (bodyPeriodSec(defaultBodies.get(id)) as number) / DAY;
    const near = (id: string, want: number, tol: number) => expect(Math.abs(days(id) / want - 1), id).toBeLessThan(tol);
    near('MERCURY', 87.97, 0.002); near('VENUS', 224.7, 0.002); near('MARS', 686.98, 0.01);
    near('JUPITER', 4332.6, 0.002); near('SATURN', 10759, 0.002); near('URANUS', 30687, 0.002); near('NEPTUNE', 60190, 0.002);
    near('PLUTO', 90560, 0.003); near('CERES', 1681.6, 0.003);
    near('PHOBOS', 0.3189, 0.01); near('DEIMOS', 1.263, 0.01);
    near('IO', 1.769, 0.005); near('EUROPA', 3.551, 0.005); near('GANYMEDE', 7.155, 0.005); near('CALLISTO', 16.689, 0.005);
    // the planet's point-mass GM leaves out J2 and the other moons: a few per cent for the small inner moons
    near('MIMAS', 0.942, 0.03); near('ENCELADUS', 1.370, 0.03); near('TETHYS', 1.888, 0.03); near('DIONE', 2.737, 0.03);
    near('RHEA', 4.518, 0.03); near('TITAN', 15.945, 0.03); near('IAPETUS', 79.32, 0.03);
    near('MIRANDA', 1.413, 0.04); near('ARIEL', 2.520, 0.04); near('UMBRIEL', 4.144, 0.04); near('TITANIA', 8.706, 0.04); near('OBERON', 13.463, 0.04);
    near('TRITON', 5.877, 0.01); near('CHARON', 6.387, 0.01);
  });

  it('gives rotation where the IAU report has it: Eris, Haumea and Makemake render unrotated', () => {
    const none = bodies.filter((b) => b.rotation.kind === 'linear' && b.rotation.rateDegPerDay === 0).map((b) => b.id);
    expect(none.sort()).toEqual(['ERIS', 'HAUMEA', 'MAKEMAKE']);
    for (const b of bodies.filter((x) => !none.includes(x.id) && x.id !== 'EARTH')) {
      const r = b.rotation;
      expect(r.kind, b.id).toBe('linear');
      if (r.kind === 'linear') {
        expect(Math.abs(r.poleDecDeg), b.id).toBeLessThanOrEqual(90);
        expect(r.poleRaDeg, b.id).toBeGreaterThanOrEqual(0);
        expect(r.poleRaDeg, b.id).toBeLessThan(360);
        expect(Math.abs(r.rateDegPerDay), b.id).toBeGreaterThan(1);
      }
    }
    // retrograde rotators: Venus, Uranus and its moons, Triton
    for (const id of ['VENUS', 'URANUS', 'MIRANDA', 'TRITON']) expect((defaultBodies.get(id).rotation as { rateDegPerDay: number }).rateDegPerDay, id).toBeLessThan(0);
  });

  it('keeps every moon on a ring about its planet: the distance is within a(1 -+ e), the latitude within its inclination to the equator', () => {
    for (const [planet, moons] of Object.entries(MOONS)) {
      if (planet === 'EARTH') continue;
      const p = defaultBodies.get(planet);
      const pole = mulMV(equatorToInertialMatrix(p.rotation as Extract<typeof p.rotation, { kind: 'linear' }>), [0, 0, 1]);
      for (const m of moons) {
        const b = defaultBodies.get(m);
        let maxLat = 0;
        for (let k = 0; k < 60; k++) {
          const s = bodyStateInParent(b, T + k * 0.0173 * (bodyPeriodSec(b)! * 1000), defaultBodies)!;
          const r = Math.hypot(...s.r);
          expect(r, m).toBeGreaterThanOrEqual(b.orbit!.a * (1 - b.orbit!.e) * 0.9999);
          expect(r, m).toBeLessThanOrEqual(b.orbit!.a * (1 + b.orbit!.e) * 1.0001);
          maxLat = Math.max(maxLat, Math.abs(Math.asin((s.r[0] * pole[0] + s.r[1] * pole[1] + s.r[2] * pole[2]) / r)));
        }
        const inc = b.orbit!.i > Math.PI / 2 ? Math.PI - b.orbit!.i : b.orbit!.i;
        expect(maxLat, m).toBeLessThanOrEqual(inc + 1e-6);
      }
    }
  });
});

describe('body entities of the whole system', () => {
  const recs = bodyEntityRecords();
  const r = Object.fromEntries(recs.map((x) => [x.id, x]));

  it('has the kinds planet, dwarf_planet and moon by registry role', () => {
    for (const id of PLANETS) expect(r[`body-${id.toLowerCase()}`].kind, id).toBe('planet');
    for (const id of DWARFS) expect(r[`body-${id.toLowerCase()}`].kind, id).toBe('dwarf_planet');
    for (const ms of Object.values(MOONS)) for (const m of ms) expect(r[`body-${m.toLowerCase()}`].kind, m).toBe('moon');
    expect(r['body-sun'].kind).toBe('star');
    expect(recs.filter((x) => x.kind === 'moon')).toHaveLength(21);
  });

  it('nests moons under planets under the Sun: parentId, bodyId and rank', () => {
    expect(r['body-io']).toMatchObject({ bodyId: 'JUPITER', parentId: 'body-jupiter' });
    expect(r['body-charon']).toMatchObject({ bodyId: 'PLUTO', parentId: 'body-pluto' });
    expect(r['body-jupiter']).toMatchObject({ bodyId: 'SUN', parentId: 'body-sun' });
    expect(r['body-pluto']).toMatchObject({ bodyId: 'SUN', parentId: 'body-sun' });
    for (const rec of recs) {
      if (!rec.parentId) continue;
      expect(entityRank(rec), rec.id).toBeGreaterThan(entityRank(r[rec.parentId]));
      expect(bodyDepth(rec.aliases.body), rec.id).toBe(bodyDepth(r[rec.parentId].aliases.body) + 1);
    }
    const sorted = [...recs].reverse().sort((a, b) => compareHierarchy(a, b)).map((x) => x.id);
    expect(sorted[0]).toBe('body-sun');
    // all depth-1 bodies (planets, dwarfs) before any moon, all moons before any object
    const lastDepth1 = Math.max(...recs.filter((x) => x.parentId === 'body-sun').map((x) => sorted.indexOf(x.id)));
    const firstMoon = Math.min(...recs.filter((x) => x.kind === 'moon').map((x) => sorted.indexOf(x.id)));
    expect(lastDepth1).toBeLessThan(firstMoon);
    const probe = { id: 'probe', name: 'p', kind: 'probe', bodyId: 'CHARON', aliases: {}, updatedAt: 1 };
    expect(entityRank(probe)).toBeGreaterThan(Math.max(...recs.map((x) => entityRank(x))));
  });

  it('is findable by the body id, a name and the minor-planet designation; every body is orbitable', () => {
    expect(r['body-pluto'].aliases).toEqual({ body: 'PLUTO', alt: '134340 Pluto' });
    expect(r['body-ceres'].aliases.alt).toBe('1 Ceres');
    expect(r['body-io'].aliases).toEqual({ body: 'IO' });
    for (const rec of recs) {
      expect(isBodyEntity(rec), rec.id).toBe(true);
      expect(isOrbitable(rec), rec.id).toBe(true);
      expect(bodyOf(rec), rec.id).toBe(rec.aliases.body);
      expect(rec.render?.orbitLine, rec.id).toBe(rec.id === 'body-sun' ? undefined : true);
    }
  });

  it('positions: a moon sits at its orbit radius from its planet in EARTH:inertial', () => {
    for (const m of ['IO', 'TITAN', 'TRITON', 'CHARON', 'PHOBOS']) {
      const b = defaultBodies.get(m);
      const rel = bodyStateEci(m, T).r.map((x, k) => x - bodyStateEci(b.parentId!, T).r[k]);
      const r0 = Math.hypot(...rel);
      expect(r0, m).toBeGreaterThanOrEqual(b.orbit!.a * (1 - b.orbit!.e) * 0.9999);
      expect(r0, m).toBeLessThanOrEqual(b.orbit!.a * (1 + b.orbit!.e) * 1.0001);
    }
    // every planet is placed against the Sun the scene draws: planet minus Sun in EARTH:inertial is the planet's own heliocentric state
    for (const p of ['MARS', 'JUPITER', 'NEPTUNE', 'PLUTO']) {
      const rel = bodyStateEci(p, T).r.map((x, k) => x - bodyStateEci('SUN', T).r[k]);
      expect(dist(rel, bodyStateInParent(defaultBodies.get(p), T, defaultBodies)!.r), p).toBeLessThan(1e-3);
    }
    // Jupiter is between 4.9 and 5.5 AU from the Sun
    const j = bodyStateEci('JUPITER', T).r.map((x, k) => x - bodyStateEci('SUN', T).r[k]);
    expect(Math.hypot(...j) / 149_597_870.7).toBeGreaterThan(4.9);
    expect(Math.hypot(...j) / 149_597_870.7).toBeLessThan(5.5);
  });
});

describe('a Horizons stream on a body provider', () => {
  afterEach(() => setBodyStream('JUPITER', undefined));

  // a synthetic stream: the registry's own orbit sampled with velocities
  const sample = (reg: BodyRegistry, id: string, t0: number, stepDays: number, n: number): Sample[] =>
    Array.from({ length: n }, (_, k) => {
      const t = t0 + k * stepDays * 86_400_000;
      const s = bodyStateInParent(reg.get(id), t, reg)!;
      return [t, ...s.r, ...s.v];
    });

  it('keeps entity id, kind and hierarchy when the record carries the stream, and rebuilds through providerFromSpec', () => {
    const reg = new BodyRegistry();
    const samples = sample(reg, 'JUPITER', T - 40 * 86_400_000, 20, 5).map((s) => [s[0], s[1] + 1000, ...s.slice(2)]); // 1000 km off in x
    const base = bodyEntityRecords().find((x) => x.id === 'body-jupiter')!;
    const streamed = { ...base, provider: { type: 'body' as const, bodyId: 'JUPITER', ephemeris: { frame: 'SUN:inertial' as const, samples } } };
    expect({ ...streamed, provider: undefined }).toEqual({ ...base, provider: undefined });
    const graph = new EntityGraph();
    graph.upsert(streamed);
    expect(graph.get('body-jupiter')).toMatchObject({ id: 'body-jupiter', kind: 'planet', parentId: 'body-sun', bodyId: 'SUN' });
    expect(bodyOf(graph.get('body-jupiter')!)).toBe('JUPITER');
    // the provider installed the stream in the default registry: Jupiter relative to the Sun is the sample, not the Kepler orbit
    const s = bodyStateInParent(defaultBodies.get('JUPITER'), T, defaultBodies)!;
    const kep = bodyStateInParent(reg.get('JUPITER'), T, reg)!;
    expect(dist(s.r, kep.r)).toBeGreaterThan(900);
    expect(dist(s.r, kep.r)).toBeLessThan(1100);
    // toSpec round-trips
    const spec = new BodyProvider('JUPITER', new BodyRegistry(), streamed.provider.ephemeris).toSpec();
    expect(spec).toEqual(streamed.provider);
    expect(providerFromSpec(spec)).toBeInstanceOf(BodyProvider);
    // a record without stream stays purely analytic
    expect(new BodyProvider('JUPITER').toSpec()).toEqual({ type: 'body', bodyId: 'JUPITER' });
  });

  it('orbit lines: the period comes from the registry elements; the loop of states stays closed past the end of the sampled window', () => {
    const reg = new BodyRegistry();
    const samples = sample(reg, 'NEPTUNE', T - 365 * 86_400_000, 60, 13); // 2 years of a 165 year orbit
    expect(setBodyStream('NEPTUNE', { frame: 'SUN:inertial', samples }, reg)).toBe(true);
    const period = bodyPeriodSec(reg.get('NEPTUNE'), reg)!;
    expect(period / (365.25 * DAY)).toBeGreaterThan(160);
    const s0 = convert(bodyStateEci('NEPTUNE', T, reg), 'SUN:inertial', T, reg).r;
    // one period later (outside the window: the Kepler orbit) the planet is back where it started
    const s1 = convert(bodyStateEci('NEPTUNE', T + period * 1000, reg), 'SUN:inertial', T + period * 1000, reg).r;
    expect(dist(s0, s1) / Math.hypot(...s0)).toBeLessThan(0.01);
    // inside the window the stream equals the elements it was sampled from, to the Hermite error
    const fresh = new BodyRegistry();
    expect(dist(bodyStateInParent(reg.get('NEPTUNE'), T, reg)!.r, bodyStateInParent(fresh.get('NEPTUNE'), T, fresh)!.r)).toBeLessThan(5);
  });
});

describe('constants verified against external sources (2026-10-29)', () => {
  it('pins the rotation constants corrected against NAIF pck00011.tpc (constant terms of the IAU WGCCRE 2015 series)', () => {
    const rot = (id: string) => defaultBodies.get(id).rotation as { poleRaDeg: number; poleDecDeg: number; w0Deg: number; rateDegPerDay: number };
    expect(rot('DIONE').w0Deg).toBe(357.6); // BODY604_PM = ( 357.6 131.5349316 0. )
    expect(rot('PHOBOS')).toMatchObject({ poleRaDeg: 317.67071657, poleDecDeg: 52.88627266, w0Deg: 35.1877444, rateDegPerDay: 1128.84475928 });
    expect(rot('DEIMOS')).toMatchObject({ poleRaDeg: 316.65705808, poleDecDeg: 53.50992033, w0Deg: 79.39932954, rateDegPerDay: 285.16188899 });
  });
});
