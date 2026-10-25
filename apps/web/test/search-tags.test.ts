import { describe, expect, it } from 'vitest';
import {
  NO_TAGS, acceptTag, activeTag, hiddenCount, hiddenTokens, isHiddenBy, matchesTags, parseHidden, parseQuery, parseToken,
  serialiseHidden, splitCommitted, suggestTags, tagTokens, tagsActive, toggleHidden, type TagTarget,
} from '../src/lib/search-tags';
import { NO_FILTERS, filtersActive, isHiddenRec, matchesFilters, sceneVisibility } from '../src/lib/filters';

const sat = (id: string, kind: string, group: string | undefined, aliases: Record<string, string> = {}, colorKey?: string, bodyId = 'EARTH'): TagTarget =>
  ({ id, kind, group, aliases, bodyId, render: colorKey ? { colorKey } : undefined });

const ISS = sat('sat-25544', 'station', 'stations', { norad: '25544', cospar: '1998-067A' }, 'station');
const STAR = sat('sat-44713', 'satellite', 'starlink', { norad: '44713', cospar: '2019-074A' }, 'starlink');
const GPS = sat('sat-24876', 'satellite', 'gps-ops', { norad: '24876', cospar: '1997-035A' }, 'navigation');
const DEB = sat('sat-33791', 'debris', 'cosmos-2251-debris', { norad: '33791', cospar: '1993-036A' }, 'debris');
const LRO = sat('dsn-LRO', 'probe', 'dsn', { dsn: 'LRO' }, undefined, 'MOON');
const MOON = sat('body-moon', 'moon', 'bodies', {}, 'body', 'EARTH');
const ALL = [ISS, STAR, GPS, DEB, LRO, MOON];
const ids = (f: ReturnType<typeof parseQuery>['tags']) => ALL.filter((r) => matchesTags(r, f)).map((r) => r.id);

describe('parseToken', () => {
  it('reads key:value, #group and a leading minus, lower-casing the value', () => {
    expect(parseToken('group:Starlink')).toEqual({ key: 'group', value: 'starlink', negated: false });
    expect(parseToken('#gps-ops')).toEqual({ key: 'group', value: 'gps-ops', negated: false });
    expect(parseToken('-kind:debris')).toEqual({ key: 'kind', value: 'debris', negated: true });
    expect(parseToken('-#starlink')).toEqual({ key: 'group', value: 'starlink', negated: true });
  });
  it('takes the other spellings of the keys and normalises kinds and categories', () => {
    expect(parseToken('type:launch-vehicle')).toEqual({ key: 'kind', value: 'launch_vehicle', negated: false });
    expect(parseToken('norad:25544')).toEqual({ key: 'id', value: '25544', negated: false });
    expect(parseToken('cat:satellite')?.value).toBe('satellites');
    expect(parseToken('cat:vehicles')?.value).toBe('launch-vehicles');
    expect(parseToken('category:nav')).toEqual({ key: 'cat', value: 'navigation', negated: false });
  });
  it('gives null for plain words, unknown keys and tags without a value', () => {
    for (const w of ['starlink', 'foo:bar', 'http://x', '-foo', 'group:', '#', '-id:', '-', ':x']) expect(parseToken(w)).toBeNull();
  });
});

describe('parseQuery', () => {
  it('separates free text from tags, whatever their order', () => {
    const p = parseQuery('iss group:stations   zarya');
    expect(p.text).toBe('iss zarya');
    expect(p.tags).toEqual({ include: { group: ['stations'] }, exclude: {} });
  });
  it('keeps repeated values of one key (OR) and drops duplicates', () => {
    const p = parseQuery('group:gps-ops #galileo group:gps-ops kind:satellite');
    expect(p.tags.include).toEqual({ group: ['gps-ops', 'galileo'], kind: ['satellite'] });
  });
  it('puts negated tags in exclude', () => {
    const p = parseQuery('-kind:debris -#starlink x');
    expect(p.tags).toEqual({ include: {}, exclude: { kind: ['debris'], group: ['starlink'] } });
    expect(p.text).toBe('x');
  });
  it('falls back to plain text for unknown tags and leaves out a tag still being typed', () => {
    expect(parseQuery('foo:bar baz')).toEqual({ text: 'foo:bar baz', tags: NO_TAGS });
    expect(parseQuery('iss group:')).toEqual({ text: 'iss', tags: NO_TAGS });
    expect(parseQuery('#')).toEqual({ text: '', tags: NO_TAGS });
    expect(parseQuery('   ')).toEqual({ text: '', tags: NO_TAGS });
  });
  it('round-trips through the canonical words', () => {
    const p = parseQuery('#starlink type:probe -cat:debris launch:2024-123');
    expect(tagTokens(p.tags)).toEqual(['kind:probe', 'group:starlink', 'launch:2024-123', '-cat:debris']);
    expect(parseQuery(tagTokens(p.tags).join(' ')).tags).toEqual(p.tags);
  });
});

describe('matchesTags', () => {
  it('matches group, kind, id, body, launch and category', () => {
    expect(ids(parseQuery('group:starlink').tags)).toEqual(['sat-44713']);
    expect(ids(parseQuery('kind:probe').tags)).toEqual(['dsn-LRO']);
    expect(ids(parseQuery('id:25544').tags)).toEqual(['sat-25544']);
    expect(ids(parseQuery('id:1998-067a').tags)).toEqual(['sat-25544']);
    expect(ids(parseQuery('body:moon').tags)).toEqual(['dsn-LRO']);
    expect(ids(parseQuery('body:earth').tags)).toEqual(ids(NO_TAGS));
    expect(ids(parseQuery('body:sun').tags)).toEqual(ids(NO_TAGS));
    expect(ids(parseQuery('body:mars').tags)).toEqual([]);
    expect(ids(parseQuery('launch:1993-036').tags)).toEqual(['sat-33791']);
    expect(ids(parseQuery('launch:1997').tags)).toEqual(['sat-24876']);
    expect(ids(parseQuery('cat:navigation').tags)).toEqual(['sat-24876']);
  });
  it('matches a group by its word prefix', () => {
    expect(ids(parseQuery('group:cosmos').tags)).toEqual(['sat-33791']);
    expect(ids(parseQuery('group:gps').tags)).toEqual(['sat-24876']);
    expect(ids(parseQuery('group:star').tags)).toEqual([]);
  });
  it('ANDs different keys and ORs the values of one key', () => {
    expect(ids(parseQuery('group:starlink group:gps-ops').tags)).toEqual(['sat-44713', 'sat-24876']);
    expect(ids(parseQuery('kind:satellite group:gps-ops').tags)).toEqual(['sat-24876']);
    expect(ids(parseQuery('kind:station group:gps-ops').tags)).toEqual([]);
  });
  it('negation removes matches, alone or with an inclusion', () => {
    expect(ids(parseQuery('-kind:satellite').tags)).toEqual(['sat-25544', 'sat-33791', 'dsn-LRO', 'body-moon']);
    expect(ids(parseQuery('kind:satellite -group:starlink').tags)).toEqual(['sat-24876']);
    expect(ids(parseQuery('-group:starlink -group:gps-ops -kind:debris').tags)).toEqual(['sat-25544', 'dsn-LRO', 'body-moon']);
  });
  it('no tags matches everything', () => {
    expect(ids(NO_TAGS)).toHaveLength(ALL.length);
    expect(tagsActive(NO_TAGS)).toBe(false);
    expect(tagsActive(parseQuery('x').tags)).toBe(false);
    expect(tagsActive(parseQuery('-id:7').tags)).toBe(true);
  });
});

describe('filters with tags', () => {
  it('matchesFilters and sceneVisibility use the tags, filtersActive counts them', () => {
    const f = { ...NO_FILTERS, tags: parseQuery('group:starlink').tags };
    expect(filtersActive(f)).toBe(true);
    expect(matchesFilters(STAR, f)).toBe(true);
    expect(matchesFilters(GPS, f)).toBe(false);
    expect(sceneVisibility(STAR, f)).toBe('show');
    expect(sceneVisibility(GPS, f)).toBe('hide');
  });
});

describe('hidden groups', () => {
  const hidden = parseQuery('cat:debris').tags.include;
  it('hides the entities of a hidden category or tag, not the others', () => {
    expect(isHiddenBy(DEB, hidden)).toBe(true);
    expect(isHiddenBy(STAR, hidden)).toBe(false);
    const h2 = toggleHidden(hidden, 'group', 'starlink');
    expect(isHiddenBy(STAR, h2)).toBe(true);
    expect(isHiddenBy(GPS, h2)).toBe(false);
    expect(hiddenCount(h2)).toBe(2);
    expect(hiddenTokens(h2)).toEqual(['group:starlink', 'cat:debris']);
  });
  it('is an OR across keys', () => {
    const h = { kind: ['station'], body: ['moon'] };
    expect(ALL.filter((r) => isHiddenBy(r, h)).map((r) => r.id)).toEqual(['sat-25544', 'dsn-LRO']);
  });
  it('never hides the bodies, which are scenery', () => {
    expect(isHiddenBy(MOON, { cat: ['bodies'], kind: ['moon'], group: ['bodies'], body: ['earth'] })).toBe(false);
  });
  it('toggles on and off, returning the same object when nothing changes', () => {
    const on = toggleHidden({}, 'cat', 'debris');
    expect(on).toEqual({ cat: ['debris'] });
    expect(toggleHidden(on, 'cat', 'debris')).toEqual({});
    expect(toggleHidden(on, 'cat', 'debris', true)).toBe(on);
    expect(toggleHidden({}, 'cat', 'debris', false)).toEqual({});
  });
  it('is not a filter: the list keeps the entities, the scene hides them unless they are selected', () => {
    const f = { ...NO_FILTERS, hidden };
    expect(filtersActive(f)).toBe(false);
    expect(matchesFilters(DEB, f)).toBe(true);
    expect(isHiddenRec(DEB, f)).toBe(true);
    expect(sceneVisibility(DEB, f)).toBe('hide');
    expect(sceneVisibility(DEB, f, true)).toBe('show');
    expect(sceneVisibility(STAR, f)).toBe('show');
  });
  it('composes with a kind filter: both must let the entity through', () => {
    const f = { ...NO_FILTERS, kinds: new Set(['satellite']), hidden: { group: ['starlink'] } };
    expect(sceneVisibility(GPS, f)).toBe('show');
    expect(sceneVisibility(STAR, f)).toBe('hide');
    expect(sceneVisibility(DEB, f)).toBe('hide');
  });
  it('round-trips through its stored form and survives garbage', () => {
    const h = { cat: ['debris', 'ground'], group: ['starlink'] };
    expect(parseHidden(serialiseHidden(h))).toEqual(h);
    expect(serialiseHidden({})).toBe('{}');
    for (const raw of [null, undefined, '', 'nope', '[]', '42', 'null', '{"cat":"debris"}', '{"cat":[1,null,""]}', '{"zzz":["a"]}']) {
      expect(parseHidden(raw as string | null | undefined)).toEqual({});
    }
    expect(parseHidden('{"cat":["debris",7,"debris"],"kind":["Launch-Vehicle"],"x":["y"]}')).toEqual({ cat: ['debris'], kind: ['launch_vehicle'] });
  });
});

describe('typing: chips and autocomplete', () => {
  it('turns finished tag words (followed by a space) into chips and keeps the rest', () => {
    expect(splitCommitted('group:starlink ')).toEqual({ chips: ['group:starlink'], rest: '' });
    expect(splitCommitted('iss #starlink -kind:debris ')).toEqual({ chips: ['group:starlink', '-kind:debris'], rest: 'iss ' });
  });
  it('leaves the word being typed alone, and plain or incomplete words', () => {
    expect(splitCommitted('group:starlink')).toEqual({ chips: [], rest: 'group:starlink' });
    expect(splitCommitted('foo:bar group: ')).toEqual({ chips: [], rest: 'foo:bar group:' + ' ' });
    expect(splitCommitted('#starlink iss')).toEqual({ chips: ['group:starlink'], rest: 'iss' });
  });
  it('finds the tag word being typed', () => {
    expect(activeTag('group:st')).toEqual({ start: 0, negated: false, key: 'group', partial: 'st' });
    expect(activeTag('iss -#gp')).toEqual({ start: 4, negated: true, key: 'group', partial: 'gp' });
    expect(activeTag('kind:')).toEqual({ start: 0, negated: false, key: 'kind', partial: '' });
    for (const raw of ['', 'iss', 'gro', 'foo:b', 'group:st ']) expect(activeTag(raw)).toBeNull();
  });
  const groups = [
    { value: 'starlink', count: 6000 }, { value: 'stations', count: 3 }, { value: 'gps-ops', count: 31 },
    { value: 'cosmos-2251-debris', count: 900 }, { value: 'active', count: 4000 },
  ];
  it('suggests by prefix, then word prefix, then substring, most numerous first', () => {
    const a = (raw: string) => suggestTags(activeTag(raw)!, groups).map((s) => s.value);
    expect(a('#st')).toEqual(['starlink', 'stations']);
    expect(a('group:ops')).toEqual(['gps-ops']);
    expect(a('group:debris')).toEqual(['cosmos-2251-debris']);
    expect(a('group:tiv')).toEqual(['active']);
    expect(a('group:zzz')).toEqual([]);
    expect(a('group:')).toEqual(['starlink', 'active', 'cosmos-2251-debris', 'gps-ops', 'stations']);
  });
  it('limits the list and matches on a label too', () => {
    expect(suggestTags(activeTag('#')!, groups, 2)).toHaveLength(2);
    const launches = [{ value: '1993-036', label: 'COSMOS 2251', count: 900 }];
    expect(suggestTags(activeTag('launch:cosmos')!, launches).map((s) => s.value)).toEqual(['1993-036']);
  });
  it('accepting a suggestion gives the chip word (keeping a leading minus) and the text left in the field', () => {
    expect(acceptTag('iss #sta', activeTag('iss #sta')!, 'starlink')).toEqual({ chip: 'group:starlink', rest: 'iss' });
    expect(acceptTag('-kind:de', activeTag('-kind:de')!, 'debris')).toEqual({ chip: '-kind:debris', rest: '' });
  });
});
