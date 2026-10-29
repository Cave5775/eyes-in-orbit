import { describe, expect, it } from 'vitest';
import { NO_TAGS, acceptTag, activeTag, backspaceRemovesChip, matchesTag, parseQuery, parseToken, splitCommitted, suggestTags, type TagTarget } from '../src/lib/search-tags';

// What the tags do with a set of entities (only / hide, AND / OR, negation) is tested in query.test.ts.
const sat = (id: string, kind: string, group: string | undefined, aliases: Record<string, string> = {}, colorKey?: string, bodyId = 'EARTH'): TagTarget =>
  ({ id, kind, group, aliases, bodyId, render: colorKey ? { colorKey } : undefined });

const ISS = sat('sat-25544', 'station', 'stations', { norad: '25544', cospar: '1998-067A' }, 'station');
const STAR = sat('sat-44713', 'satellite', 'starlink', { norad: '44713', cospar: '2019-074A' }, 'starlink');
const GPS = sat('sat-24876', 'satellite', 'gps-ops', { norad: '24876', cospar: '1997-035A' }, 'navigation');
const DEB = sat('sat-33791', 'debris', 'cosmos-2251-debris', { norad: '33791', cospar: '1993-036A' }, 'debris');
const LRO = sat('dsn-LRO', 'probe', 'dsn', { dsn: 'LRO' }, undefined, 'MOON');
const MOON = sat('body-moon', 'moon', 'bodies', {}, 'body', 'EARTH');
const ALL = [ISS, STAR, GPS, DEB, LRO, MOON];
/** the entities that match the single tag `word` */
const ids = (word: string) => ALL.filter((r) => { const t = parseToken(word)!; return matchesTag(r, t.key, t.value); }).map((r) => r.id);

describe('parseToken', () => {
  it('reads key:value, #group and a leading minus, lower-casing the value', () => {
    expect(parseToken('group:Starlink')).toEqual({ key: 'group', value: 'starlink', negated: false });
    expect(parseToken('#gps-ops')).toEqual({ key: 'group', value: 'gps-ops', negated: false });
    expect(parseToken('-type:debris')).toEqual({ key: 'type', value: 'debris', negated: true });
    expect(parseToken('-#starlink')).toEqual({ key: 'group', value: 'starlink', negated: true });
  });
  it('takes the other spellings of the keys and normalises types', () => {
    expect(parseToken('type:launch-vehicle')).toEqual({ key: 'type', value: 'launch_vehicle', negated: false });
    expect(parseToken('norad:25544')).toEqual({ key: 'id', value: '25544', negated: false });
    expect(parseToken('cospar:1998-067A')).toEqual({ key: 'id', value: '1998-067a', negated: false });
    expect(parseToken('type:Satellites')?.value).toBe('satellites');
    expect(parseToken('type:satellite')?.value).toBe('satellite'); // the kind (every satellite), not the category
    expect(parseToken('type:vehicles')?.value).toBe('launch-vehicles');
    expect(parseToken('type:launch_vehicles')?.value).toBe('launch-vehicles');
    expect(parseToken('type:nav')?.value).toBe('navigation');
    expect(parseToken('type:ground-stations')?.value).toBe('ground_station');
    expect(parseToken('type:moons')?.value).toBe('moon'); // a kind before the old `cat:moon` alias for the bodies
  });
  it('gives null for plain words, unknown keys and tags without a value', () => {
    for (const w of ['starlink', 'foo:bar', 'http://x', '-foo', 'group:', '#', '-id:', '-', ':x']) expect(parseToken(w)).toBeNull();
  });
  it('knows no cat, kind or category key any more: they are plain text like any unknown key', () => {
    for (const w of ['cat:debris', 'kind:probe', '-kind:debris', 'category:nav', 'Cat:x']) expect(parseToken(w)).toBeNull();
    expect(parseQuery('kind:probe cat:debris iss')).toEqual({ text: 'kind:probe cat:debris iss', tags: NO_TAGS });
    expect(activeTag('kind:pr')).toBeNull();
    expect(splitCommitted('kind:probe ')).toEqual({ chips: [], rest: 'kind:probe ' });
  });
});

describe('parseQuery', () => {
  it('separates free text from tags, whatever their order', () => {
    const p = parseQuery('iss group:stations   zarya');
    expect(p.text).toBe('iss zarya');
    expect(p.tags).toEqual({ include: { group: ['stations'] }, exclude: {} });
  });
  it('keeps repeated values of one key (OR) and drops duplicates', () => {
    const p = parseQuery('group:gps-ops #galileo group:gps-ops type:satellite');
    expect(p.tags.include).toEqual({ group: ['gps-ops', 'galileo'], type: ['satellite'] });
  });
  it('puts negated tags in exclude', () => {
    const p = parseQuery('-type:debris -#starlink x');
    expect(p.tags).toEqual({ include: {}, exclude: { type: ['debris'], group: ['starlink'] } });
    expect(p.text).toBe('x');
  });
  it('falls back to plain text for unknown tags and leaves out a tag still being typed', () => {
    expect(parseQuery('foo:bar baz')).toEqual({ text: 'foo:bar baz', tags: NO_TAGS });
    expect(parseQuery('iss group:')).toEqual({ text: 'iss', tags: NO_TAGS });
    expect(parseQuery('#')).toEqual({ text: '', tags: NO_TAGS });
    expect(parseQuery('   ')).toEqual({ text: '', tags: NO_TAGS });
  });
  it('reads the canonical form of every spelling', () => {
    const p = parseQuery('#starlink type:probe -type:Debris launch:2024-123 type:PROBE');
    expect(p.tags).toEqual({ include: { group: ['starlink'], type: ['probe'], launch: ['2024-123'] }, exclude: { type: ['debris'] } });
  });
});

describe('matchesTag', () => {
  it('matches group, type, id, body and launch', () => {
    expect(ids('group:starlink')).toEqual(['sat-44713']);
    expect(ids('type:probe')).toEqual(['dsn-LRO']);
    expect(ids('id:25544')).toEqual(['sat-25544']);
    expect(ids('id:1998-067a')).toEqual(['sat-25544']);
    expect(ids('body:moon')).toEqual(['dsn-LRO']);
    expect(ids('body:earth')).toHaveLength(ALL.length);
    expect(ids('body:sun')).toHaveLength(ALL.length);
    expect(ids('body:mars')).toEqual([]);
    expect(ids('launch:1993-036')).toEqual(['sat-33791']);
    expect(ids('launch:1997')).toEqual(['sat-24876']);
    expect(ids('launch:199')).toEqual([]); // a year, not a prefix of digits
    expect(ids('type:navigation')).toEqual(['sat-24876']);
    expect(ids('type:satellites')).toEqual(['sat-44713', 'dsn-LRO']); // the category: the navigation satellite is in its own; LRO is an orbiter of the Moon, a satellite of it (lib/view-class.ts)
    expect(ids('type:satellite')).toEqual(['sat-44713', 'sat-24876']); // the kind
    expect(ids('type:moon')).toEqual(['body-moon']);
  });
  it('matches a group by its word prefix', () => {
    expect(ids('group:cosmos')).toEqual(['sat-33791']);
    expect(ids('group:gps')).toEqual(['sat-24876']);
    expect(ids('group:star')).toEqual([]);
  });
});

describe('typing: chips and autocomplete', () => {
  it('turns finished tag words (followed by a space) into chips and keeps the rest', () => {
    expect(splitCommitted('group:starlink ')).toEqual({ chips: ['group:starlink'], rest: '' });
    expect(splitCommitted('iss #starlink -type:debris ')).toEqual({ chips: ['group:starlink', '-type:debris'], rest: 'iss ' });
  });
  it('leaves the word being typed alone, and plain or incomplete words', () => {
    expect(splitCommitted('group:starlink')).toEqual({ chips: [], rest: 'group:starlink' });
    expect(splitCommitted('foo:bar group: ')).toEqual({ chips: [], rest: 'foo:bar group:' + ' ' });
    expect(splitCommitted('#starlink iss')).toEqual({ chips: ['group:starlink'], rest: 'iss' });
  });
  it('finds the tag word being typed', () => {
    expect(activeTag('group:st')).toEqual({ start: 0, negated: false, key: 'group', partial: 'st' });
    expect(activeTag('iss -#gp')).toEqual({ start: 4, negated: true, key: 'group', partial: 'gp' });
    expect(activeTag('type:')).toEqual({ start: 0, negated: false, key: 'type', partial: '' });
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
  it('suggests types: the categories before the kinds, however numerous the kinds are, and a typed prefix finds both', () => {
    const types = [
      { value: 'satellites', label: 'Satellites', count: 10, first: true }, { value: 'stations', label: 'Stations', count: 3, first: true },
      { value: 'debris', label: 'Debris', count: 50, first: true },
      { value: 'satellite', count: 12 }, { value: 'station', count: 3 }, { value: 'ground_station', count: 2 }, { value: 'launch_vehicle', count: 1 },
    ];
    const a = (raw: string) => suggestTags(activeTag(raw)!, types, 20).map((s) => s.value);
    expect(a('type:')).toEqual(['debris', 'satellites', 'stations', 'satellite', 'station', 'ground_station', 'launch_vehicle']);
    expect(a('type:sat')).toEqual(['satellites', 'satellite']); // `sat` is an alias for the category, but the kind is still offered
    expect(a('type:st')).toEqual(['stations', 'station', 'ground_station']);
    expect(a('-type:ground-st')).toEqual(['ground_station']);
    expect(a('type:Launch')).toEqual(['launch_vehicle']);
  });
  it('limits the list and matches on a label too', () => {
    expect(suggestTags(activeTag('#')!, groups, 2)).toHaveLength(2);
    const launches = [{ value: '1993-036', label: 'COSMOS 2251', count: 900 }];
    expect(suggestTags(activeTag('launch:cosmos')!, launches).map((s) => s.value)).toEqual(['1993-036']);
  });
  it('accepting a suggestion gives the chip word (keeping a leading minus) and the text left in the field', () => {
    expect(acceptTag('iss #sta', activeTag('iss #sta')!, 'starlink')).toEqual({ chip: 'group:starlink', rest: 'iss' });
    expect(acceptTag('-type:de', activeTag('-type:de')!, 'debris')).toEqual({ chip: '-type:debris', rest: '' });
  });
});

describe('backspaceRemovesChip (Backspace in front of the typed text removes the chip before it)', () => {
  it('removes a chip when the field is empty or the caret is collapsed at the very start', () => {
    expect(backspaceRemovesChip('', 0, 0, 2)).toBe(true);
    expect(backspaceRemovesChip('iss', 0, 0, 1)).toBe(true);
    expect(backspaceRemovesChip('', null, null, 1)).toBe(true);
  });
  it('leaves normal text deletion alone: a caret later in the text, or a selection', () => {
    expect(backspaceRemovesChip('iss', 1, 1, 2)).toBe(false);
    expect(backspaceRemovesChip('iss', 3, 3, 2)).toBe(false);
    expect(backspaceRemovesChip('iss', 0, 3, 2)).toBe(false); // selected text: Backspace deletes it
    expect(backspaceRemovesChip('iss', null, null, 2)).toBe(false);
  });
  it('does nothing without a chip', () => {
    expect(backspaceRemovesChip('', 0, 0, 0)).toBe(false);
    expect(backspaceRemovesChip('iss', 0, 0, 0)).toBe(false);
  });
});
