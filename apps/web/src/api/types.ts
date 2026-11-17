import type {
  ArchiveImagesResult, Article, AscentSeries, ConnectorHealth, CredentialInfo, CredentialKey, Description, DsnSnapshot, EntityRecord, IssArrays, IssFix, Launch,
  RoverTraverse, TelemetryPoint,
} from '@eio/core';
import type { SearchHit } from '../lib/filters';

/** REST surface of the server contract (also implemented by the offline mock). */
export interface Api {
  /** `GET /api/entities`: everything (or what changed after `since`), or one page with `page` (`limit` records after `offset` matches; the answer carries `next` unless it is the last page). */
  entities(since?: number, page?: { offset?: number; limit?: number }): Promise<{ serverTime: number; entities: EntityRecord[]; next?: number; total?: number }>;
  search(q: string, limit?: number): Promise<SearchHit[]>;
  /** `GET /api/match`: every entity matching the text, best first, found through the server's FTS5 index (`truncated`: the server's cap cut the list). */
  match(q: string): Promise<{ q: string; ids: string[]; total: number; truncated: boolean; via?: 'index' | 'scan' }>;
  launches(): Promise<Launch[]>;
  news(opts?: { entity?: string; q?: string; limit?: number }): Promise<Article[]>;
  dsn(): Promise<DsnSnapshot>;
  /** About text of one object (`GET /api/describe/:entityId`): looked up on demand and cached by the server. */
  describe(entityId: string): Promise<Description>;
  /** Images of a body taken by one observatory, from its public archive (`GET /api/archive-images`); cached by the server. */
  archiveImages(observatoryId: string, bodyId: string): Promise<ArchiveImagesResult>;
  iss(): Promise<{ fix?: IssFix; telemetry: TelemetryPoint[]; arrays?: IssArrays }>;
  health(): Promise<{ serverTime: number; entityCount: number; connectors: ConnectorHealth[] }>;
  /** Modeled and measured ascent series of a launch (`GET /api/telemetry/:launchId`); null when unknown. */
  ascent(launchId: string): Promise<AscentSeries | null>;
  /** The whole traverse of a Mars rover (`GET /api/traverse/:entityId`); null when unknown or not cached yet. */
  traverse(entityId: string): Promise<RoverTraverse | null>;
  /** API keys and logins the local server can use (`GET /api/credentials`); secrets are reported as set / not set only. */
  credentials(): Promise<CredentialInfo[]>;
  /** `PUT /api/credentials`: a string sets a value, `null` removes the UI value. Resolves with the new state. */
  saveCredentials(values: Partial<Record<CredentialKey, string | null>>): Promise<CredentialInfo[]>;
}
