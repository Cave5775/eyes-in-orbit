import type {
  Article, AscentSeries, ConnectorHealth, CredentialInfo, CredentialKey, DsnSnapshot, EntityRecord, IssArrays, IssFix, Launch,
  TelemetryPoint,
} from '@eio/core';
import type { SearchHit } from '../lib/filters';

/** REST surface of the server contract (also implemented by the offline mock). */
export interface Api {
  entities(since?: number): Promise<{ serverTime: number; entities: EntityRecord[] }>;
  search(q: string, limit?: number): Promise<SearchHit[]>;
  launches(): Promise<Launch[]>;
  news(opts?: { entity?: string; q?: string; limit?: number }): Promise<Article[]>;
  dsn(): Promise<DsnSnapshot>;
  iss(): Promise<{ fix?: IssFix; telemetry: TelemetryPoint[]; arrays?: IssArrays }>;
  health(): Promise<{ serverTime: number; entityCount: number; connectors: ConnectorHealth[] }>;
  /** Modeled and measured ascent series of a launch (`GET /api/telemetry/:launchId`); null when unknown. */
  ascent(launchId: string): Promise<AscentSeries | null>;
  /** API keys and logins the local server can use (`GET /api/credentials`); secrets are reported as set / not set only. */
  credentials(): Promise<CredentialInfo[]>;
  /** `PUT /api/credentials`: a string sets a value, `null` removes the UI value. Resolves with the new state. */
  saveCredentials(values: Partial<Record<CredentialKey, string | null>>): Promise<CredentialInfo[]>;
}
