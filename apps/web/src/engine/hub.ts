import {
  classifyFeed, EntityGraph, type Article, type ConnectorHealth, type DsnSnapshot, type FeedLimit, type EntityRecord, type IssArrays, type IssFix, type Launch,
  type LiveAscent, type TelemetryPoint,
} from '@eio/core';
import { systemClock, type Clock, type TimerHandle } from './clock';
import { Emitter } from './emitter';
import type { Trajectory } from './trajectory';

export type NewEntity = Omit<EntityRecord, 'updatedAt'>;

const ommEpochMs = (epoch: string): number => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(epoch) ? epoch : `${epoch}Z`);

/**
 * Two sources (celestrak, spacetrack) supply SGP4 elements for the same `sat-<NORAD>` id. The incoming record keeps its other
 * fields, but an element set never replaces a NEWER one: a stale CelesTrak snapshot (epoch 27 Oct, a decaying set) used to
 * overwrite Space-Track's current set whenever CelesTrak ran last. An unparseable epoch does not block the update.
 */
export function keepNewerElements<T extends NewEntity>(prev: EntityRecord | undefined, rec: T): T {
  const a = prev?.provider, b = rec.provider;
  if (a?.type !== 'sgp4' || b?.type !== 'sgp4') return rec;
  return ommEpochMs(b.omm.EPOCH) < ommEpochMs(a.omm.EPOCH) ? { ...rec, provider: a } : rec;
}

/** The events a Hub emits and their payloads. */
export interface HubEvents {
  'entities.changed': { ids: string[]; at: number };
  launches: Launch[];
  news: Article[];
  dsn: DsnSnapshot;
  'iss.fix': IssFix;
  'iss.telemetry': TelemetryPoint[];
  'iss.arrays': IssArrays;
  health: ConnectorHealth[];
  topic: { topic: string; count: number };
}

/**
 * Central in-memory state shared by connectors and whatever serves them to the app (the data worker's API and stream).
 * Events: `entities.changed` ({ids, at}), `launches`, `news`, `dsn`, `iss.fix`, `iss.telemetry`, `iss.arrays`,
 * `health` and `topic` ({topic, count}).
 */
export class Hub extends Emitter<HubEvents> {
  readonly graph = new EntityGraph();
  launches: Launch[] = [];
  articles: Article[] = [];
  dsn: DsnSnapshot = { fetchedAt: 0, links: [] };
  issFix?: IssFix;
  /** latest structured SARJ / BGA / attitude values from the ISSLIVE feed */
  issArrays?: IssArrays;
  readonly telemetry = new Map<string, TelemetryPoint>();
  /** request budget of a feed from the limiter (set by the Scheduler); shown as `health.limit` */
  limitOf?: (feedId: string) => Promise<FeedLimit | undefined> | FeedLimit | undefined;
  /** ascent trajectories bundled with the app */
  trajectories: Trajectory[] = [];
  /** measured ascent rows posted to POST /api/telemetry/:launchId, by LL2 launch id */
  readonly liveTelemetry = new Map<string, LiveAscent>();
  readonly health = new Map<string, ConnectorHealth>();

  private topics = new Map<string, number>();
  private changed = new Set<string>();
  private flushTimer?: TimerHandle;

  constructor(private debounceMs = 250, private clock: Clock = systemClock) {
    super();
  }

  /**
   * Insert or replace entities, stamping `updatedAt`. `createdAt` is set on the first insert of an id (from the record
   * if it carries one, else now) and kept afterwards. Unchanged records are ignored. Returns the changed count.
   */
  upsert(...recs: (NewEntity & { updatedAt?: number })[]): number {
    const now = this.clock.now();
    let n = 0;
    for (const { updatedAt: _, ...incoming } of recs) {
      const prev = this.graph.get(incoming.id);
      const rec = keepNewerElements(prev, incoming);
      if (prev && sameRecord(prev, rec)) continue;
      this.graph.upsert({ ...rec, createdAt: prev?.createdAt ?? rec.createdAt ?? now, updatedAt: now });
      this.changed.add(rec.id);
      n++;
    }
    if (n) this.flushTimer ??= this.clock.setTimeout(() => this.flush(), this.debounceMs);
    return n;
  }

  /** Emit pending `entities.changed` now. */
  flush(): void {
    this.clock.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.changed.size) return;
    const ids = [...this.changed];
    this.changed.clear();
    this.emit('entities.changed', { ids, at: this.clock.now() });
  }

  setLaunches(launches: Launch[]): void {
    this.launches = [...launches].sort((a, b) => Date.parse(a.net) - Date.parse(b.net));
    this.emit('launches', this.launches);
  }

  setArticles(articles: Article[]): void {
    this.articles = articles;
    this.emit('news', articles);
  }

  setDsn(snapshot: DsnSnapshot): void {
    this.dsn = snapshot;
    this.emit('dsn', snapshot);
  }

  setIssFix(fix: IssFix): void {
    this.issFix = fix;
    this.emit('iss.fix', fix);
  }

  setArrays(arrays: IssArrays): void {
    this.issArrays = arrays;
    this.emit('iss.arrays', arrays);
  }

  setTelemetry(points: TelemetryPoint[]): void {
    for (const p of points) this.telemetry.set(p.id, p);
    this.emit('iss.telemetry', points);
  }

  /** Health record for a connector, created on first access. */
  healthOf(id: string): ConnectorHealth {
    let h = this.health.get(id);
    if (!h) this.health.set(id, (h = { id, status: 'idle', runs: 0 }));
    return h;
  }

  /**
   * The health records as sent to clients: each carries its `feed` colour level and reason. Async because the request budget
   * (`limit`) is read from the persistent limiter.
   */
  async healthList(): Promise<ConnectorHealth[]> {
    return Promise.all([...this.health.values()].map(async (h) => {
      const limit = await this.limitOf?.(h.id);
      const withLimit = limit ? { ...h, limit } : { ...h, limit: undefined };
      return { ...withLimit, feed: classifyFeed(withLimit) };
    }));
  }

  subscribe(topic: string): void {
    const count = (this.topics.get(topic) ?? 0) + 1;
    this.topics.set(topic, count);
    this.emit('topic', { topic, count });
  }

  unsubscribe(topic: string): void {
    const count = Math.max(0, (this.topics.get(topic) ?? 0) - 1);
    if (count) this.topics.set(topic, count);
    else this.topics.delete(topic);
    this.emit('topic', { topic, count });
  }

  subscribers(topic: string): number {
    return this.topics.get(topic) ?? 0;
  }
}

/** Equal ignoring the hub-stamped times (`updatedAt`, `createdAt`). */
function sameRecord(a: EntityRecord, b: NewEntity): boolean {
  const { updatedAt: _, createdAt: __, ...rest } = a;
  const { createdAt: ___, ...other } = b;
  return JSON.stringify(rest) === JSON.stringify(other);
}
