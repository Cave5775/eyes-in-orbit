import { rankMatches, type EntityRecord } from '@eio/core';
import type { Hub } from './hub';

/**
 * Entity paging, ranked search, match and counts over the Hub's in-memory entity graph. The server answered `match` from an
 * SQLite FTS5 trigram index; here the pure ranking (`@eio/core` `rankMatches`) runs over the catalogue directly. Measured at
 * 100 000 entities in `test/engine/search.test.ts` (timing printed there): fast enough without an index, so none is kept.
 */

export interface SearchHit {
  id: string;
  name: string;
  kind: string;
  group?: string;
  aliases: Record<string, string>;
}

export interface EntityQuery {
  since?: number;
  kind?: string;
  body?: string;
  q?: string;
  group?: string;
  limit?: number;
  /** matching records to skip before the page starts (with `limit`: paging, see `pageEntities`) */
  offset?: number;
}

/** Lower is better; used to break ties between equally matching entities. */
const KIND_RANK: Record<string, number> = { station: 0, launch_vehicle: 1, probe: 2, ground_station: 3, debris: 9 };

/**
 * 0 exact id or alias value (NORAD, COSPAR, ...), 1 exact name, 2 name prefix, 3 word prefix,
 * 4 name substring, 5 alias substring; -1 no match.
 */
export function matchTier(rec: EntityRecord, q: string): number {
  const name = rec.name.toLowerCase();
  if (rec.id.toLowerCase() === q) return 0;
  for (const v of Object.values(rec.aliases)) if (v.toLowerCase() === q) return 0;
  if (name === q) return 1;
  if (name.startsWith(q)) return 2;
  if (name.includes(` ${q}`) || name.includes(`(${q}`) || name.includes(`-${q}`)) return 3;
  if (name.includes(q)) return 4;
  for (const v of Object.values(rec.aliases)) if (v.toLowerCase().includes(q)) return 5;
  return -1;
}

export function searchEntities(records: Iterable<EntityRecord>, query: string, limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: { rec: EntityRecord; tier: number }[] = [];
  for (const rec of records) {
    const tier = matchTier(rec, q);
    if (tier >= 0) hits.push({ rec, tier });
  }
  hits.sort((a, b) =>
    a.tier - b.tier
    || (KIND_RANK[a.rec.kind] ?? 5) - (KIND_RANK[b.rec.kind] ?? 5)
    || a.rec.name.length - b.rec.name.length
    || a.rec.name.localeCompare(b.rec.name));
  return hits.slice(0, limit).map(({ rec }) => ({
    id: rec.id, name: rec.name, kind: rec.kind, group: rec.group, aliases: rec.aliases,
  }));
}

/** Largest page returned however many records are asked for (a page is built in memory and handed over as one message). */
export const MAX_PAGE = 50_000;

export interface EntityPage {
  entities: EntityRecord[];
  /** offset of the next page; absent on the last one */
  next?: number;
  /** matching records in all (only on the first page of a paged request: counting is one more pass) */
  total?: number;
}

/**
 * One page of the entity list: the records matching the filter, `offset` matches skipped, at most `limit` (capped at
 * `MAX_PAGE`) returned. Without `limit` and `offset` this is the whole answer (`next` absent). The order is catalog order
 * (insertion; an update does not move a record), so pages of one load fit together as long as nothing was removed meanwhile;
 * a client takes the `serverTime` of the first page for its next `since` request, which catches whatever changed while it was
 * paging.
 */
export function pageEntities(records: Iterable<EntityRecord>, f: EntityQuery): EntityPage {
  const paged = f.limit !== undefined || (f.offset ?? 0) > 0;
  const offset = Math.max(0, Math.floor(f.offset ?? 0));
  const limit = f.limit && f.limit > 0 ? Math.min(Math.floor(f.limit), MAX_PAGE) : paged ? MAX_PAGE : Infinity;
  const q = f.q?.trim().toLowerCase();
  const entities: EntityRecord[] = [];
  let seen = 0;
  let more = false;
  for (const rec of records) {
    if (f.since !== undefined && !(rec.updatedAt > f.since)) continue;
    if (f.kind && rec.kind !== f.kind) continue;
    if (f.body && rec.bodyId !== f.body) continue;
    if (f.group && rec.group !== f.group) continue;
    if (q && matchTier(rec, q) < 0) continue;
    seen++;
    if (seen <= offset) continue;
    if (entities.length >= limit) {
      more = true;
      // the first page also counts the rest: one cheap pass, so a client can show progress
      if (offset > 0) break;
      continue;
    }
    entities.push(rec);
  }
  const page: EntityPage = { entities };
  if (more) page.next = offset + entities.length;
  if (paged && offset === 0) page.total = seen;
  return page;
}

/** Filter of the entity list. `q` is a plain substring/alias filter; ordering is catalog order. */
export function filterEntities(records: Iterable<EntityRecord>, f: EntityQuery): EntityRecord[] {
  const q = f.q?.trim().toLowerCase();
  const out: EntityRecord[] = [];
  const limit = f.limit && f.limit > 0 ? f.limit : Infinity;
  for (const rec of records) {
    if (f.since !== undefined && !(rec.updatedAt > f.since)) continue;
    if (f.kind && rec.kind !== f.kind) continue;
    if (f.body && rec.bodyId !== f.body) continue;
    if (f.group && rec.group !== f.group) continue;
    if (q && matchTier(rec, q) < 0) continue;
    out.push(rec);
    if (out.length >= limit) break;
  }
  return out;
}

/** Most ids one `match` answer carries. */
export const MAX_MATCH = 100_000;

export interface MatchResult {
  /** every matching entity id, best first (capped at `MAX_MATCH`) */
  ids: string[];
  /** matches found (more than `ids.length` when `truncated`) */
  total: number;
  /** the answer is incomplete: more matches exist than were returned */
  truncated: boolean;
  /** how it was answered; always a scan of the catalogue here (the server had a trigram index) */
  via: 'index' | 'scan';
}

/** Every entity matching `q`, best first by the shared ranking (core `rankMatches`). */
export function matchEntities(records: Iterable<EntityRecord>, q: string): MatchResult {
  const query = q.trim().toLowerCase();
  if (!query) return { ids: [], total: 0, truncated: false, via: 'scan' };
  const ranked = rankMatches(records, query);
  const total = ranked.length;
  return { ids: ranked.slice(0, MAX_MATCH).map((r) => r.rec.id), total, truncated: total > MAX_MATCH, via: 'scan' };
}

export interface CountRow {
  body: string;
  kind: string;
  group: string | null;
  count: number;
}

/** Entity counts per body, kind and group in one pass, most numerous first (then body, kind, group). */
export function countEntities(records: Iterable<EntityRecord>): { total: number; rows: CountRow[] } {
  const by = new Map<string, CountRow>();
  let total = 0;
  for (const r of records) {
    total++;
    const group = r.group ?? null;
    // a group-less record and one with an empty group name must stay apart
    const key = `${r.bodyId}\u0000${r.kind}\u0000${group === null ? '-' : `+${group}`}`;
    const row = by.get(key);
    if (row) row.count++;
    else by.set(key, { body: r.bodyId, kind: r.kind, group, count: 1 });
  }
  const cmp = (a: string | null, b: string | null): number => ((a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0);
  const rows = [...by.values()].sort((a, b) => b.count - a.count || cmp(a.body, b.body) || cmp(a.kind, b.kind) || cmp(a.group, b.group));
  return { total, rows };
}

/** The search calls over a Hub. Pending entity changes are flushed first, so an answer includes what changed a moment ago. */
export class EntitySearch {
  constructor(private hub: Pick<Hub, 'graph' | 'flush'>) {}

  page(f: EntityQuery): EntityPage & { serverTime: number } {
    return { serverTime: Date.now(), ...pageEntities(this.hub.graph.all(), f) };
  }

  search(q: string, limit = 20): SearchHit[] {
    return searchEntities(this.hub.graph.all(), q, Math.min(limit, 100));
  }

  match(q: string): MatchResult & { q: string } {
    this.hub.flush();
    return { q, ...matchEntities(this.hub.graph.all(), q) };
  }

  counts(): { total: number; rows: CountRow[] } {
    this.hub.flush();
    return countEntities(this.hub.graph.all());
  }
}
