import { describe, expect, it } from 'vitest';
import type { EntityRecord } from '@eio/core';
import { NO_FOCUS, NO_QUERY, classify, isDrawn, termFromWord, termWord, textOf, type Query } from '../src/lib/query';
import { rankEntities, searchHitOf } from '../src/lib/filters';
import {
  afterPick, isImeKey, isSearching, moveHighlight, pendingQuery, pickedResult, searchKeyAction, searchRows, searchSource, searchTagTerms, searchTextOf,
  KEEP_SEARCH_AFTER_PICK,
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

  it('Enter takes the highlighted displayed row, else the best-ranked match whatever the sort', () => {
    const ranked = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    const sorted = [{ id: 'z' }, { id: 'y' }, { id: 'x' }]; // displayed by a Sort setting
    expect(pickedResult(sorted, ranked, 1)).toBe('y');
    expect(pickedResult(sorted, ranked, 0)).toBe('z');
    expect(pickedResult(sorted, ranked, -1)).toBe('x');
    expect(pickedResult(sorted, ranked, 9)).toBe('x');
    expect(pickedResult([], [], -1)).toBeUndefined();
  });

  it('after a pick the field is cleared (one switch to flip it)', () => {
    expect(KEEP_SEARCH_AFTER_PICK).toBe(false);
    expect(afterPick().clearField).toBe(true);
    expect(afterPick(true).clearField).toBe(false);
  });
});

describe('what the search list reads its text from', () => {
  const hit = (id: string) => ({ id });
  const base = { typed: '', storeText: '', searchHits: null, searchIds: null, appliedText: '', textHits: null, textIds: null };

  it('typed text uses its own lookup and is not ready until the answer for exactly that text is in', () => {
    expect(searchSource({ ...base, typed: 'moon', storeText: 'moo', searchHits: [hit('a')], searchIds: new Set(['a']) }).ready).toBe(false); // an older text's hits
    expect(searchSource({ ...base, typed: 'moon', storeText: 'moon' }).ready).toBe(false); // asked, not answered
    const s = searchSource({ ...base, typed: 'moon', storeText: 'moon', searchHits: [hit('a')], searchIds: new Set(['a']) });
    expect(s.ready).toBe(true);
    expect(s.text).toBe('moon');
  });

  it('only tag words typed: the applied text still restricts, so list, Enter and Filter agree', () => {
    const applied: Query = { terms: [{ key: 'text', value: 'moon', effect: 'only' }] };
    const textIds = new Set(['d']);
    const src = searchSource({ ...base, appliedText: 'moon', textHits: [hit('d')], textIds });
    expect(src).toMatchObject({ text: 'moon', ready: true, ids: textIds });
    const ordered = CATALOG.map(searchHitOf);
    const listed = (q: Query) => (r: { id: string }) => isDrawn(classify(CATALOG.find((c) => c.id === r.id)!, q, { focus: NO_FOCUS, text: src.ids }));
    const q = pendingQuery(applied, 'type:satellite');
    expect(textOf(q)).toBe('moon');
    expect(searchRows(ordered, src.hits as typeof ordered, src.text, listed(q)).map((r) => r.id)).toEqual(['d']); // not every satellite
  });

  it('nothing typed, nothing applied: no restriction', () => {
    expect(searchSource(base)).toMatchObject({ text: '', ready: true, hits: null, ids: null });
  });
});

describe('keys in the search field', () => {
  const k = (key: string, o: Partial<Parameters<typeof searchKeyAction>[0]> = {}) => searchKeyAction({ key, ime: false, suggestOpen: false, searching: false, input: '', ...o });

  it('the dropdown wins: arrows and Enter/Tab go to the suggestions, Esc closes it before it clears the search', () => {
    const o = { suggestOpen: true, searching: true, input: 'type:p' };
    expect(k('ArrowDown', o)).toBe('suggest-move');
    expect(k('Enter', o)).toBe('suggest-accept');
    expect(k('Tab', o)).toBe('suggest-accept');
    expect(k('Escape', o)).toBe('suggest-dismiss');
    expect(k('Escape', { suggestOpen: false, searching: true, input: 'type:p' })).toBe('clear-search');
  });

  it('with the dropdown closed the arrows move the result highlight and Enter picks', () => {
    expect(k('ArrowUp', { searching: true, input: 'x' })).toBe('highlight-move');
    expect(k('Enter', { searching: true, input: 'x' })).toBe('pick');
    expect(k('Enter')).toBe('none');
    expect(k('Escape')).toBe('none'); // an empty field: Esc is the app's (deselect)
    expect(k('Escape', { input: 'group:' })).toBe('clear-search'); // anything typed is cleared first
  });

  it('keys of an input method in progress are left alone, keyCode 229 included', () => {
    expect(isImeKey('Enter', true, 13)).toBe(true);
    expect(isImeKey('ArrowDown', false, 229)).toBe(true);
    expect(isImeKey('Escape', false, 27)).toBe(false);
    expect(isImeKey('a', true, 229)).toBe(false);
    expect(k('Tab', { ime: true, suggestOpen: true })).toBe('ignore');
    expect(k('Escape', { ime: true, input: 'x' })).toBe('ignore');
  });
});
