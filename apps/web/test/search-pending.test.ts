import { describe, expect, it } from 'vitest';
import type { EntityRecord } from '@eio/core';
import { NO_FOCUS, NO_QUERY, classify, isDrawn, termFromWord, termWord, textOf, type Query } from '../src/lib/query';
import { rankEntities, searchHitOf } from '../src/lib/filters';
import {
  afterPick, isSearching, moveHighlight, pendingQuery, pickedResult, searchRows, searchTagTerms, searchTextOf, KEEP_SEARCH_AFTER_PICK,
} from '../src/lib/search-pending';

const rec = (id: string, name: string, kind: string, group: string, bodyId = 'EARTH'): EntityRecord => ({ id, name, kind, group, aliases: {}, bodyId, updatedAt: 0 });
const CATALOG = [
  rec('a', 'STARLINK-1', 'satellite', 'starlink'),
  rec('b', 'STARLINK-2', 'debris', 'starlink'),
  rec('c', 'MRO', 'probe', 'dsn', 'MARS'),
  rec('d', 'Apollo relic', 'probe', 'dsn', 'MOON'),
];
const terms = (q: Query) => q.terms.map(termWord);

describe('the typed search', () => {
  it('reads the text and the finished tag words of the field', () => {
    expect(searchTextOf('starlink type:probe -type:debris')).toBe('starlink');
    expect(searchTagTerms('starlink type:probe -type:debris').map(termWord)).toEqual(['type:probe', '-type:debris']);
    expect(searchTagTerms('#starlink').map(termWord)).toEqual(['group:starlink']);
  });

  it('is a search only with text or a finished tag word (a half-typed tag is not one)', () => {
    expect(isSearching('')).toBe(false);
    expect(isSearching('   ')).toBe(false);
    expect(isSearching('group:')).toBe(false);
    expect(isSearching('#')).toBe(false);
    expect(isSearching('iss')).toBe(true);
    expect(isSearching('type:probe')).toBe(true);
  });
});

describe('pending query versus applied query', () => {
  it('leaves the applied query as it is and adds what is typed', () => {
    const applied: Query = { terms: [termFromWord('type:probe')!] };
    const p = pendingQuery(applied, 'mro body:mars');
    expect(terms(applied)).toEqual(['type:probe']);
    expect(terms(p)).toEqual(['type:probe', 'body:mars', 'mro']);
  });

  it('a typed text replaces the applied text, no typed text keeps it', () => {
    const applied: Query = { terms: [{ key: 'text', value: 'old', effect: 'only' }] };
    expect(textOf(pendingQuery(applied, 'new'))).toBe('new');
    expect(textOf(pendingQuery(applied, 'type:probe'))).toBe('old');
  });

  it('a typed word takes over a hidden term of the same value', () => {
    const applied: Query = { terms: [termFromWord('type:debris', 'hide')!] };
    expect(pendingQuery(applied, 'type:debris').terms.map((t) => t.effect)).toEqual(['only']);
  });

  it('an empty search is the applied query itself (what Filter would change is nothing)', () => {
    expect(pendingQuery(NO_QUERY, '')).toBe(NO_QUERY);
  });

  it('the list is evaluated through classify; tag words and negations narrow it', () => {
    const hits = rankEntities(CATALOG, 'starlink', Infinity);
    const text = new Set(hits.map((h) => h.id));
    const listed = (q: Query, t: ReadonlySet<string> | null) => (r: { id: string }) => isDrawn(classify(CATALOG.find((c) => c.id === r.id)!, q, { focus: NO_FOCUS, text: t }));
    const ordered = CATALOG.map(searchHitOf);
    const all = searchRows(ordered, hits, 'starlink', listed(pendingQuery(NO_QUERY, 'starlink'), text)).map((r) => r.id);
    expect(all).toEqual(hits.map((h) => h.id));
    expect(searchRows(ordered, hits, 'starlink', listed(pendingQuery(NO_QUERY, 'starlink -type:debris'), text)).map((r) => r.id)).toEqual(['a']);
    // tags only: the browse order, narrowed
    expect(searchRows(ordered, null, '', listed(pendingQuery(NO_QUERY, 'type:satellite body:moon'), null)).map((r) => r.id)).toEqual(['d']);
    // an applied filter still narrows the results
    const applied: Query = { terms: [termFromWord('body:mars')!] };
    expect(searchRows(ordered, null, '', listed(pendingQuery(applied, 'type:satellite'), null)).map((r) => r.id)).toEqual(['c']);
  });
});

describe('Filter applies exactly the pending query', () => {
  it('the applied result is the pending one: its terms, text last, nothing typed left over', () => {
    const applied: Query = { terms: [termFromWord('body:moon', 'hide')!] };
    const q = pendingQuery(applied, 'type:probe iss');
    expect(terms(q)).toEqual(['body:moon', 'type:probe', 'iss']);
    expect(q.terms.map((t) => t.effect)).toEqual(['hide', 'only', 'only']);
    // the field is then empty: no search, so the list is gone
    expect(isSearching('')).toBe(false);
  });
});

describe('keyboard highlight and the pick', () => {
  it('Down starts at the first and stops at the last; Up goes back to none', () => {
    expect(moveHighlight(-1, 'ArrowDown', 3)).toBe(0);
    expect(moveHighlight(0, 'ArrowDown', 3)).toBe(1);
    expect(moveHighlight(2, 'ArrowDown', 3)).toBe(2);
    expect(moveHighlight(1, 'ArrowUp', 3)).toBe(0);
    expect(moveHighlight(0, 'ArrowUp', 3)).toBe(-1);
    expect(moveHighlight(-1, 'ArrowUp', 3)).toBe(-1);
    expect(moveHighlight(5, 'ArrowDown', 3)).toBe(2); // the list shrank under the highlight
    expect(moveHighlight(0, 'ArrowDown', 0)).toBe(-1);
  });

  it('Enter takes the highlighted result, else the first, else nothing', () => {
    const rows = [{ id: 'x' }, { id: 'y' }];
    expect(pickedResult(rows, 1)).toBe('y');
    expect(pickedResult(rows, -1)).toBe('x');
    expect(pickedResult(rows, 9)).toBe('x');
    expect(pickedResult([], -1)).toBeUndefined();
  });

  it('after a pick the field is cleared (one switch to flip it)', () => {
    expect(KEEP_SEARCH_AFTER_PICK).toBe(false);
    expect(afterPick().clearField).toBe(true);
    expect(afterPick(true).clearField).toBe(false);
  });
});
