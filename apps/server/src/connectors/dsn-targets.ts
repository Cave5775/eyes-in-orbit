import type { FrameId } from '@eio/core';
import type { NewEntity } from '../hub';

/**
 * How one target's Horizons ephemeris is requested and what the resulting entity is expressed in.
 * Every field is optional in a `DsnTarget`; the defaults reproduce the original geocentric 30 minute query.
 */
export interface HorizonsSpec {
  /** Horizons CENTER code (without quotes): `500@399` Earth centre, `500@301` Moon centre */
  center: string;
  /** frame the returned vectors are in: the `sampled` provider's frame; equatorial axes of the centre body */
  frame: FrameId;
  /** primary body of the entity (`EntityRecord.bodyId`) */
  bodyId: string;
  /** STEP_SIZE in minutes; the web client Hermite-interpolates between rows using the velocities */
  stepMin: number;
  /** window start: this many days before the fetch hour */
  pastDays: number;
  /** window end: this many days after the fetch hour */
  futureDays: number;
}

export const DEFAULT_HORIZONS: HorizonsSpec = {
  center: '500@399', frame: 'EARTH:inertial', bodyId: 'EARTH', stepMin: 30, pastDays: 3, futureDays: 7,
};

export interface DsnTarget extends Partial<HorizonsSpec> {
  name: string;
  /** Horizons target id */
  horizons: string;
  /** extra entity attrs (static, survive the DSN connector's attr refresh) */
  attrs?: NonNullable<NewEntity['attrs']>;
}

/** The effective Horizons request/frame settings of a target: its overrides on top of `DEFAULT_HORIZONS`. */
export function horizonsSpecOf(target: DsnTarget): HorizonsSpec {
  return {
    center: target.center ?? DEFAULT_HORIZONS.center,
    frame: target.frame ?? DEFAULT_HORIZONS.frame,
    bodyId: target.bodyId ?? DEFAULT_HORIZONS.bodyId,
    stepMin: target.stepMin ?? DEFAULT_HORIZONS.stepMin,
    pastDays: target.pastDays ?? DEFAULT_HORIZONS.pastDays,
    futureDays: target.futureDays ?? DEFAULT_HORIZONS.futureDays,
  };
}

/**
 * A spacecraft in Mars orbit: Horizons centred on the Mars body centre (`500@499`), vectors in ICRF axes ~ `MARS:inertial`,
 * entity on MARS (so it sits under Mars in the tree and its orbit line/frame logic is Mars-relative). Window -1 d .. +3 d like LRO:
 * 5 min = 1153 rows, 10 min = 577 rows (cubic Hermite with velocities: at 10 min the error near a 150-300 km periapsis stays a few km).
 */
function marsOrbiter(t: Pick<DsnTarget, 'name' | 'horizons'>, stepMin: number): DsnTarget {
  return {
    ...t, center: '500@499', frame: 'MARS:inertial', bodyId: 'MARS', stepMin, pastDays: 1, futureDays: 3,
    attrs: { trackCentre: 'Mars', trackNote: `Track is Mars-centred (Horizons 500@499, ${stepMin} min steps, -1 d to +3 d), not Earth-centred` },
  };
}

/**
 * DSN spacecraft code -> display name and JPL Horizons id (unknown codes are skipped).
 * Targets orbiting a body other than Earth that is close enough to matter are fetched centred on that body
 * (LRO: Moon centre, 5 min steps; a 2 h lunar orbit sampled every 30 min and referred to the Earth is useless; the Mars
 * orbiters MRO, Odyssey, MAVEN, TGO and Mars Express: Mars centre, 5 or 10 min steps, `marsOrbiter`). Landers/rovers (MSL, M20)
 * stay on the default Earth-centred query.
 */
export const DSN_TARGETS: Record<string, DsnTarget> = {
  VGR1: { name: 'Voyager 1', horizons: '-31' },
  VGR2: { name: 'Voyager 2', horizons: '-32' },
  JWST: { name: 'James Webb Space Telescope', horizons: '-170' },
  M20: { name: 'Mars 2020 Perseverance', horizons: '-168' },
  MSL: { name: 'Mars Science Laboratory Curiosity', horizons: '-76' },
  // Mars orbiters: Mars-centred like LRO (a 2 h orbit cannot be resolved in 30 min Earth-centred steps)
  MRO: marsOrbiter({ name: 'Mars Reconnaissance Orbiter', horizons: '-74' }, 5), // 112 min
  ODY: marsOrbiter({ name: 'Mars Odyssey', horizons: '-53' }, 5), // 118 min
  MVN: marsOrbiter({ name: 'MAVEN', horizons: '-202' }, 10), // 4.5 h, 150 x 6200 km
  NHPC: { name: 'New Horizons', horizons: '-98' },
  JNO: { name: 'Juno', horizons: '-61' },
  // Moon-centred (Horizons 500@301), ICRF axes ~ MOON:inertial; window -1 d .. +3 d at 5 min = 1153 rows (~170 kB)
  LRO: {
    name: 'Lunar Reconnaissance Orbiter', horizons: '-85',
    center: '500@301', frame: 'MOON:inertial', bodyId: 'MOON', stepMin: 5, pastDays: 1, futureDays: 3,
    attrs: { trackCentre: 'Moon', trackNote: 'Track is Moon-centred (Horizons 500@301, 5 min steps, -1 d to +3 d), not Earth-centred' },
  },
  PSP: { name: 'Parker Solar Probe', horizons: '-96' },
  TGO: marsOrbiter({ name: 'ExoMars Trace Gas Orbiter', horizons: '-143' }, 5), // ~2 h
  MEX: marsOrbiter({ name: 'Mars Express', horizons: '-41' }, 10), // 6.7 h, 300 x 10100 km
  LUCY: { name: 'Lucy', horizons: '-49' },
  PSYC: { name: 'Psyche', horizons: '-255' },
  EURC: { name: 'Europa Clipper', horizons: '-159' },
  SOLO: { name: 'Solar Orbiter', horizons: '-144' },
  BEPI: { name: 'BepiColombo', horizons: '-121' },
  STA: { name: 'STEREO-A', horizons: '-234' },
  SOHO: { name: 'SOHO', horizons: '-21' },
  TESS: { name: 'TESS', horizons: '-95' },
  CHDR: { name: 'Chandra X-ray Observatory', horizons: '-151' },
};

export const DSN_STATIONS = [
  { id: 'dsn-goldstone', name: 'Goldstone Deep Space Communications Complex', complex: 'Goldstone', latDeg: 35.4267, lonDeg: -116.89, altKm: 1.0 },
  { id: 'dsn-madrid', name: 'Madrid Deep Space Communications Complex', complex: 'Madrid', latDeg: 40.4314, lonDeg: -4.2481, altKm: 0.83 },
  { id: 'dsn-canberra', name: 'Canberra Deep Space Communication Complex', complex: 'Canberra', latDeg: -35.4014, lonDeg: 148.9817, altKm: 0.69 },
];

export const probeId = (code: string): string => `dsn-${code}`;

/** Probe entity without a provider; the Horizons connector attaches positions. */
export function probeEntity(code: string): NewEntity {
  const t = DSN_TARGETS[code];
  return {
    id: probeId(code),
    name: t.name,
    kind: 'probe',
    bodyId: horizonsSpecOf(t).bodyId,
    aliases: { dsn: code, horizons: t.horizons },
    group: 'dsn',
    links: { newsQuery: t.name },
    render: { colorKey: 'probe', glyph: 'diamond', label: true },
    ...(t.attrs ? { attrs: t.attrs } : {}),
  };
}
