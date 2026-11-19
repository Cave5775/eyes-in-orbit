import { matchScore, rankMatches, type EntityRecord } from '@eio/core';
import { typeOf } from './view-class';

/** Search ranking, facet counts and the browse order of the entity list (pure). What is shown at all is lib/query.ts. */

export { matchScore };

export interface SearchHit {
  id: string;
  name: string;
  kind: string;
  group?: string;
  aliases: Record<string, string>;
}

/** The row of a record in the lists and the search: its type as shown (`typeOf`), not its stored kind. */
export const searchHitOf = (rec: EntityRecord): SearchHit => ({ id: rec.id, name: rec.name, kind: typeOf(rec), group: rec.group, aliases: rec.aliases });

/** Local ranked search (the shared ranking, `@eio/core` match.ts); stable by name for equal scores. */
export function rankEntities(records: Iterable<EntityRecord>, q: string, limit = 50): SearchHit[] {
  return rankMatches(records, q, limit).map(({ rec }) => searchHitOf(rec));
}

/** Facet counts for the filter chips, most common first. */
export function facetCounts(records: Iterable<Pick<EntityRecord, 'kind' | 'group'> & Partial<Pick<EntityRecord, 'bodyId' | 'provider'>>>): {
  kinds: [string, number][];
  groups: [string, number][];
} {
  const kinds = new Map<string, number>();
  const groups = new Map<string, number>();
  for (const r of records) {
    const kind = typeOf(r);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
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
