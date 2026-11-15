import { matchScore, rankMatches, type EntityRecord } from '@eio/core';

/** Search ranking, facet counts and the browse order of the entity list (pure). What is shown at all is lib/query.ts. */

export { matchScore };

export interface SearchHit {
  id: string;
  name: string;
  kind: string;
  group?: string;
  aliases: Record<string, string>;
}

/** Local ranked search (the shared ranking, `@eio/core` match.ts); stable by name for equal scores. */
export function rankEntities(records: Iterable<EntityRecord>, q: string, limit = 50): SearchHit[] {
  return rankMatches(records, q, limit).map(({ rec }) => ({ id: rec.id, name: rec.name, kind: rec.kind, group: rec.group, aliases: rec.aliases }));
}

/**
 * The entity Enter in the search box jumps to: the first hit of the text's ranking (the order the list shows) that the query
 * lists. Blank text, or nothing listed, jumps nowhere.
 */
export function jumpTarget(text: string, hits: readonly SearchHit[] | null, listed: (hit: SearchHit) => boolean): string | undefined {
  if (!text.trim() || !hits) return undefined;
  return hits.find(listed)?.id;
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
