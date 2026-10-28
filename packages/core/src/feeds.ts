import type { FeedState } from './feed-state';
import type { MissionPhase, StreamLink } from './types';

/** Normalised launch record (from Launch Library 2). */
export interface Launch {
  id: string;
  name: string;
  status: { id: number; name: string; abbrev: string };
  /** ISO 8601 UTC */
  net: string;
  windowStart?: string;
  windowEnd?: string;
  provider?: string;
  vehicle?: string;
  mission?: { name: string; type?: string; description?: string; orbit?: string };
  pad?: { name: string; latitude: number; longitude: number; location?: string; countryCode?: string };
  streams: StreamLink[];
  image?: string;
  /** first-stage recovery plan (LL2 `launcher_stage[0].landing`), when known */
  landing?: { attempt: boolean; location?: string; type?: string };
  phase: MissionPhase;
  hold: boolean;
  /** entity id of the launch vehicle entity */
  entityId: string;
}

export interface Article {
  id: number;
  title: string;
  url: string;
  imageUrl?: string;
  site: string;
  summary?: string;
  publishedAt: string;
  launchIds?: string[];
}

export interface DsnLink {
  dish: string; // DSS-14
  complex: 'Goldstone' | 'Madrid' | 'Canberra' | string;
  spacecraft: string[]; // target codes e.g. VGR1
  azimuthDeg?: number;
  elevationDeg?: number;
  rangeKm?: number;
  rtltSec?: number;
  downlink?: { active: boolean; band?: string; frequencyHz?: number; dataRateBps?: number; powerKw?: number };
  uplink?: { active: boolean; band?: string; frequencyHz?: number; dataRateBps?: number; powerKw?: number };
}

export interface DsnSnapshot {
  fetchedAt: number;
  links: DsnLink[];
}

export interface IssFix {
  t: number;
  latitude: number;
  longitude: number;
  altitudeKm: number;
  velocityKmh: number;
  visibility: string;
  footprintKm: number;
}

export interface TelemetryPoint {
  id: string;
  label: string;
  value: string;
  unit?: string;
  t: number;
  /** true when the item id to meaning mapping was checked against live data (see docs/reference.md, ISS array telemetry); absent = not claimed */
  verified?: boolean;
}

/** ISS solar array power channels: odd = starboard (S4: 1A 3A, S6: 1B 3B), even = port (P4: 2A 4A, P6: 2B 4B). */
export type IssChannel = '1A' | '1B' | '2A' | '2B' | '3A' | '3B' | '4A' | '4B';
export const ISS_CHANNELS: readonly IssChannel[] = ['1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B'];

/**
 * Structured ISS array telemetry from the ISSLIVE Lightstreamer feed (`iss.arrays` message, `GET /api/iss`).
 * Angles are the raw public values in degrees, 0 to 360, in the feed's own sign conventions (see `apps/web/src/lib/arrays.ts`
 * for how the client turns them into joint rotations).
 */
export interface IssArrays {
  /** time of the newest SARJ sample (ms since epoch); the SARJ items update about once a second */
  t: number;
  sarj: { port?: number; starboard?: number };
  /** beta gimbal assembly angle per power channel */
  bga: Partial<Record<IssChannel, number>>;
  /** ISS attitude relative to LVLH as a unit quaternion [w, x, y, z] taking body axes to LVLH axes (USLAB000018-21) */
  attitude?: [number, number, number, number];
  /** which parts were checked against live data; unverified parts must not drive the 3D model */
  verified: { sarj: boolean; bga: boolean; attitude: boolean };
}

/** Credentials the UI can set (`GET/PUT /api/credentials`); each one is read by a server connector. */
export type CredentialKey = 'spacetrackUser' | 'spacetrackPassword' | 'll2Token';

/** What the server tells the UI about one credential. Secret values are never sent, only whether one is set. */
export interface CredentialInfo {
  key: CredentialKey;
  label: string;
  connector: string;
  secret: boolean;
  set: boolean;
  /** where the active value comes from: typed into the UI, or an environment variable / `.env` */
  source: 'ui' | 'env' | null;
  /** the value itself, for non-secret fields (e.g. the Space-Track username) */
  value?: string;
}

export interface ConnectorHealth {
  id: string;
  status: 'idle' | 'ok' | 'error' | 'disabled' | 'stub';
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  nextRunAt?: number;
  runs: number;
  note?: string;
  /** true when the last response was served from the local cache */
  fromCache?: boolean;
  /** consecutive failed runs (0 after a successful one) */
  failures?: number;
  /** OFFLINE=1 and this connector would need the network */
  offline?: boolean;
  /** colour level and reason, computed by the server (`classifyFeed`); absent on records that did not come from it */
  feed?: FeedState;
}

/** Messages pushed over the WebSocket. */
export type ServerMessage =
  | { type: 'hello'; serverTime: number; entityCount: number }
  | { type: 'entities.changed'; ids: string[]; at: number }
  | { type: 'launches'; launches: Launch[] }
  | { type: 'news'; articles: Article[] }
  | { type: 'dsn'; snapshot: DsnSnapshot }
  | { type: 'iss.fix'; fix: IssFix }
  | { type: 'iss.telemetry'; points: TelemetryPoint[] }
  | { type: 'iss.arrays'; arrays: IssArrays }
  | { type: 'health'; connectors: ConnectorHealth[] };

export type ClientMessage = { op: 'subscribe'; topics: string[] } | { op: 'unsubscribe'; topics: string[] };
