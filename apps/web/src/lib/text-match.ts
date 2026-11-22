import type { EntityRecord } from '@eio/core';
import { searchHitOf, type SearchHit } from './filters';

/** The data worker's answer to `api.match`: what the store needs of it. */
export interface MatchAnswer {
  ids: string[];
  total: number;
  /** the server's cap cut the list: it is incomplete, rank locally instead */
  truncated: boolean;
}

export type MatchFn = (text: string) => Promise<MatchAnswer>;

/** A catalogue with at least this many records is searched by the server (below it a local pass costs a few milliseconds). */
export const SERVER_SEARCH_MIN = 20_000;

/** Pause after the last keystroke before a text is sent to the server (the local search needed none: it was synchronous). */
export const REMOTE_TEXT_DELAY_MS = 150;

/** The hit rows (best first, as the server ordered the ids) for the records this client holds; an id it does not have yet is skipped. */
export function textHitsOf(ids: readonly string[], entities: ReadonlyMap<string, EntityRecord>): SearchHit[] {
  const out: SearchHit[] = [];
  for (const id of ids) {
    const r = entities.get(id);
    if (r) out.push(searchHitOf(r));
  }
  return out;
}
