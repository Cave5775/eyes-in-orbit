import type { EntityRecord } from '@eio/core';

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

/** Largest page the server returns however many records are asked for (a page is built in memory and sent as one JSON document). */
export const MAX_PAGE = 50_000;

export interface EntityPage {
  entities: EntityRecord[];
  /** offset of the next page; absent on the last one */
  next?: number;
  /** matching records in all (only on the first page of a paged request: counting is one more pass) */
  total?: number;
}

/**
 * One page of `GET /api/entities`: the records matching the filter, `offset` matches skipped, at most `limit` (capped at
 * `MAX_PAGE`) returned. Without `limit` and `offset` this is the whole answer, exactly as before (`next` absent). The order is
 * catalog order (insertion; an update does not move a record), so pages of one load fit together as long as nothing was
 * removed meanwhile; a client takes `serverTime` of the first page for its next `since` request, which catches whatever
 * changed while it was paging.
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

/** Filter for `GET /api/entities`. `q` is a plain substring/alias filter; ordering is catalog order. */
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
