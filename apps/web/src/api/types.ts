import type {
  Article, AscentSeries, ConnectorHealth, DsnSnapshot, EntityRecord, IssFix, Launch, TelemetryPoint,
} from '@eio/core';
import type { SearchHit } from '../lib/filters';

/** REST surface of the server contract (also implemented by the offline mock). */
export interface Api {
  entities(since?: number): Promise<{ serverTime: number; entities: EntityRecord[] }>;
  search(q: string, limit?: number): Promise<SearchHit[]>;
  launches(): Promise<Launch[]>;
  news(opts?: { entity?: string; q?: string; limit?: number }): Promise<Article[]>;
  dsn(): Promise<DsnSnapshot>;
  iss(): Promise<{ fix?: IssFix; telemetry: TelemetryPoint[] }>;
  health(): Promise<{ serverTime: number; entityCount: number; connectors: ConnectorHealth[] }>;
  /** Modeled and measured ascent series of a launch (`GET /api/telemetry/:launchId`); null when unknown. */
  ascent(launchId: string): Promise<AscentSeries | null>;
}
