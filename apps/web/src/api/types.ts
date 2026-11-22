import type {
  ArchiveImagesResult, Article, AscentSeries, ConnectorHealth, CredentialInfo, CredentialKey, Description, DsnSnapshot, EntityRecord, IssArrays, IssFix, Launch,
  RoverTraverse, TelemetryPoint,
} from '@eio/core';
import type { SearchHit } from '../lib/filters';
import type { MmgisLayer } from '@eio/core';

/** The stored MPCORB orbits as the minor-planet layer reads them: how many, and how they are cut into chunks (by H, brightest first). */
export interface MinorPlanetIndex {
  count: number;
  chunkSize: number;
  /** `hFirst` / `hLast` are the H range of the whole set on its first / last chunk (the engine keeps no per-chunk range) */
  chunks: { chunk: number; count: number; hFirst: number | null; hLast: number | null }[];
  fetchedAt: number;
  stale: boolean;
  skipped: number;
  epochMin: number | null;
  epochMax: number | null;
  credit: string;
}

/**
 * The minor-planet download (about 70 MB from the Minor Planet Center) is opt-in: it starts when the Minor planets layer is turned on
 * or the Download button is pressed. `none`: nothing stored; `downloading`: `phase` says whether the file is being checked, read
 * (it is unzipped and packed as it arrives) or written to storage; `ready`: stored (`count`, `fetchedAt`); `failed`: `error`
 * (stored data, if any, is still served).
 */
export interface MinorPlanetStatus {
  state: 'none' | 'downloading' | 'ready' | 'failed';
  phase?: 'checking' | 'downloading' | 'storing';
  count?: number;
  fetchedAt?: number;
  error?: string;
}

/** Where the browser keeps the data (IndexedDB database `eio`) and how much room it has. */
export interface StorageInfo {
  /** false: IndexedDB could not be opened, so everything lives in memory and a reload starts empty (`error` says why) */
  persistent: boolean;
  /** `navigator.storage.persist()` was granted: the browser will not evict the data under pressure */
  persisted?: boolean;
  usageBytes?: number;
  quotaBytes?: number;
  error?: string;
}

/**
 * The data layer the UI calls: the browser data engine (a dedicated worker, `workers/data.worker.ts`) through `api/worker-api.ts`,
 * or the offline mock. Every method is an RPC to the engine's in-memory catalogue, its IndexedDB cache or, for the on-demand
 * lookups, the upstream source.
 */
export interface Api {
  /** Everything (or what changed after `since`), or one page with `page` (`limit` records after `offset` matches; the answer carries `next` unless it is the last page). */
  entities(since?: number, page?: { offset?: number; limit?: number }): Promise<{ serverTime: number; entities: EntityRecord[]; next?: number; total?: number }>;
  search(q: string, limit?: number): Promise<SearchHit[]>;
  /** Every entity matching the text, best first (the engine scans its catalogue; `truncated`: the cap cut the list). */
  match(q: string): Promise<{ q: string; ids: string[]; total: number; truncated: boolean; via?: 'index' | 'scan' }>;
  launches(): Promise<Launch[]>;
  news(opts?: { entity?: string; q?: string; limit?: number }): Promise<Article[]>;
  dsn(): Promise<DsnSnapshot>;
  /** About text of one object: looked up on demand (Wikidata, Wikipedia, ESA DISCOS with a token) and cached in the browser. */
  describe(entityId: string): Promise<Description>;
  /** Images of a body taken by one observatory, from its public archive; cached in the browser. */
  archiveImages(observatoryId: string, bodyId: string): Promise<ArchiveImagesResult>;
  iss(): Promise<{ fix?: IssFix; telemetry: TelemetryPoint[]; arrays?: IssArrays }>;
  /** The feeds' health, and (real engine only) where the data is kept. */
  health(): Promise<{ serverTime: number; entityCount: number; connectors: ConnectorHealth[]; storage?: StorageInfo }>;
  /** Modeled and measured ascent series of a launch; null when unknown. */
  ascent(launchId: string): Promise<AscentSeries | null>;
  /** The whole traverse of a Mars rover (from the surface-sites cache); null when unknown or not cached yet. */
  traverse(entityId: string): Promise<RoverTraverse | null>;
  /** Address of a Mars map tile (core `MMGIS_LAYERS`), or null when there is none (the mock has a few). */
  mapTile(layer: Pick<MmgisLayer, 'mission' | 'id'>, z: number, x: number, y: number): string | null;
  /** The index of the stored MPCORB orbits, or null when none are stored (nothing downloaded yet). */
  minorPlanetIndex(): Promise<MinorPlanetIndex | null>;
  /** Chunk k of the stored orbits as an `MPCB` container (core `mpcorb.ts`); the bytes are handed over, not copied. */
  minorPlanetChunk(k: number): Promise<Uint8Array>;
  /** The download state (see `MinorPlanetStatus`); changes are also pushed as `minorPlanets` stream messages. */
  minorPlanetsStatus(): Promise<MinorPlanetStatus>;
  /** Download (or, with `force`, refresh) the MPCORB orbits; fresh stored data is left alone. Resolves with the final state when it ends. */
  minorPlanetsDownload(opts?: { force?: boolean }): Promise<MinorPlanetStatus>;
  /** Abort a download in progress (the layer was turned off); stored data is kept. */
  minorPlanetsCancel(): Promise<void>;
  /** API keys and logins the engine can use; secrets are reported as set / not set only. */
  credentials(): Promise<CredentialInfo[]>;
  /** A string sets a value, `null` removes it. Stored unencrypted in this browser profile. Resolves with the new state. */
  saveCredentials(values: Partial<Record<CredentialKey, string | null>>): Promise<CredentialInfo[]>;
  /** Remove every saved credential. Resolves with the new state. */
  clearCredentials(): Promise<CredentialInfo[]>;
}
