import { describe, expect, it } from 'vitest';
import {
  NO_FOCUS, NO_QUERY, addTerms, classify, filterRecords, findTerm, hasHide, isDrawn, legacyHiddenTerms, parseStoredQuery, queryActive,
  removeTerm, sameQuery, serialiseQuery, setTermEffect, tagTerms, termFromWord, termWord, textOf, toggleTerm, withText, withoutFilter,
  withoutHidden, type Class, type Effect, type Query, type Term,
} from '../src/lib/query';
import type { TagTarget } from '../src/lib/search-tags';

const sat = (id: string, kind: string, group: string | undefined, aliases: Record<string, string> = {}, colorKey?: string, bodyId = 'EARTH'): TagTarget =>
  ({ id, kind, group, aliases, bodyId, render: colorKey ? { colorKey } : undefined });

const ISS = sat('sat-25544', 'station', 'stations', { norad: '25544', cospar: '1998-067A' }, 'station');
const STAR = sat('sat-44713', 'satellite', 'starlink', { norad: '44713', cospar: '2019-074A' }, 'starlink');
const GPS = sat('sat-24876', 'satellite', 'gps-ops', { norad: '24876', cospar: '1997-035A' }, 'navigation');
const DEB = sat('sat-33791', 'debris', 'cosmos-2251-debris', { norad: '33791', cospar: '1993-036A' }, 'debris');
const DEB2 = sat('sat-33792', 'debris', 'cosmos-2251-debris', { norad: '33792', cospar: '1993-036B' }, 'debris');
const LRO = sat('dsn-LRO', 'probe', 'dsn', { dsn: 'LRO' }, undefined, 'MOON');
const MOON = sat('body-moon', 'moon', 'bodies', {}, 'body', 'EARTH');
const ALL = [ISS, STAR, GPS, DEB, DEB2, LRO, MOON];

/** a query from tag words; `effect` for all of them */
const q = (words: string, effect: Effect = 'only'): Query => ({
  terms: words.split(/\s+/).filter(Boolean).map((w) => termFromWord(w, effect)!),
});
const ids = (query: Query, ctx = { focus: NO_FOCUS } as Parameters<typeof classify>[2]) => ALL.filter((r) => isDrawn(classify(r, query, ctx))).map((r) => r.id);

describe('classify: only terms', () => {
  it('matches group, kind, id, body, launch and category', () => {
    expect(ids(q('group:starlink'))).toEqual(['sat-44713']);
    expect(ids(q('type:probe'))).toEqual(['dsn-LRO']);
    expect(ids(q('id:25544'))).toEqual(['sat-25544']);
    expect(ids(q('body:moon'))).toEqual(['dsn-LRO']);
    expect(ids(q('launch:1993'))).toEqual(['sat-33791', 'sat-33792']);
    expect(ids(q('launch:1993-036'))).toEqual(['sat-33791', 'sat-33792']);
    expect(ids(q('type:navigation'))).toEqual(['sat-24876']);
  });
  it('ANDs different keys and ORs the values of one key', () => {
    expect(ids(q('group:starlink group:gps-ops'))).toEqual(['sat-44713', 'sat-24876']);
    expect(ids(q('type:satellite group:gps-ops'))).toEqual(['sat-24876']);
    expect(ids(q('type:station group:gps-ops'))).toEqual([]);
  });
  it('negation removes matches, alone or with an inclusion', () => {
    expect(ids(q('-type:satellite'))).toEqual(['sat-25544', 'sat-33791', 'sat-33792', 'dsn-LRO', 'body-moon']);
    expect(ids(q('type:satellite -group:starlink'))).toEqual(['sat-24876']);
    expect(ids(q('-group:starlink -group:gps-ops -type:debris'))).toEqual(['sat-25544', 'dsn-LRO', 'body-moon']);
  });
  it('is off without terms, and a negation alone is a restriction', () => {
    expect(ALL.map((r) => classify(r, NO_QUERY))).toEqual(ALL.map(() => 'off'));
    expect(queryActive(NO_QUERY)).toBe(false);
    expect(queryActive(q('-id:7'))).toBe(true);
    expect(classify(STAR, q('group:starlink'))).toBe('show');
    expect(classify(GPS, q('group:starlink'))).toBe('out');
  });
});

describe('classify: the typed text', () => {
  const text = withText(NO_QUERY, 'sat');
  const ctx = { focus: NO_FOCUS, text: new Set(['sat-44713', 'sat-24876']) };
  it('lets through the ids the text matched, and ANDs with the tags', () => {
    expect(ids(text, ctx)).toEqual(['sat-44713', 'sat-24876']);
    expect(ids(withText(q('group:starlink'), 'sat'), ctx)).toEqual(['sat-44713']);
    expect(classify(ISS, text, ctx)).toBe('out');
  });
  it('restricts nothing until the text has been looked up', () => {
    expect(ids(text)).toHaveLength(ALL.length);
    expect(ids(text, { focus: NO_FOCUS, text: null })).toHaveLength(ALL.length);
    expect(queryActive(text)).toBe(true);
  });
  it('an empty or blank text is no term', () => {
    expect(withText(NO_QUERY, '  ')).toBe(NO_QUERY);
    expect(withText(text, '')).toEqual(NO_QUERY);
    expect(textOf(withText(q('type:probe'), ' iss zarya '))).toBe('iss zarya');
  });
});

describe('classify: hide terms', () => {
  it('hide the entities of a category or tag, not the others; they are not filters', () => {
    const h = q('type:debris', 'hide');
    expect(classify(DEB, h)).toBe('hide');
    expect(classify(STAR, h)).toBe('off');
    expect(queryActive(h)).toBe(false);
    expect(hasHide(h)).toBe(true);
    expect(ids(h)).toEqual(['sat-25544', 'sat-44713', 'sat-24876', 'dsn-LRO', 'body-moon']);
  });
  it('OR together, across keys', () => {
    expect(ids(q('type:station body:moon', 'hide'))).toEqual(['sat-44713', 'sat-24876', 'sat-33791', 'sat-33792', 'body-moon']);
    expect(ids(q('group:starlink type:debris', 'hide'))).toEqual(['sat-25544', 'sat-24876', 'dsn-LRO', 'body-moon']);
  });
  it('never hide the bodies, which are scenery', () => {
    expect(classify(MOON, q('type:bodies type:moon group:bodies body:earth', 'hide'))).toBe('off');
  });
  it('compose with only terms: both must let the entity through, and hide says so over out', () => {
    const query: Query = { terms: [...q('type:satellite').terms, ...q('group:starlink', 'hide').terms] };
    expect(classify(GPS, query)).toBe('show');
    expect(classify(STAR, query)).toBe('hide');
    expect(classify(DEB, query)).toBe('out');
    expect(ids(query)).toEqual(['sat-24876']);
  });
  it('hide terms hide the objects of every category the same way the list counts them', () => {
    const rows = filterRecords(ALL, q('type:debris', 'hide'));
    expect(rows.map((r) => r.id)).not.toContain('sat-33791');
    expect(rows).toHaveLength(ALL.length - 2);
  });
});

describe('classify: the focus', () => {
  const focus = new Set(['sat-33791', 'sat-25544']);
  it('is never hidden by a hide term, nor left out by an only term', () => {
    expect(classify(DEB, q('type:debris', 'hide'), { focus })).toBe('off');
    expect(classify(DEB, q('type:debris type:stations', 'hide'), { focus })).toBe('off');
    expect(classify(DEB2, q('type:debris', 'hide'), { focus })).toBe('hide');
    expect(classify(DEB, q('group:starlink'), { focus })).toBe('show');
    expect(classify(DEB2, q('group:starlink'), { focus })).toBe('out');
    expect(classify(ISS, withText(NO_QUERY, 'zzz'), { focus, text: new Set() })).toBe('show');
  });
});

describe('terms', () => {
  it('reads the words of a term back', () => {
    expect(termFromWord('#starlink')).toEqual({ key: 'group', value: 'starlink', effect: 'only' });
    expect(termFromWord('-type:debris', 'hide')).toEqual({ key: 'type', value: 'debris', neg: true, effect: 'hide' });
    expect(termFromWord('plain')).toBeNull();
    expect(termWord(termFromWord('-type:launch-vehicle')!)).toBe('-type:launch_vehicle');
    expect(termWord({ key: 'text', value: 'iss', effect: 'only' })).toBe('iss');
  });
  it('toggleTerm adds, removes and switches the effect', () => {
    const a = toggleTerm(NO_QUERY, 'type', 'debris', 'hide');
    expect(a.terms).toEqual([{ key: 'type', value: 'debris', effect: 'hide' }]);
    expect(toggleTerm(a, 'type', 'debris', 'hide')).toEqual(NO_QUERY);
    expect(toggleTerm(a, 'type', 'debris', 'only').terms[0].effect).toBe('only');
    expect(toggleTerm(toggleTerm(a, 'type', 'debris', 'only'), 'type', 'debris').terms).toEqual([]); // default effect is only
    expect(toggleTerm(a, 'type', 'debris', 'hide', true).terms).toHaveLength(2); // the negated term is another term
  });
  it('setTermEffect and removeTerm change one term and return the same query when nothing changes', () => {
    const a = q('type:probe type:debris');
    const b = setTermEffect(a, 'type', 'probe', 'hide');
    expect(findTerm(b, 'type', 'probe')?.effect).toBe('hide');
    expect(findTerm(b, 'type', 'debris')?.effect).toBe('only');
    expect(setTermEffect(a, 'type', 'probe', 'only')).toBe(a);
    expect(setTermEffect(a, 'type', 'nope', 'hide')).toBe(a);
    expect(removeTerm(a, 'type', 'nope')).toBe(a);
    expect(removeTerm(a, 'type', 'probe').terms.map(termWord)).toEqual(['type:debris']);
  });
  it('addTerms keeps the text last, skips terms that are there and with override takes the new effect', () => {
    const a = withText(q('type:probe'), 'iss');
    const b = addTerms(a, [termFromWord('type:debris')!]);
    expect(b.terms.map(termWord)).toEqual(['type:probe', 'type:debris', 'iss']);
    expect(addTerms(b, [termFromWord('type:debris')!])).toBe(b);
    const h = q('type:debris', 'hide');
    expect(addTerms(h, [termFromWord('type:debris')!])).toBe(h);
    expect(findTerm(addTerms(h, [termFromWord('type:debris')!], true), 'type', 'debris')?.effect).toBe('only');
  });
  it('SHOW ALL and CLEAR each leave the other kind of term', () => {
    const query: Query = withText({ terms: [...q('type:probe').terms, ...q('type:debris', 'hide').terms] }, 'iss');
    expect(withoutHidden(query).terms.map(termWord)).toEqual(['type:probe', 'iss']);
    expect(withoutFilter(query).terms.map(termWord)).toEqual(['type:debris']);
    expect(withoutHidden(NO_QUERY)).toBe(NO_QUERY);
    expect(withoutFilter(q('type:debris', 'hide'))).toEqual(q('type:debris', 'hide'));
    expect(tagTerms(query)).toHaveLength(2);
  });
  it('compares queries by their terms', () => {
    expect(sameQuery(q('type:probe'), q('type:probe'))).toBe(true);
    expect(sameQuery(q('type:probe'), q('type:probe', 'hide'))).toBe(false);
    expect(sameQuery(q('type:probe'), q('-type:probe'))).toBe(false);
    expect(sameQuery(NO_QUERY, { terms: [] })).toBe(true);
  });
});

describe('storage', () => {
  const query: Query = withText({ terms: [...q('type:probe -group:starlink').terms, ...q('type:debris', 'hide').terms] }, 'iss');
  it('round-trips the tag terms with their effects, not the text', () => {
    const back = parseStoredQuery(serialiseQuery(query));
    expect(back.terms.map((t: Term) => `${termWord(t)}/${t.effect}`)).toEqual(['type:probe/only', '-group:starlink/only', 'type:debris/hide']);
    expect(serialiseQuery(NO_QUERY)).toBe('{"terms":[]}');
  });
  it('survives garbage and drops bad terms', () => {
    for (const raw of [null, undefined, '', 'nope', '[]', '42', 'null', '{}', '{"terms":"x"}', '{"terms":[1,null,{"key":"zzz","value":"a","effect":"only"}]}']) {
      expect(parseStoredQuery(raw as string | null | undefined)).toEqual(NO_QUERY);
    }
    const raw = '{"terms":[{"key":"type","value":"Satellite","effect":"only"},{"key":"type","value":"satellites","effect":"hide"},{"key":"type","value":"Launch-Vehicle","effect":"hide"},{"key":"type","value":"x","effect":"dim"}]}';
    expect(parseStoredQuery(raw).terms).toEqual([
      { key: 'type', value: 'satellite', effect: 'only' },
      { key: 'type', value: 'satellites', effect: 'hide' },
      { key: 'type', value: 'launch_vehicle', effect: 'hide' },
    ]);
  });
  it('migrates the stored cat and kind terms to type terms: deduplicated, effect and negation kept', () => {
    const term = (key: unknown, value: unknown, effect: unknown, neg?: boolean) => ({ key, value, effect, ...(neg ? { neg: true } : {}) });
    const raw = JSON.stringify({
      terms: [
        term('cat', 'debris', 'hide'), //                  -> type:debris (hide)
        term('cat', 'Satellite', 'only'), //               the category it named -> type:satellites
        term('cat', 'vehicles', 'only', true), //          alias, negated -> -type:launch-vehicles
        term('kind', 'Launch-Vehicle', 'hide'), //         -> type:launch_vehicle
        term('kind', 'debris', 'hide'), //                 same as the cat:debris term: dropped
        term('kind', 'probe', 'only'),
        term('kind', 'probe', 'only', true), //            a negated term is another term
        term('cat', 'satellites', 'hide'), //              the same word as above (the effect does not matter): dropped
        term('group', 'starlink', 'only'),
        term('cat', '', 'only'), term('kind', 7, 'only'), term('kind', 'x', 'dim'), term('categ', 'x', 'only'), //  garbage
        null, 3, 'cat:debris',
      ],
    });
    expect(parseStoredQuery(raw).terms.map((t: Term) => `${termWord(t)}/${t.effect}`)).toEqual([
      'type:debris/hide', 'type:satellites/only', '-type:launch-vehicles/only', 'type:launch_vehicle/hide', 'type:probe/only', '-type:probe/only', 'group:starlink/only',
    ]);
    // once migrated, the stored form has no cat or kind left and reads back the same
    const again = serialiseQuery(parseStoredQuery(raw));
    expect(again).not.toMatch(/"(cat|kind)"/);
    expect(serialiseQuery(parseStoredQuery(again))).toBe(again);
    // a stored query of nothing but garbage terms is the empty query
    expect(parseStoredQuery('{"terms":[{"key":"cat","value":[],"effect":"only"},{"key":"kind"}]}')).toEqual(NO_QUERY);
  });
  it('reads the old hidden groups as hide terms', () => {
    const t = legacyHiddenTerms('{"cat":["debris","ground"],"group":["starlink"],"x":["y"]}');
    expect(t.map((x) => `${termWord(x)}/${x.effect}`)).toEqual(['type:debris/hide', 'type:ground/hide', 'group:starlink/hide']);
    expect(legacyHiddenTerms('{"cat":["debris",7,"debris"],"kind":["Launch-Vehicle","debris"]}').map(termWord)).toEqual(['type:debris', 'type:launch_vehicle']);
    for (const raw of [null, undefined, '', 'nope', '[]', '42', 'null', '{"cat":"debris"}', '{"cat":[1,null,""]}', '{"zzz":["a"]}']) {
      expect(legacyHiddenTerms(raw as string | null | undefined)).toEqual([]);
    }
  });
});

describe('classes are the four documented values', () => {
  it('off, show, out, hide', () => {
    const seen = new Set<Class>();
    for (const r of ALL) for (const query of [NO_QUERY, q('type:probe'), q('type:probe', 'hide')]) seen.add(classify(r, query));
    expect([...seen].sort()).toEqual(['hide', 'off', 'out', 'show']);
  });
});
