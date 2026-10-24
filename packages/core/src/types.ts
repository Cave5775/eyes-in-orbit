import type { Vec3 } from './math';

/**
 * Frame ids are `<bodyId>:<kind>`:
 *  - `EARTH:inertial`  non-rotating, centred on the body (TEME is treated as inertial for Earth)
 *  - `EARTH:fixed`     body-fixed (ECEF-like), rotates with the body
 */
export type FrameKind = 'inertial' | 'fixed';
export type FrameId = `${string}:${FrameKind}`;

/** Position in km, velocity in km/s. Validity in time is owned by the provider. */
export interface StateVector {
  frame: FrameId;
  r: Vec3;
  v?: Vec3;
  /** Orientation of body axes in `frame` (x,y,z,w), when known. */
  q?: [number, number, number, number];
  /** 0..1 rough trust indicator (e.g. stale elements or extrapolated fix). */
  confidence?: number;
}

export interface ProviderContext {
  /** Resolve another entity's state (used by relative providers). */
  stateOf?(entityId: string, t: number): StateVector | null;
}

export interface StateProvider {
  readonly type: string;
  /** [fromMs, toMs] inclusive; undefined = unbounded. */
  readonly validRange?: [number, number];
  stateAt(t: number, ctx?: ProviderContext): StateVector | null;
  toSpec(): ProviderSpec;
}

/** CelesTrak / CCSDS-OMM JSON element set (subset used by SGP4). */
export interface Omm {
  OBJECT_NAME: string;
  OBJECT_ID?: string;
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  EPHEMERIS_TYPE?: number;
  CLASSIFICATION_TYPE?: string;
  NORAD_CAT_ID: number;
  ELEMENT_SET_NO?: number;
  REV_AT_EPOCH?: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
}

export interface KeplerElements {
  /** semi-major axis, km */
  a: number;
  e: number;
  /** radians */
  i: number;
  raan: number;
  argp: number;
  /** mean anomaly at epoch, radians */
  m0: number;
  epochMs: number;
}

/** [tMs, x, y, z] or [tMs, x, y, z, vx, vy, vz] */
export type Sample = number[];

export type ProviderSpec =
  | { type: 'sgp4'; omm: Omm }
  | { type: 'sampled'; frame: FrameId; samples: Sample[]; holdEnds?: boolean; confidence?: number }
  | { type: 'keplerian'; bodyId: string; elements: KeplerElements }
  | { type: 'geodetic'; bodyId: string; latDeg: number; lonDeg: number; altKm: number }
  | {
      type: 'relative';
      parentId: string;
      /** `enu`: east/north/up km relative to the parent's local basis; `offset`: parent-frame xyz km. */
      mode: 'enu' | 'offset';
      offsetKm?: Vec3;
      /** time-varying offsets: [tMs, x, y, z] */
      samples?: Sample[];
    }
  | { type: 'composite'; segments: CompositeSegment[] }
  /** A celestial body of the registry (`bodies.ts`): its position comes from the ephemeris, state in `EARTH:inertial`. */
  | { type: 'body'; bodyId: string };

export interface CompositeSegment {
  fromMs: number;
  toMs: number;
  /** Optional label e.g. 'ascent' | 'on-orbit' | 'landing burn'. */
  phase?: string;
  spec: ProviderSpec;
}

export type MissionPhase =
  | 'SCHEDULED'
  | 'COUNTDOWN'
  | 'ACTIVE_ASCENT'
  | 'ORBIT_INSERTION'
  | 'ON_ORBIT'
  | 'DESCENT'
  | 'LANDED'
  | 'DECAYED'
  | 'FAILED'
  | 'SCRUBBED';

export interface StreamLink {
  title: string;
  url: string;
  /** decides how the client embeds it */
  kind: 'youtube' | 'nasa-tv' | 'x' | 'web';
  live?: boolean;
}

export interface EntityEvent {
  tMs: number;
  /** e.g. MECO, SECO, STAGE_SEP, LANDING */
  name: string;
  detail?: string;
}

export interface RenderHint {
  glyph?: 'dot' | 'diamond' | 'ring' | 'triangle' | 'square';
  /** semantic colour key resolved by the client theme */
  colorKey?: 'station' | 'satellite' | 'starlink' | 'probe' | 'vehicle' | 'ground' | 'debris' | 'rover' | 'aircraft' | 'body';
  orbitLine?: boolean;
  trailSeconds?: number;
  footprint?: boolean;
  label?: boolean;
  /**
   * 3D model key from the web client's model registry (`apps/web/src/scene/models/registry.ts`): `iss`, `satellite`,
   * `rocket-stage`. Drawn at true size instead of the point sprite when the camera is near; unknown keys are ignored.
   */
  model?: string;
}

/** Open kind: well-known values below, anything else is allowed. */
export type EntityKind =
  | 'satellite'
  | 'station'
  | 'probe'
  | 'launch_vehicle'
  | 'stage'
  | 'capsule'
  | 'drone'
  | 'rover'
  | 'lander'
  | 'ground_station'
  | 'pad'
  | 'debris'
  // celestial bodies (entities with a `body` provider, see `bodyEntityRecords`)
  | 'star'
  | 'planet'
  | 'moon'
  | 'asteroid'
  | 'dwarf_planet'
  | (string & {});

export interface EntityLinks {
  streams?: StreamLink[];
  /** free-text query for news search */
  newsQuery?: string;
  launchId?: string;
  wikiUrl?: string;
}

/** Serializable entity as shipped server -> client. */
export interface EntityRecord {
  id: string;
  name: string;
  kind: EntityKind;
  bodyId: string;
  parentId?: string;
  /** external ids: norad, cospar, ll2, dsn, horizons ... */
  aliases: Record<string, string>;
  group?: string;
  provider?: ProviderSpec;
  phase?: MissionPhase;
  events?: EntityEvent[];
  links?: EntityLinks;
  render?: RenderHint;
  /** free-form attributes shown in the detail panel */
  attrs?: Record<string, string | number | boolean | null>;
  updatedAt: number;
  /** ms; first time the hub saw the entity (set on first insert, never changed). Optional: older records have none. */
  createdAt?: number;
}
