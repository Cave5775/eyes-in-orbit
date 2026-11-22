import type { EntityRecord } from './types';

/**
 * Text search ranking of the entity catalogue (pure), shared by the browser (local search, the offline mock) and the engine
 * (`api.match`, which scans the catalogue and ranks it with this), so both order results the same way.
 */

/** What the ranking reads of a record. */
export type Matchable = Pick<EntityRecord, 'id' | 'name' | 'aliases'>;

/**
 * Relevance of `rec` for query `q`: exact id/alias > name prefix > word prefix > substring. 0 = no match. Every positive
 * score means `q` (lower-cased) is a substring of the lower-cased id, name or one alias, which is what an index of those
 * strings can find (`apps/web/src/engine/search.ts`).
 */
export function matchScore(rec: Matchable, q: string): number {
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

export interface Ranked<T extends Matchable> {
  rec: T;
  score: number;
}

/** The records that match `q`, best first (equal scores by name, then id: the order does not depend on how the records arrive). `limit` caps the answer; the sort is over matches only. */
export function rankMatches<T extends Matchable>(records: Iterable<T>, q: string, limit = Infinity): Ranked<T>[] {
  const scored: Ranked<T>[] = [];
  for (const rec of records) {
    const score = matchScore(rec, q);
    if (score > 0) scored.push({ rec, score });
  }
  scored.sort((a, b) => b.score - a.score || a.rec.name.localeCompare(b.rec.name) || (a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : 0));
  return scored.length > limit ? scored.slice(0, limit) : scored;
}
