import type { ClientMessage, ServerMessage } from '@eio/core';
import type { Api, MinorPlanetStatus } from '../api/types';

/**
 * The messages between the page and the data worker (`data.worker.ts`). The worker pushes the same `ServerMessage`s the old
 * `/stream` WebSocket sent (plus `minorPlanets`), and answers one RPC per `Api` method. `mapTile` is not an RPC: it only builds a URL.
 * There is deliberately no method that writes telemetry rows or clears them: nothing outside the engine may change what the app draws
 * for a launch.
 */
export type WorkerEvent = ServerMessage | { type: 'minorPlanets'; status: MinorPlanetStatus };

/** The Api methods that run in the worker. */
export type RpcMethod = Exclude<keyof Api, 'mapTile'>;
export type RpcArgs<M extends RpcMethod> = Parameters<Api[M]>;
export type RpcResult<M extends RpcMethod> = Awaited<ReturnType<Api[M]>>;

/** Every method name (the handler rejects anything else). */
export const RPC_METHODS: readonly RpcMethod[] = [
  'entities', 'search', 'match', 'launches', 'news', 'dsn', 'describe', 'archiveImages', 'iss', 'health', 'ascent', 'traverse',
  'minorPlanetIndex', 'minorPlanetChunk', 'minorPlanetsStatus', 'minorPlanetsDownload', 'minorPlanetsCancel',
  'credentials', 'saveCredentials', 'clearCredentials',
];

export type ToWorker =
  | { kind: 'rpc'; id: number; method: RpcMethod; args: unknown[] }
  /** a stream consumer: the worker answers with hello, health, launches, news and dsn, like a new WebSocket did */
  | { kind: 'start' }
  /** the consumer is gone: its topics are released */
  | { kind: 'stop' }
  | { kind: 'client'; msg: ClientMessage };

export interface RpcError {
  message: string;
  name?: string;
  /** a request the limiter refused: when asking is possible again */
  retryAt?: number;
  limited?: boolean;
}

export type FromWorker =
  | { kind: 'ready' }
  /** the engine could not start at all (nothing is served); the page falls back to the mock */
  | { kind: 'fatal'; error: string }
  | { kind: 'event'; msg: WorkerEvent }
  | { kind: 'result'; id: number; ok: true; value: unknown }
  | { kind: 'result'; id: number; ok: false; error: RpcError };

export const MAX_TOPICS = 16;
export const HEALTH_THROTTLE_MS = 2000;
