import { afterEach, describe, expect, it } from 'vitest';
import {
  BodyProvider, BodyRegistry, DEFAULT_BODY_LIST, EntityGraph, bodyDepth, bodyEntityRecords, bodyOf, bodyPeriodSec, bodyStateEci,
  bodyStateInParent, compareHierarchy, convert, defaultBodies, entityRank, equatorToInertialMatrix, isBodyEntity, isOrbitable,
  mulMV, precessDir, providerFromSpec, setBodyStream, eclipticToEquatorial, DEG, NO_ROTATION, type Sample,
} from '../src';

const DAY = 86400;
const T = Date.UTC(2026, 9, 29, 12);
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const PLANETS = ['MERCURY', 'VENUS', 'EARTH', 'MARS', 'JUPITER', 'SATURN', 'URANUS', 'NEPTUNE'];
const DWARFS = ['CERES', 'PLUTO', 'ERIS', 'HAUMEA', 'MAKEMAKE'];
const MOONS: Record<string, string[]> = {
  EARTH: ['MOON'], MARS: ['PHOBOS', 'DEIMOS'], JUPITER: ['IO', 'EUROPA', 'GANYMEDE', 'CALLISTO', 'AMALTHEA', 'THEBE'],
  SATURN: ['MIMAS', 'ENCELADUS', 'TETHYS', 'DIONE', 'RHEA', 'TITAN', 'IAPETUS', 'HYPERION'],
  URANUS: ['MIRANDA', 'ARIEL', 'UMBRIEL', 'TITANIA', 'OBERON', 'PUCK'],
  NEPTUNE: ['TRITON', 'DESPINA', 'GALATEA', 'LARISSA', 'PROTEUS'], PLUTO: ['CHARON', 'NIX', 'HYDRA'],
};
/** Moons whose orbit is given in the ecliptic of J2000 (SSD frame `ecliptic`) with all six elements: far out, eccentric, no rotation model. */
const ECLIPTIC_MOONS: Record<string, string> = { HIMALIA: 'JUPITER', NEREID: 'NEPTUNE', PHOEBE: 'SATURN', JANUS: 'SATURN', EPIMETHEUS: 'SATURN', DIMORPHOS: 'DIDYMOS' };
/** The named asteroids (entity kind `asteroid`), appended after the 50 earlier bodies in this order; Dimorphos, their moon, is last. */
const ASTEROIDS = ['VESTA', 'PALLAS', 'HYGIEA', 'PSYCHE', 'BENNU', 'RYUGU', 'DIDYMOS', 'APOPHIS', 'EROS', 'ITOKAWA', 'ARROKOTH'];
/** Moons with no GM in any source (the SSD page lists Nereid as 0.00000, Puck has no row): GM 0 means "not determined". */
const NO_GM = ['NEREID', 'PUCK', 'BENNU', 'APOPHIS', 'ARROKOTH'];
/** The original 35 bodies in registry order: entityRank uses the index, so new bodies are only ever appended. */
const FIRST_35 = ['SUN', 'EARTH', 'MOON', 'MARS', 'MERCURY', 'VENUS', 'JUPITER', 'SATURN', 'URANUS', 'NEPTUNE', 'CERES', 'PLUTO', 'ERIS', 'HAUMEA', 'MAKEMAKE',
  'PHOBOS', 'DEIMOS', 'IO', 'EUROPA', 'GANYMEDE', 'CALLISTO', 'MIMAS', 'ENCELADUS', 'TETHYS', 'DIONE', 'RHEA', 'TITAN', 'IAPETUS',
  'MIRANDA', 'ARIEL', 'UMBRIEL', 'TITANIA', 'OBERON', 'TRITON', 'CHARON'];

describe('the solar system registry', () => {
  const bodies = defaultBodies.all();

  it('has 62 bodies with unique ids, every one with a known parent, radius > 0 and GM > 0 (but Nereid, Puck, Bennu, Apophis and Arrokoth, GM not determined)', () => {
    expect(bodies).toHaveLength(62);
    expect(DEFAULT_BODY_LIST.slice(0, 35).map((b) => b.id)).toEqual(FIRST_35);
    expect(DEFAULT_BODY_LIST.slice(50).map((b) => b.id)).toEqual([...ASTEROIDS, 'DIMORPHOS']);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(bodies.length);
    expect(new Set(bodies.map((b) => b.name)).size).toBe(bodies.length);
    for (const b of bodies) {
      expect(b.radiusKm, b.id).toBeGreaterThan(0);
      if (NO_GM.includes(b.id)) expect(b.gm, b.id).toBe(0);
      else expect(b.gm, b.id).toBeGreaterThan(0);
      expect(b.flattening, b.id).toBeGreaterThanOrEqual(0);
      expect(b.flattening, b.id).toBeLessThan(0.1);
      if (b.id === 'SUN') expect(b.parentId).toBeUndefined();
      else {
        expect(defaultBodies.has(b.parentId!), b.id).toBe(true);
        expect(b.orbit, b.id).toBeDefined();
        expect(b.orbit!.a, b.id).toBeGreaterThan(0);
        expect(b.orbit!.e, b.id).toBeGreaterThanOrEqual(0);
        if (!ECLIPTIC_MOONS[b.id] && !ASTEROIDS.includes(b.id)) expect(b.orbit!.e, b.id).toBeLessThan(0.5);
        else expect(b.orbit!.e, b.id).toBeLessThan(1);
        // a moon is outside its planet's surface and inside a few million km (Phoebe and the two ecliptic-frame irregulars reach 5 to 13 million)
        if (b.parentId !== 'SUN') {
          const p = defaultBodies.get(b.parentId!);
          expect(b.orbit!.a * (1 - b.orbit!.e), b.id).toBeGreaterThan(p.radiusKm);
          expect(b.orbit!.a, b.id).toBeLessThan(ECLIPTIC_MOONS[b.id] && b.orbit!.a > 4e6 ? 1.5e7 : 4e6);
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
    for (const [m, planet] of Object.entries(ECLIPTIC_MOONS)) expect(defaultBodies.lineage(m).map((b) => b.id), m).toEqual([m, planet, 'SUN']);
    for (const id of ASTEROIDS) expect(defaultBodies.get(id).parentId, id).toBe('SUN');
    expect(bodies.filter((b) => b.parentId === 'SUN')).toHaveLength(PLANETS.length + DWARFS.length + ASTEROIDS.length);
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
    // the smaller moons: periods P of the SSD mean-elements table (2026-11-17)
    near('AMALTHEA', 0.499918, 0.01); near('THEBE', 0.676105, 0.01); near('HIMALIA', 249.909, 0.01);
    near('HYPERION', 21.276658, 0.03); near('PHOEBE', 550.30391, 0.01); near('JANUS', 0.697353, 0.03); near('EPIMETHEUS', 0.697012, 0.03);
    near('PUCK', 0.761833, 0.03);
    near('NEREID', 360.133039, 0.01); near('DESPINA', 0.3347, 0.03); near('GALATEA', 0.4292, 0.03); near('LARISSA', 0.5549, 0.03); near('PROTEUS', 1.1229, 0.03);
    // Pluto's GM in the registry is the Pluto-Charon system, which is what circumbinary Nix and Hydra feel
    near('NIX', 24.85, 0.03); near('HYDRA', 38.20, 0.03);
    // the named asteroids: PER (Julian years) of each Horizons record, 2026-11-17; Dimorphos 11.92177 h (its pre-impact period, same record)
    const years = (id: string, per: number) => near(id, per * 365.25, 0.002);
    years('VESTA', 3.62997); years('PALLAS', 4.61784); years('HYGIEA', 5.56552); years('PSYCHE', 4.99982); years('BENNU', 1.19548);
    years('RYUGU', 1.29748); years('DIDYMOS', 2.10533); years('APOPHIS', 0.88606); years('EROS', 1.76102); years('ITOKAWA', 1.52138);
    years('ARROKOTH', 296.30944);
    near('DIMORPHOS', 11.92177 / 24, 0.01);
  });

  it('gives rotation where the IAU report has it: Eris, Haumea, Makemake, the moons without a model (Himalia, Hyperion, Nereid, Nix, Hydra) and the asteroids without one render unrotated', () => {
    const none = bodies.filter((b) => b.rotation.kind === 'linear' && b.rotation.rateDegPerDay === 0).map((b) => b.id);
    expect(none.sort()).toEqual(['APOPHIS', 'ARROKOTH', 'BENNU', 'DIMORPHOS', 'ERIS', 'HAUMEA', 'HIMALIA', 'HYDRA', 'HYGIEA', 'HYPERION', 'MAKEMAKE', 'NEREID', 'NIX', 'PSYCHE', 'RYUGU']);
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
    // retrograde rotators: Venus, Uranus and its moons, Triton, Puck
    for (const id of ['VENUS', 'URANUS', 'MIRANDA', 'TRITON', 'PUCK']) expect((defaultBodies.get(id).rotation as { rateDegPerDay: number }).rateDegPerDay, id).toBeLessThan(0);
  });

  it('keeps the ecliptic-frame irregulars (Himalia, Nereid, Phoebe, Janus, Epimetheus) within a(1 -+ e) of their planet and at their SSD inclination to the ecliptic', () => {
    const tilt = { HIMALIA: 28.611, NEREID: 5.1, PHOEBE: 180 - 173.259, JANUS: 27.984, EPIMETHEUS: 27.738, DIMORPHOS: 180 - 170.701 };
    const ecl = eclipticToEquatorial([0, 0, 1]); // the ecliptic pole in the equatorial axes
    for (const m of Object.keys(ECLIPTIC_MOONS)) {
      const b = defaultBodies.get(m);
      let maxLat = 0;
      for (let k = 0; k < 240; k++) {
        const s = bodyStateInParent(b, T + k * 0.0173 * (bodyPeriodSec(b)! * 1000), defaultBodies)!;
        const r = Math.hypot(...s.r);
        expect(r, m).toBeGreaterThanOrEqual(b.orbit!.a * (1 - b.orbit!.e) * 0.9999);
        expect(r, m).toBeLessThanOrEqual(b.orbit!.a * (1 + b.orbit!.e) * 1.0001);
        maxLat = Math.max(maxLat, Math.abs(Math.asin((s.r[0] * ecl[0] + s.r[1] * ecl[1] + s.r[2] * ecl[2]) / r)));
      }
      expect(maxLat / DEG, m).toBeLessThanOrEqual(tilt[m as keyof typeof tilt] + 1e-6);
      expect(maxLat / DEG, m).toBeGreaterThan(tilt[m as keyof typeof tilt] - 1.5);
    }
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
    for (const [m, planet] of Object.entries(ECLIPTIC_MOONS)) expect(r[`body-${m.toLowerCase()}`], m).toMatchObject({ kind: 'moon', bodyId: planet, parentId: `body-${planet.toLowerCase()}` });
    expect(r['body-sun'].kind).toBe('star');
    expect(recs.filter((x) => x.kind === 'moon')).toHaveLength(37); // the Moon, 35 of the planets and Pluto, and Dimorphos
    // a small body of the Sun is an `asteroid` (also Arrokoth, a Kuiper-belt object: the registry has no other small-body kind); its own moon is a `moon`
    for (const id of ASTEROIDS) expect(r[`body-${id.toLowerCase()}`], id).toMatchObject({ kind: 'asteroid', bodyId: 'SUN', parentId: 'body-sun' });
    expect(recs.filter((x) => x.kind === 'asteroid')).toHaveLength(11);
    expect(r['body-dimorphos']).toMatchObject({ kind: 'moon', bodyId: 'DIDYMOS', parentId: 'body-didymos' });
    expect(entityRank(r['body-dimorphos'])).toBe(2061);
    expect(entityRank(r['body-vesta'])).toBe(1050);
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
    expect(r['body-vesta'].aliases).toEqual({ body: 'VESTA', alt: '4 Vesta' });
    expect(r['body-apophis'].aliases.alt).toBe('99942 Apophis');
    expect(r['body-dimorphos'].aliases.alt).toBe('S/2003 (65803) 1');
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
    // every planet is placed against the Sun the scene draws: planet minus Sun in EARTH:inertial is the planet's own heliocentric
    // state (J2000) precessed to the date, since EARTH:inertial is of date (the hop, docs/frames.md)
    for (const p of ['MARS', 'JUPITER', 'NEPTUNE', 'PLUTO']) {
      const rel = bodyStateEci(p, T).r.map((x, k) => x - bodyStateEci('SUN', T).r[k]);
      const helio = precessDir(bodyStateInParent(defaultBodies.get(p), T, defaultBodies)!.r, T, false);
      expect(dist(rel, helio), p).toBeLessThan(1e-3);
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

  it('pins the smaller moons: rotation from pck00011.tpc (read 2026-11-17), radius and GM from the SSD physical parameters page', () => {
    const rot = (id: string) => defaultBodies.get(id).rotation as { poleRaDeg: number; poleDecDeg: number; w0Deg: number; rateDegPerDay: number };
    // BODY<naif>_POLE_RA, _POLE_DEC, _PM (constant terms)
    expect(rot('AMALTHEA')).toMatchObject({ poleRaDeg: 268.05, poleDecDeg: 64.49, w0Deg: 231.67, rateDegPerDay: 722.6314560 }); // 505
    expect(rot('THEBE')).toMatchObject({ poleRaDeg: 268.05, poleDecDeg: 64.49, w0Deg: 8.56, rateDegPerDay: 533.7004100 }); // 514
    expect(rot('PHOEBE')).toMatchObject({ poleRaDeg: 356.90, poleDecDeg: 77.80, w0Deg: 178.58, rateDegPerDay: 931.639 }); // 609
    expect(rot('JANUS')).toMatchObject({ poleRaDeg: 40.58, poleDecDeg: 83.52, w0Deg: 58.83, rateDegPerDay: 518.2359876 }); // 610
    expect(rot('EPIMETHEUS')).toMatchObject({ poleRaDeg: 40.58, poleDecDeg: 83.52, w0Deg: 293.87, rateDegPerDay: 518.4907239 }); // 611
    expect(rot('PUCK')).toMatchObject({ poleRaDeg: 257.31, poleDecDeg: -15.18, w0Deg: 91.24, rateDegPerDay: -472.5450690 }); // 715
    expect(rot('DESPINA')).toMatchObject({ poleRaDeg: 299.36, poleDecDeg: 43.45, w0Deg: 306.51, rateDegPerDay: 1075.7341562 }); // 805
    expect(rot('GALATEA')).toMatchObject({ poleRaDeg: 299.36, poleDecDeg: 43.43, w0Deg: 258.09, rateDegPerDay: 839.6597686 }); // 806
    expect(rot('LARISSA')).toMatchObject({ poleRaDeg: 299.36, poleDecDeg: 43.41, w0Deg: 179.41, rateDegPerDay: 649.0534470 }); // 807
    expect(rot('PROTEUS')).toMatchObject({ poleRaDeg: 299.27, poleDecDeg: 42.91, w0Deg: 93.38, rateDegPerDay: 320.7654228 }); // 808
    const phys = (id: string) => [defaultBodies.get(id).radiusKm, defaultBodies.get(id).gm];
    expect(phys('AMALTHEA')).toEqual([83.5, 0.16456]);
    expect(phys('HIMALIA')).toEqual([85, 0.15155]);
    expect(phys('HYPERION')).toEqual([135, 0.37049]);
    expect(phys('PHOEBE')).toEqual([106.5, 0.55479]);
    expect(phys('JANUS')).toEqual([89.2, 0.12662]);
    expect(phys('PROTEUS')).toEqual([208, 2.58342]);
    expect(phys('NIX')).toEqual([18, 0.0015]);
    expect(phys('NEREID')).toEqual([170, 0]);
    // GM 0 is "not determined": the entity carries no gm attribute at all
    const recs = Object.fromEntries(bodyEntityRecords().map((x) => [x.id, x]));
    for (const id of ['body-nereid', 'body-puck']) expect(recs[id].attrs, id).not.toHaveProperty('gm');
    expect(recs['body-nix'].attrs).toHaveProperty('gm', 0.0015);
    expect(defaultBodies.get('PUCK').radiusKm).toBe(77); // pck00011 BODY715_RADII (the SSD page has no Puck row)
  });
});

describe('the named asteroids (constants read 2026-11-17)', () => {
  const b = (id: string) => defaultBodies.get(id);
  const rot = (id: string) => b(id).rotation as { poleRaDeg: number; poleDecDeg: number; w0Deg: number; rateDegPerDay: number };

  it('pins radius and GM of the Horizons physical parameters (and the DART records for Didymos and Dimorphos)', () => {
    const phys = (id: string) => [b(id).radiusKm, b(id).gm];
    expect(phys('VESTA')).toEqual([261.385, 17.28828]);
    expect(phys('PALLAS')).toEqual([256.5, 13.63]);
    expect(phys('HYGIEA')).toEqual([203.56, 7]);
    expect(phys('PSYCHE')).toEqual([111, 1.601]);
    expect(phys('BENNU')).toEqual([0.241, 0]); // Horizons: GM n.a.
    expect(phys('RYUGU')).toEqual([0.448, 3e-8]);
    expect(phys('APOPHIS')).toEqual([0.17, 0]); // Horizons: GM n.a.
    expect(phys('EROS')).toEqual([8.42, 4.463e-4]);
    expect(phys('ITOKAWA')).toEqual([0.165, 2.1e-9]);
    expect(phys('ARROKOTH')).toEqual([9.948, 0]); // half of the 19.896 km volume equivalent diameter (Porter et al. 2024 draft on the PDS); Horizons has neither radius nor GM
    expect(phys('DIDYMOS')).toEqual([0.3551, 3.51278e-8]); // volume 0.1876 km^3 -> 0.3551 km
    expect(phys('DIMORPHOS')).toEqual([0.0728, 3.0268e-10]); // volume 0.001616 km^3 -> 0.0728 km
    expect(Math.cbrt((3 * 0.1876) / (4 * Math.PI))).toBeCloseTo(0.3551, 4);
    expect(Math.cbrt((3 * 0.001616) / (4 * Math.PI))).toBeCloseTo(0.0728, 4);
    for (const id of [...ASTEROIDS, 'DIMORPHOS']) expect(b(id).flattening, id).toBe(0);
  });

  it('pins the rotation of the four with an IAU model (NAIF pck00011.tpc, BODY2000004, 2000002, 2000433, 2025143) and Didymos (Horizons 920065803); the rest are NO_ROTATION', () => {
    expect(rot('VESTA')).toMatchObject({ poleRaDeg: 309.031, poleDecDeg: 42.235, w0Deg: 285.39, rateDegPerDay: 1617.3329428 });
    expect(rot('PALLAS')).toMatchObject({ poleRaDeg: 33, poleDecDeg: -3, w0Deg: 38, rateDegPerDay: 1105.8036 });
    expect(rot('EROS')).toMatchObject({ poleRaDeg: 11.35, poleDecDeg: 17.22, w0Deg: 326.07, rateDegPerDay: 1639.38864745 });
    expect(rot('ITOKAWA')).toMatchObject({ poleRaDeg: 90.53, poleDecDeg: -66.3, w0Deg: 0, rateDegPerDay: 712.143 });
    expect(rot('DIDYMOS')).toMatchObject({ poleRaDeg: 69.32686, poleDecDeg: -72.72455, w0Deg: 0 });
    expect(24 / (rot('DIDYMOS').rateDegPerDay / 360)).toBeCloseTo(2.26, 3); // the 2.2600 h period of the same record
    for (const id of ['HYGIEA', 'PSYCHE', 'BENNU', 'RYUGU', 'APOPHIS', 'ARROKOTH', 'DIMORPHOS']) expect(b(id).rotation, id).toBe(NO_ROTATION);
  });

  it('fallback orbits: Horizons osculating elements (heliocentric ecliptic J2000) at the epoch of each record', () => {
    const o = (id: string) => b(id).orbit!;
    const AU = 149_597_870.7;
    expect(o('VESTA').a / AU).toBeCloseTo(2.361908654, 8);
    expect(o('VESTA').e).toBe(0.08857261385730482);
    expect(o('VESTA').epochMs).toBe(Date.UTC(2020, 0, 1)); // JD 2458849.5
    expect(o('BENNU').epochMs).toBe(Date.UTC(2011, 0, 1)); // JD 2455562.5
    expect(o('DIDYMOS').epochMs).toBe(Date.UTC(2024, 4, 24, 12)); // JD 2460455.0
    expect(o('ARROKOTH').epochMs).toBe(Date.UTC(2017, 11, 14)); // JD 2458101.5
    expect(o('DIDYMOS').i / DEG).toBeCloseTo(3.414218407, 8);
    for (const id of ASTEROIDS) expect(b(id).orbitPlane, id).toBe('ecliptic');
    expect(b('DIMORPHOS').orbitPlane).toBe('ecliptic');
    expect(o('DIMORPHOS').a).toBe(1.1786); // derived from the Horizons state 2026-11-17 and the Didymos GM
    expect(o('DIMORPHOS').epochMs).toBe(Date.UTC(2026, 10, 17));
  });

  it('every asteroid is approximate, flagged `asteroid` (the source block in bodies.ts is checked by apps/web/test/engine/connectors/horizons-bodies.test.ts)', () => {
    for (const id of ASTEROIDS) { expect(b(id).approx, id).toBe(true); expect(b(id).asteroid, id).toBe(true); expect(b(id).dwarf, id).toBeUndefined(); }
    expect(b('DIMORPHOS').asteroid).toBeUndefined();
  });

  it('Dimorphos orbits the Didymos system within a few Didymos radii, retrograde to the ecliptic, period near 11.9 h', () => {
    const s = bodyStateInParent(b('DIMORPHOS'), Date.UTC(2026, 10, 17), defaultBodies)!;
    expect(Math.hypot(...s.r)).toBeGreaterThan(1.1);
    expect(Math.hypot(...s.r)).toBeLessThan(1.25);
    expect(bodyPeriodSec(b('DIMORPHOS'))! / 3600).toBeCloseTo(11.9, 1);
    expect(b('DIMORPHOS').orbit!.i / DEG).toBeGreaterThan(90);
  });
});
