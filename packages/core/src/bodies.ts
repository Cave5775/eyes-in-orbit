import type { FrameId, KeplerElements } from './types';
import { DEG, J2000_MS, type Vec3 } from './math';
import { moonStateEci, sunPositionEci } from './ephemeris';
import type { Sample } from './types';

export type BodyRotation =
  | { kind: 'gmst' }
  | {
      kind: 'linear';
      /** IAU pole right ascension / declination, degrees */
      poleRaDeg: number;
      poleDecDeg: number;
      /** prime meridian angle at J2000, degrees */
      w0Deg: number;
      /** rotation rate, degrees per day */
      rateDegPerDay: number;
    };

export interface Body {
  id: string;
  name: string;
  parentId?: string;
  /** equatorial radius, km (a moon or dwarf planet: its mean radius) */
  radiusKm: number;
  /** (a-b)/a */
  flattening: number;
  /** km^3/s^2 */
  gm: number;
  /**
   * Axes and spin. A body whose IAU pole and prime meridian are not in the registry has none to give: it keeps `gmst`
   * (Earth only) or the neutral `NO_ROTATION` and renders unrotated.
   */
  rotation: BodyRotation;
  /** orbit around parent (approximate mean elements), used to relate inertial frames */
  orbit?: KeplerElements;
  /**
   * What `orbit` is referred to. `ecliptic`: the ecliptic of J2000, rotated into the equatorial axes all inertial frames
   * share. `equator`: the equator of the PARENT (its IAU pole, `rotation.poleRaDeg/poleDecDeg`; x towards the node of that
   * equator on the ICRF equator), used for the moons, whose orbits lie close to their planet's equator.
   */
  orbitPlane?: 'ecliptic' | 'equator';
  /** position and velocity relative to the parent (parent's inertial axes), km and km/s; used instead of `orbit` when set */
  ephemeris?: (tMs: number) => { r: Vec3; v: Vec3 };
  /** true when ephemeris/rotation values are only low precision */
  approx?: boolean;
  /** an IAU dwarf planet (entity kind `dwarf_planet`) */
  dwarf?: boolean;
}

/** Rotation of a body without IAU pole/prime-meridian values: it stays aligned with the inertial axes. */
export const NO_ROTATION: BodyRotation = { kind: 'linear', poleRaDeg: 0, poleDecDeg: 90, w0Deg: 0, rateDegPerDay: 0 };

export const SUN: Body = {
  id: 'SUN', name: 'Sun', radiusKm: 695_700, flattening: 0, gm: 1.32712440018e11,
  rotation: { kind: 'linear', poleRaDeg: 286.13, poleDecDeg: 63.87, w0Deg: 84.176, rateDegPerDay: 14.1844 },
};

/**
 * The Earth relative to the Sun in the shared inertial axes: minus the Sun's geocentric position (`sunPositionEci`, the series
 * the scene draws the Sun and the light with), so every other planet hopped into EARTH:inertial is placed against the SAME Sun
 * the scene draws, not against the rougher mean-element orbit in `EARTH.orbit` (kept as the documented fallback elements).
 */
function earthInSunFrame(tMs: number): { r: Vec3; v: Vec3 } {
  const half = 30_000;
  const p = sunPositionEci(tMs), a = sunPositionEci(tMs - half), b = sunPositionEci(tMs + half);
  const span = (2 * half) / 1000;
  return { r: [-p[0], -p[1], -p[2]], v: [-(b[0] - a[0]) / span, -(b[1] - a[1]) / span, -(b[2] - a[2]) / span] };
}

export const EARTH: Body = {
  id: 'EARTH', name: 'Earth', parentId: 'SUN',
  radiusKm: 6378.137, flattening: 1 / 298.257223563, gm: 398_600.4418,
  rotation: { kind: 'gmst' },
  orbit: { a: 149_598_023, e: 0.0167, i: 0, raan: 0, argp: 102.9 * DEG, m0: 357.5 * DEG, epochMs: J2000_MS },
  orbitPlane: 'ecliptic',
  ephemeris: earthInSunFrame,
  approx: true,
};

export const MOON: Body = {
  id: 'MOON', name: 'Moon', parentId: 'EARTH',
  radiusKm: 1737.4, flattening: 0.0012, gm: 4902.8,
  rotation: { kind: 'linear', poleRaDeg: 269.9949, poleDecDeg: 66.5392, w0Deg: 38.3213, rateDegPerDay: 13.17635815 },
  orbit: { a: 384_400, e: 0.0549, i: 5.145 * DEG, raan: 125.08 * DEG, argp: 318.15 * DEG, m0: 135.27 * DEG, epochMs: J2000_MS },
  ephemeris: moonStateEci,
  approx: true,
};

export const MARS: Body = {
  id: 'MARS', name: 'Mars', parentId: 'SUN',
  radiusKm: 3396.19, flattening: 1 / 169.8, gm: 42_828.37,
  rotation: { kind: 'linear', poleRaDeg: 317.68143, poleDecDeg: 52.8865, w0Deg: 176.63, rateDegPerDay: 350.89198226 },
  orbit: { a: 227_939_200, e: 0.0934, i: 1.85 * DEG, raan: 49.58 * DEG, argp: 286.5 * DEG, m0: 19.4 * DEG, epochMs: J2000_MS },
  orbitPlane: 'ecliptic',
  approx: true,
};

// ---------------------------------------------------------------------------------------------------------------------
// The rest of the solar system. Sources, all low precision by design (they are the OFFLINE FALLBACK; the `horizons-bodies`
// server connector replaces the positions with JPL Horizons ephemerides while it is online):
//  - radius, flattening, GM, pole and prime meridian: IAU WGCCRE 2015 report (Archinal et al. 2018, Celest Mech Dyn Astr
//    130:22) and the NASA Planetary Fact Sheets / JPL "Planetary Satellite Physical Parameters" and "Solar System Dynamics
//    constants" pages, as remembered (rounded to the digits given here). The periodic libration terms of the IAU series
//    (for example Neptune's sin N terms, the Phobos libration) are left out: sub-degree effects.
//  - planet orbits: Standish, "Keplerian Elements for Approximate Positions of the Major Planets", table 1 (1800-2050 AD,
//    elements at J2000, mean anomaly = L - long. of perihelion).
//  - Ceres, Eris, Haumea, Makemake: osculating elements at J2000 (ecliptic of J2000) from JPL Horizons itself, fetched
//    2026-10-29 (EPHEM_TYPE=ELEMENTS, CENTER 500@10); Ceres radius and GM are Horizons' (RAD 469.7, GM 62.6284). Eris, Haumea
//    and Makemake have no GM or radius in Horizons; the values here are literature estimates (Eris GM 1108, Haumea 267,
//    Makemake ~207 km^3/s^2; radii 1163, ~816 (mean of a triaxial body), 715 km) and flagged `approx`. Their rotation is
//    not given by the IAU report, so they have none (they render unrotated).
//  - moons: semi-major axis, eccentricity, inclination to the planet's equator, mean radius and GM from the JPL satellite
//    tables. The phase (mean anomaly) and the node/periapsis angles are NOT known to me reliably, so the fallback puts every
//    moon at M0 = 0, node 0, argp 0 at J2000: the size, shape, period and tilt of each orbit are right, the position
//    ALONG it is arbitrary until the Horizons stream arrives. Do not read a phase off the offline fallback.
// ---------------------------------------------------------------------------------------------------------------------

const AU_KM = 149_597_870.7;

/** Planet from Standish's table: a (AU), e, I, L, long. of perihelion, long. of node (all degrees at J2000). */
function planetOrbit(aAu: number, e: number, iDeg: number, lDeg: number, varpiDeg: number, nodeDeg: number): KeplerElements {
  return { a: aAu * AU_KM, e, i: iDeg * DEG, raan: nodeDeg * DEG, argp: (varpiDeg - nodeDeg) * DEG, m0: (lDeg - varpiDeg) * DEG, epochMs: J2000_MS };
}

/** Osculating heliocentric ecliptic elements (a in km, angles in degrees) at J2000. */
function osculating(aKm: number, e: number, iDeg: number, nodeDeg: number, argpDeg: number, maDeg: number): KeplerElements {
  return { a: aKm, e, i: iDeg * DEG, raan: nodeDeg * DEG, argp: argpDeg * DEG, m0: maDeg * DEG, epochMs: J2000_MS };
}

const linear = (poleRaDeg: number, poleDecDeg: number, w0Deg: number, rateDegPerDay: number): BodyRotation =>
  ({ kind: 'linear', poleRaDeg, poleDecDeg, w0Deg, rateDegPerDay });

function planet(id: string, name: string, radiusKm: number, flattening: number, gm: number, rotation: BodyRotation, orbit: KeplerElements, extra: Partial<Body> = {}): Body {
  return { id, name, parentId: 'SUN', radiusKm, flattening, gm, rotation, orbit, orbitPlane: 'ecliptic', approx: true, ...extra };
}

export const MERCURY = planet('MERCURY', 'Mercury', 2439.7, 0, 22_031.78, linear(281.0103, 61.4155, 329.5988, 6.1385108),
  planetOrbit(0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593));
export const VENUS = planet('VENUS', 'Venus', 6051.8, 0, 324_858.59, linear(272.76, 67.16, 160.20, -1.4813688),
  planetOrbit(0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255));
export const JUPITER = planet('JUPITER', 'Jupiter', 71_492, 0.06487, 126_686_534, linear(268.056595, 64.495303, 284.95, 870.5360000),
  planetOrbit(5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909));
export const SATURN = planet('SATURN', 'Saturn', 60_268, 0.09796, 37_931_187, linear(40.589, 83.537, 38.90, 810.7939024),
  planetOrbit(9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448));
export const URANUS = planet('URANUS', 'Uranus', 25_559, 0.02293, 5_793_939, linear(257.311, -15.175, 203.81, -501.1600928),
  planetOrbit(19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503));
export const NEPTUNE = planet('NEPTUNE', 'Neptune', 24_764, 0.01708, 6_836_529, linear(299.36, 43.46, 249.978, 541.1397757),
  planetOrbit(30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574));

const dwarf = (id: string, name: string, radiusKm: number, flattening: number, gm: number, rotation: BodyRotation, orbit: KeplerElements): Body =>
  planet(id, name, radiusKm, flattening, gm, rotation, orbit, { dwarf: true });

export const CERES = dwarf('CERES', 'Ceres', 469.7, 0.074, 62.6284, linear(291.418, 66.764, 170.650, 952.1532),
  osculating(4.138619138911831e8, 0.07837562647, 10.58336045806, 80.49435747295, 73.92286274285, 6.176654513180));
// GM is the Pluto-Charon SYSTEM (975.5; Pluto alone 869.6): Charon's period about Pluto uses the parent's GM only and needs the sum
export const PLUTO = dwarf('PLUTO', 'Pluto', 1188.3, 0, 975.5, linear(132.993, -6.163, 302.695, 56.3625225),
  planetOrbit(39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684));
export const ERIS = dwarf('ERIS', 'Eris', 1163, 0, 1108, NO_ROTATION,
  osculating(1.019357926016618e10, 0.4325050983, 43.74050564207, 36.12852074097, 150.8448096450, 194.2903409988));
export const HAUMEA = dwarf('HAUMEA', 'Haumea', 816, 0, 267.4, NO_ROTATION,
  osculating(6.419133579383321e9, 0.1999209496, 28.20614176692, 121.9332385932, 240.5907776702, 189.5952699212));
export const MAKEMAKE = dwarf('MAKEMAKE', 'Makemake', 715, 0, 207, NO_ROTATION,
  osculating(6.787563233624084e9, 0.1645232903, 29.00018553920, 79.27490607393, 296.2809991935, 139.7201624508));

/**
 * A moon: `a` km, `e`, `iDeg` inclination to the PARENT's equator, mean radius km, GM km^3/s^2. Node, argument of periapsis
 * and mean anomaly are 0 (unknown, see above). Elements are referred to the parent's equator (`orbitPlane: 'equator'`).
 */
function moon(id: string, name: string, parentId: string, a: number, e: number, iDeg: number, radiusKm: number, gm: number, rotation: BodyRotation): Body {
  return {
    id, name, parentId, radiusKm, flattening: 0, gm, rotation,
    orbit: { a, e, i: iDeg * DEG, raan: 0, argp: 0, m0: 0, epochMs: J2000_MS }, orbitPlane: 'equator', approx: true,
  };
}

export const PHOBOS = moon('PHOBOS', 'Phobos', 'MARS', 9376, 0.0151, 1.08, 11.1, 7.087e-4, linear(317.68, 52.90, 35.06, 1128.8445850));
export const DEIMOS = moon('DEIMOS', 'Deimos', 'MARS', 23_463, 0.0005, 1.79, 6.2, 9.615e-5, linear(316.65, 53.52, 79.41, 285.1618970));

export const IO = moon('IO', 'Io', 'JUPITER', 421_800, 0.0041, 0.04, 1821.6, 5959.916, linear(268.05, 64.50, 200.39, 203.4889538));
export const EUROPA = moon('EUROPA', 'Europa', 'JUPITER', 671_100, 0.0094, 0.47, 1560.8, 3202.739, linear(268.08, 64.51, 36.022, 101.3747235));
export const GANYMEDE = moon('GANYMEDE', 'Ganymede', 'JUPITER', 1_070_400, 0.0013, 0.20, 2631.2, 9887.834, linear(268.20, 64.57, 44.064, 50.3176081));
export const CALLISTO = moon('CALLISTO', 'Callisto', 'JUPITER', 1_882_700, 0.0074, 0.19, 2410.3, 7179.289, linear(268.72, 64.83, 259.51, 21.5710715));

export const MIMAS = moon('MIMAS', 'Mimas', 'SATURN', 185_540, 0.0196, 1.57, 198.2, 2.5026, linear(40.66, 83.52, 333.46, 381.9945550));
export const ENCELADUS = moon('ENCELADUS', 'Enceladus', 'SATURN', 238_040, 0.0047, 0.01, 252.1, 7.2027, linear(40.66, 83.52, 6.32, 262.7318996));
export const TETHYS = moon('TETHYS', 'Tethys', 'SATURN', 294_670, 0.0001, 1.09, 531.1, 41.21, linear(40.66, 83.52, 8.95, 190.6979085));
export const DIONE = moon('DIONE', 'Dione', 'SATURN', 377_420, 0.0022, 0.02, 561.4, 73.12, linear(40.66, 83.52, 357.00, 131.5349316));
export const RHEA = moon('RHEA', 'Rhea', 'SATURN', 527_070, 0.0010, 0.35, 763.8, 153.94, linear(40.38, 83.55, 235.16, 79.6900478));
export const TITAN = moon('TITAN', 'Titan', 'SATURN', 1_221_870, 0.0288, 0.33, 2574.7, 8978.14, linear(39.4827, 83.4279, 186.5855, 22.5769768));
export const IAPETUS = moon('IAPETUS', 'Iapetus', 'SATURN', 3_560_840, 0.0286, 15.47, 734.5, 120.51, linear(318.16, 75.03, 355.20, 4.5379572));

export const MIRANDA = moon('MIRANDA', 'Miranda', 'URANUS', 129_900, 0.0013, 4.34, 235.8, 4.4, linear(257.43, -15.08, 30.70, -254.6906892));
export const ARIEL = moon('ARIEL', 'Ariel', 'URANUS', 190_900, 0.0012, 0.04, 578.9, 90.3, linear(257.43, -15.10, 156.22, -142.8356681));
export const UMBRIEL = moon('UMBRIEL', 'Umbriel', 'URANUS', 266_000, 0.0039, 0.13, 584.7, 78.2, linear(257.43, -15.10, 108.05, -86.8688923));
export const TITANIA = moon('TITANIA', 'Titania', 'URANUS', 436_300, 0.0011, 0.08, 788.9, 228.2, linear(257.43, -15.10, 77.74, -41.3514316));
export const OBERON = moon('OBERON', 'Oberon', 'URANUS', 583_500, 0.0014, 0.07, 761.4, 192.4, linear(257.43, -15.10, 6.77, -26.7394932));

/** Triton is retrograde: inclination 156.9 deg to Neptune's equator. */
export const TRITON = moon('TRITON', 'Triton', 'NEPTUNE', 354_759, 0.000016, 156.885, 1353.4, 1427.6, linear(299.36, 41.17, 296.53, -61.2572637));
export const CHARON = moon('CHARON', 'Charon', 'PLUTO', 19_591, 0.0002, 0, 606, 105.88, linear(132.993, -6.163, 122.695, 56.3625225));

/** Every body of the default registry: the original four first (their entity ranks and ids are fixed), then the rest. */
export const DEFAULT_BODY_LIST: Body[] = [
  SUN, EARTH, MOON, MARS,
  MERCURY, VENUS, JUPITER, SATURN, URANUS, NEPTUNE,
  CERES, PLUTO, ERIS, HAUMEA, MAKEMAKE,
  PHOBOS, DEIMOS,
  IO, EUROPA, GANYMEDE, CALLISTO,
  MIMAS, ENCELADUS, TETHYS, DIONE, RHEA, TITAN, IAPETUS,
  MIRANDA, ARIEL, UMBRIEL, TITANIA, OBERON,
  TRITON, CHARON,
];

/** The original four-body registry (Sun, Earth, Moon, Mars): for tests that predate the rest of the solar system. */
export const ORIGINAL_BODIES: Body[] = DEFAULT_BODY_LIST.slice(0, 4);

/** A stream of states of a body relative to its parent, as served by the `horizons-bodies` connector. */
export interface BodyEphemerisData {
  /** the parent's inertial frame the samples are in, `<PARENT>:inertial` */
  frame: FrameId;
  /** [tMs, x, y, z, vx, vy, vz] in km and km/s, ascending */
  samples: Sample[];
}

export class BodyRegistry {
  private bodies = new Map<string, Body>();
  /** the `ephemeris` each body was registered with (restored when a stream is removed) */
  private baseEphemeris = new Map<string, Body['ephemeris']>();
  private streams = new Map<string, BodyEphemerisData>();

  constructor(initial: Body[] = DEFAULT_BODY_LIST) {
    for (const b of initial) this.register(b);
  }

  register(body: Body): void {
    this.bodies.set(body.id, body);
    this.baseEphemeris.set(body.id, body.ephemeris);
    this.streams.delete(body.id);
  }

  get(id: string): Body {
    const b = this.bodies.get(id);
    if (!b) throw new Error(`Unknown body: ${id}`);
    return b;
  }

  has(id: string): boolean {
    return this.bodies.has(id);
  }

  all(): Body[] {
    return [...this.bodies.values()];
  }

  /** Chain from body up to the root, body first. */
  lineage(id: string): Body[] {
    const out: Body[] = [];
    let cur: Body | undefined = this.get(id);
    while (cur) {
      out.push(cur);
      cur = cur.parentId ? this.get(cur.parentId) : undefined;
    }
    return out;
  }

  /**
   * Replace the `ephemeris` of a registered body (a COPY of the record: the exported constants are never touched) and
   * remember the sample stream it was built from; `undefined` restores the registered one. Use `setBodyStream` (frames.ts).
   */
  setEphemeris(id: string, ephemeris: Body['ephemeris'] | undefined, data?: BodyEphemerisData): void {
    const b = this.get(id);
    this.bodies.set(id, { ...b, ephemeris: ephemeris ?? this.baseEphemeris.get(id) });
    if (ephemeris && data) this.streams.set(id, data);
    else this.streams.delete(id);
  }

  /** The registered `ephemeris` of the body (before any stream replaced it). */
  baseEphemerisOf(id: string): Body['ephemeris'] | undefined {
    return this.baseEphemeris.get(id);
  }

  /** The sample stream installed with `setBodyStream`, if any. */
  streamOf(id: string): BodyEphemerisData | undefined {
    return this.streams.get(id);
  }
}

export const defaultBodies = new BodyRegistry();

/**
 * Orbital period of `body` around its parent, seconds: 2 pi sqrt(a^3 / gm_parent) from `Body.orbit`. Undefined for the
 * root (the Sun) and for a body without Kepler elements. The elements are approximate (the Moon comes out at about 27.4 d).
 */
export function bodyPeriodSec(body: Body, registry: BodyRegistry = defaultBodies): number | undefined {
  if (!body.parentId || !body.orbit) return undefined;
  const gm = registry.get(body.parentId).gm;
  return 2 * Math.PI * Math.sqrt(body.orbit.a ** 3 / gm);
}
