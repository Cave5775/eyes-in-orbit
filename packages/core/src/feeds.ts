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
  | { type: 'health'; connectors: ConnectorHealth[] };

export type ClientMessage = { op: 'subscribe'; topics: string[] } | { op: 'unsubscribe'; topics: string[] };
