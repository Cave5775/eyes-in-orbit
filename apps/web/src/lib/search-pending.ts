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

/** The result Enter takes: the highlighted one, else the first (undefined when there is none). */
export const pickedResult = <T extends { id: string }>(rows: readonly T[], highlight: number): string | undefined => (rows[highlight] ?? rows[0])?.id;
