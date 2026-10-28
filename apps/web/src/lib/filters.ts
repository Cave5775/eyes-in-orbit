import type { EntityRecord } from '@eio/core';

/** Search ranking, facet counts and the browse order of the entity list (pure). What is shown at all is lib/query.ts. */

/**
 * Relevance of `rec` for query `q`: exact id/alias > name prefix > word prefix > substring.
 * Mirrors the server's ranking so offline/mock search behaves the same. 0 = no match.
 */
export function matchScore(rec: Pick<EntityRecord, 'id' | 'name' | 'aliases'>, q: string): number {
  const query = q.trim().toLowerCase();
  if (!query) return 1;
  const name = rec.name.toLowerCase();
  const id = rec.id.toLowerCase();
  const aliases = Object.values(rec.aliases).map((a) => String(a).toLowerCase());
  if (id === query || aliases.includes(query)) return 100;
  if (name.startsWith(query)) return 80;
  if (name.split(/[\s\-_()/]+/).some((w) => w.startsWith(query))) return 60;
  if (name.includes(query)) return 40;
  if (aliases.some((a) => a.includes(query))) return 30;
  if (id.includes(query)) return 20;
  return 0;
}

export interface SearchHit {
  id: string;
  name: string;
  kind: string;
  group?: string;
  aliases: Record<string, string>;
}

/** Local ranked search; stable by name for equal scores. */
export function rankEntities(records: Iterable<EntityRecord>, q: string, limit = 50): SearchHit[] {
  const scored: { rec: EntityRecord; s: number }[] = [];
  for (const rec of records) {
    const s = matchScore(rec, q);
    if (s > 0) scored.push({ rec, s });
  }
  scored.sort((a, b) => b.s - a.s || a.rec.name.localeCompare(b.rec.name));
  return scored.slice(0, limit).map(({ rec }) => ({ id: rec.id, name: rec.name, kind: rec.kind, group: rec.group, aliases: rec.aliases }));
}

/** Facet counts for the filter chips, most common first. */
export function facetCounts(records: Iterable<Pick<EntityRecord, 'kind' | 'group'>>): {
  kinds: [string, number][];
  groups: [string, number][];
} {
  const kinds = new Map<string, number>();
  const groups = new Map<string, number>();
  for (const r of records) {
    kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    if (r.group) groups.set(r.group, (groups.get(r.group) ?? 0) + 1);
  }
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { kinds: sorted(kinds), groups: sorted(groups) };
}

const KIND_PRIORITY: Record<string, number> = { station: 0, launch_vehicle: 1, probe: 2, rover: 3, ground_station: 4 };

/** Default browse order: notable kinds first, then alphabetical. */
export function browseOrder(a: Pick<EntityRecord, 'kind' | 'name'>, b: Pick<EntityRecord, 'kind' | 'name'>): number {
  return (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9) || a.name.localeCompare(b.name);
}
