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
