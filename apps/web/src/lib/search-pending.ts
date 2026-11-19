import { addTerms, termFromWord, withText, type Query, type Term } from './query';
import { parseQuery, tagToken, type TagKey } from './search-tags';

/**
 * The search field (pure). Typing is a SEARCH, not a filter: what is typed makes a pending query (the applied query plus the
 * typed tag words and text) that only the search list is evaluated against, through `classify` like everything else. The tree
 * and the scene keep following the applied query (the store's `query`) until the Filter button applies the pending one.
 */

/**
 * After a result is picked: is the search kept open (the typed text stays and the list keeps showing), or cleared (the field
 * empties and the panel goes back to the tree with the pick revealed)? One place to flip.
 */
export const KEEP_SEARCH_AFTER_PICK = false;
export const afterPick = (keep: boolean = KEEP_SEARCH_AFTER_PICK): { clearField: boolean } => ({ clearField: !keep });

/** The free text of the field (tag words and half-typed tags left out). */
export const searchTextOf = (input: string): string => parseQuery(input).text;

/** The tag words of the field as terms (`only`), in typing order. */
export function searchTagTerms(input: string): Term[] {
  const { include, exclude } = parseQuery(input).tags;
  const out: Term[] = [];
  for (const [list, neg] of [[include, false], [exclude, true]] as const) {
    for (const [key, values] of Object.entries(list)) {
      for (const v of values ?? []) {
        const t = termFromWord(tagToken(key as TagKey, v, neg));
        if (t) out.push(t);
      }
    }
  }
  return out;
}

/** Is a search being typed: some text or a finished tag word (a half-typed `group:` is not one)? */
export const isSearching = (input: string): boolean => searchTextOf(input) !== '' || searchTagTerms(input).length > 0;

/**
 * What the field asks for on top of the applied query: its tag words (a typed word takes over a hidden term of the same value)
 * and its text, which replaces the applied text; no typed text keeps the applied text. This is also exactly what Filter applies.
 */
export function pendingQuery(applied: Query, input: string): Query {
  const text = searchTextOf(input);
  const q = addTerms(applied, searchTagTerms(input), true);
  return text ? withText(q, text) : q;
}

/** The search results: the text's ranking when there is text (else the browse order), as far as the pending query lists them. */
export function searchRows<T extends { id: string }>(ordered: readonly T[], hits: readonly T[] | null, text: string, listed: (r: T) => boolean): T[] {
  return (text && hits ? hits : ordered).filter(listed);
}

/** The highlighted result after an arrow key: -1 is none; Down goes to the first, then on; Up goes back, off the top to none. */
export function moveHighlight(cur: number, key: 'ArrowDown' | 'ArrowUp', count: number): number {
  if (count <= 0) return -1;
  const at = Math.min(cur, count - 1);
  return key === 'ArrowDown' ? Math.min(at + 1, count - 1) : Math.max(at - 1, -1);
}

/**
 * The result Enter takes: the highlighted row of the list as displayed (which may be sorted), else the best-ranked match whatever
 * the Sort setting is (undefined when there is none).
 */
export const pickedResult = <T extends { id: string }>(displayed: readonly T[], ranked: readonly T[], highlight: number): string | undefined =>
  (displayed[highlight] ?? ranked[0])?.id;

export interface SearchSourceInput<T> {
  typed: string;
  /** the text the store has looked up for the search, and its answer (null while it is awaited) */
  storeText: string;
  searchHits: readonly T[] | null;
  searchIds: ReadonlySet<string> | null;
  /** the applied query's text and its lookup */
  appliedText: string;
  textHits: readonly T[] | null;
  textIds: ReadonlySet<string> | null;
}

/**
 * What the search list ranks and matches the text by. Typed text: its own lookup, and not ready until the answer for exactly that
 * text is in (no stale hits of an earlier text). No typed text: the applied text's lookup, because the pending query keeps the
 * applied text term, so the list, Enter and Filter all agree.
 */
export function searchSource<T>(i: SearchSourceInput<T>): { hits: readonly T[] | null; ids: ReadonlySet<string> | null; text: string; ready: boolean } {
  if (i.typed) return { hits: i.searchHits, ids: i.searchIds, text: i.typed, ready: i.storeText === i.typed && i.searchHits !== null };
  if (i.appliedText) return { hits: i.textHits, ids: i.textIds, text: i.appliedText, ready: i.textIds !== null };
  return { hits: null, ids: null, text: '', ready: true };
}

/** A key that belongs to an input method (a composition in progress; Safari reports keyCode 229): the search leaves it alone. */
export const IME_KEYS: readonly string[] = ['Enter', 'ArrowUp', 'ArrowDown', 'Tab', 'Escape'];
export const isImeKey = (key: string, isComposing: boolean, keyCode: number): boolean => IME_KEYS.includes(key) && (isComposing || keyCode === 229);

export type SearchKeyAction = 'ignore' | 'suggest-move' | 'suggest-accept' | 'suggest-dismiss' | 'highlight-move' | 'clear-search' | 'pick' | 'none';

/** Which thing a key does in the search field: the suggestion dropdown first, then the result list; Esc closes the dropdown before it clears the search. */
export function searchKeyAction(k: { key: string; ime: boolean; suggestOpen: boolean; searching: boolean; input: string }): SearchKeyAction {
  if (k.ime && IME_KEYS.includes(k.key)) return 'ignore';
  const arrow = k.key === 'ArrowDown' || k.key === 'ArrowUp';
  if (k.suggestOpen && arrow) return 'suggest-move';
  if (k.searching && arrow) return 'highlight-move';
  if (k.suggestOpen && (k.key === 'Enter' || k.key === 'Tab')) return 'suggest-accept';
  if (k.key === 'Escape' && k.suggestOpen) return 'suggest-dismiss';
  if (k.key === 'Escape' && k.input !== '') return 'clear-search';
  if (k.key === 'Enter' && k.searching) return 'pick';
  return 'none';
}
