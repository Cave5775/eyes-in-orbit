import { EventEmitter } from 'node:events';
import {
  EntityGraph, type Article, type ConnectorHealth, type DsnSnapshot, type EntityRecord, type IssFix, type Launch,
  type LiveAscent, type TelemetryPoint,
} from '@eio/core';
import type { Trajectory } from './trajectory';

export type NewEntity = Omit<EntityRecord, 'updatedAt'>;

/**
 * Central in-memory state shared by connectors, the HTTP API and the WebSocket.
 * Events: `entities.changed` ({ids, at}), `launches`, `news`, `dsn`, `iss.fix`, `iss.telemetry`,
 * `health` and `topic` ({topic, count}).
 */
export class Hub extends EventEmitter {
  readonly graph = new EntityGraph();
  launches: Launch[] = [];
  articles: Article[] = [];
  dsn: DsnSnapshot = { fetchedAt: 0, links: [] };
  issFix?: IssFix;
  readonly telemetry = new Map<string, TelemetryPoint>();
  /** ascent trajectories loaded from data/trajectories */
  trajectories: Trajectory[] = [];
  /** measured ascent rows posted to POST /api/telemetry/:launchId, by LL2 launch id */
  readonly liveTelemetry = new Map<string, LiveAscent>();
  readonly health = new Map<string, ConnectorHealth>();

  private topics = new Map<string, number>();
  private changed = new Set<string>();
  private flushTimer?: NodeJS.Timeout;

  constructor(private debounceMs = 250) {
    super();
  }

  /** Insert or replace entities, stamping `updatedAt`. Unchanged records are ignored. Returns the changed count. */
  upsert(...recs: (NewEntity & { updatedAt?: number })[]): number {
    const now = Date.now();
    let n = 0;
    for (const { updatedAt: _, ...rec } of recs) {
      const prev = this.graph.get(rec.id);
      if (prev && sameRecord(prev, rec)) continue;
      this.graph.upsert({ ...rec, updatedAt: now });
      this.changed.add(rec.id);
      n++;
    }
    if (n) this.flushTimer ??= setTimeout(() => this.flush(), this.debounceMs);
    return n;
  }

  /** Emit pending `entities.changed` now. */
  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.changed.size) return;
    const ids = [...this.changed];
    this.changed.clear();
    this.emit('entities.changed', { ids, at: Date.now() });
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

  healthList(): ConnectorHealth[] {
    return [...this.health.values()];
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

function sameRecord(a: EntityRecord, b: NewEntity): boolean {
  const { updatedAt: _, ...rest } = a;
  return JSON.stringify(rest) === JSON.stringify(b);
}
