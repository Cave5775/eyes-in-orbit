import { describe, expect, it } from 'vitest';
import { bodyEntityRecords, type EntityRecord } from '@eio/core';
import {
  CATEGORIES, KNOWN_KINDS, bodyFacts, categoryCounts, categoryOf, emptyHint, matchesType, normaliseType,
} from '../src/lib/browser-ui';
import { mockBodies, mockGroundAndProbes, mockLaunches, mockSatellites } from '../src/mock/generators';
import { EARTH_CENTRE } from '../src/lib/frame';
import { frameOnSelect, loadFrame, parseFrame, resolveFrame, saveFrame, serialiseFrame } from '../src/lib/frame-store';

const bodies = bodyEntityRecords();
const byId = (id: string): EntityRecord => bodies.find((b) => b.id === id)!;
const sat = (id: string): EntityRecord => ({ id, name: id, kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0 });

describe('frameOnSelect', () => {
  it('an orbitable entity (a body entity) is its own frame, unless the frame is locked', () => {
    expect(frameOnSelect(byId('body-moon'), false)).toBe('body-moon');
    expect(frameOnSelect(byId('body-mars'), false)).toBe('body-mars');
    expect(frameOnSelect(byId('body-earth'), true)).toBeNull();
  });
  it('an ordinary object or nothing gives null; an entity flagged attrs.orbitable is its own frame', () => {
    expect(frameOnSelect(sat('iss'), false)).toBeNull();
    expect(frameOnSelect(undefined, false)).toBeNull();
    expect(frameOnSelect({ ...sat('ceres'), attrs: { orbitable: false } }, false)).toBeNull();
    expect(frameOnSelect({ ...sat('ceres'), attrs: { orbitable: true } }, false)).toBe('ceres');
    expect(frameOnSelect({ ...sat('ceres'), attrs: { orbitable: true } }, true)).toBeNull();
  });
});

describe('frame persistence helpers', () => {
  it('round-trips a body entity and another entity', () => {
    for (const c of [EARTH_CENTRE, 'body-mars', 'sat-25544']) expect(parseFrame(serialiseFrame(c))).toEqual(c);
  });
  it('migrates the previous format: a body by registry id becomes its body entity, an entity stays', () => {
    expect(parseFrame('{"kind":"body","id":"MARS"}')).toBe('body-mars');
    expect(parseFrame('{"kind":"body","id":"EARTH"}')).toBe(EARTH_CENTRE);
    expect(parseFrame('{"kind":"body","id":"MOON","locked":true}')).toBe('body-moon');
    expect(parseFrame('{"kind":"entity","id":"sat-25544"}')).toBe('sat-25544');
    expect(parseFrame('{"kind":"entity","id":"body-moon"}')).toBe('body-moon');
  });
  it('writes a shape the previous loader reads: {"kind":"entity","id":...}', () => {
    expect(serialiseFrame('body-moon')).toBe('{"kind":"entity","id":"body-moon"}');
  });
  it('parses anything malformed to null', () => {
    for (const raw of [null, undefined, '', 'nope', '[]', 'null', '42', '{}', '{"kind":"body"}', '{"kind":"x","id":"EARTH"}', '{"kind":"body","id":""}', '{"kind":"body","id":7}']) {
      expect(parseFrame(raw as string | null | undefined)).toBeNull();
    }
  });
  it('resolves a stored frame against the catalog, falling back to the Earth when stale', () => {
    const cat = new Map<string, EntityRecord>([['iss', sat('iss')], ...bodies.map((b) => [b.id, b] as [string, EntityRecord])]);
    const look = (id: string) => cat.get(id);
    expect(resolveFrame('body-moon', look)).toBe('body-moon');
    expect(resolveFrame(parseFrame('{"kind":"body","id":"MARS"}'), look)).toBe('body-mars');
    expect(resolveFrame(parseFrame('{"kind":"body","id":"XENA"}'), look)).toBe(EARTH_CENTRE);
    expect(resolveFrame('iss', look)).toBe('iss');
    expect(resolveFrame('removed', look)).toBe(EARTH_CENTRE);
    expect(resolveFrame(null, look)).toBe(EARTH_CENTRE);
  });
  it('loads and saves through a storage, tolerating failures', () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(loadFrame(store)).toBeNull();
    expect(saveFrame('body-sun', store)).toBe(true);
    expect(data.get('eio.frame')).toBe('{"kind":"entity","id":"body-sun"}');
    expect(loadFrame(store)).toBe('body-sun');
    // a value written by the previous build still loads
    data.set('eio.frame', '{"kind":"body","id":"MOON"}');
    expect(loadFrame(store)).toBe('body-moon');
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('y'); } };
    expect(loadFrame(bad)).toBeNull();
    expect(saveFrame(EARTH_CENTRE, bad)).toBe(false);
    expect(saveFrame(EARTH_CENTRE, null)).toBe(false);
  });
});

describe('bodyFacts', () => {
  it('lists radius, gm, period around the parent, parent and approx for the Moon', () => {
    const f = bodyFacts(byId('body-moon'));
    expect(f.map((x) => x.label)).toEqual(['Radius', 'GM', 'Orbital period around Earth', 'Parent', 'Approximate']);
    expect(f[0].value).toBe('1,737 km');
    expect(f[2].value).toMatch(/^27\.\d d$/);
    expect(f[3].value).toBe('Earth');
  });
  it('the Sun has no period and no parent', () => {
    const f = bodyFacts(byId('body-sun'));
    expect(f.map((x) => x.label)).toEqual(['Radius', 'GM', 'Approximate']);
  });
});

describe('emptyHint', () => {
  it('names the places an object can be selected, not the DSN panel (it moved to the Data streams popup)', () => {
    expect(emptyHint()).toMatch(/globe.*entity list.*launch board/);
    expect(emptyHint()).not.toMatch(/DSN/);
  });
});

describe('categoryOf', () => {
  const c = (kind: string, group?: string, colorKey?: string) => categoryOf({ kind, group, render: colorKey ? { colorKey } : undefined });
  it('maps the kinds to the general categories', () => {
    expect(c('satellite', 'active')).toBe('satellites');
    expect(c('satellite', 'starlink', 'starlink')).toBe('satellites');
    expect(c('satellite', 'amateur')).toBe('satellites');
    expect(c('station', 'stations', 'station')).toBe('stations');
    expect(c('probe', 'dsn')).toBe('probes');
    expect(c('rover')).toBe('probes');
    expect(c('lander')).toBe('probes');
    expect(c('launch_vehicle', 'launch', 'vehicle')).toBe('launch-vehicles');
    expect(c('stage', 'launch', 'vehicle')).toBe('launch-vehicles');
    expect(c('capsule')).toBe('launch-vehicles');
    expect(c('debris', 'cosmos-2251-debris', 'debris')).toBe('debris');
    expect(c('ground_station', 'dsn')).toBe('ground');
    expect(c('pad')).toBe('ground');
    expect(c('star')).toBe('bodies');
    expect(c('planet', 'bodies')).toBe('bodies');
    expect(c('moon', 'bodies', 'body')).toBe('bodies');
  });
  it('navigation comes from the colour key or a GNSS group', () => {
    expect(c('satellite', 'gps-ops', 'navigation')).toBe('navigation');
    for (const g of ['gps-ops', 'glo-ops', 'galileo', 'beidou']) expect(c('satellite', g)).toBe('navigation');
  });
  it('the colour key decides for an unknown kind, anything else is other', () => {
    expect(c('widget', undefined, 'probe')).toBe('probes');
    expect(c('widget', undefined, 'debris')).toBe('debris');
    expect(c('widget')).toBe('other');
    expect(c('drone', undefined, 'aircraft')).toBe('other');
  });
  it('puts every entity in exactly one category and lists the categories in chip order', () => {
    const recs = [{ kind: 'satellite' }, { kind: 'station' }, { kind: 'debris' }, { kind: 'moon' }];
    const counts = categoryCounts(recs);
    expect(counts.reduce((n, [, k]) => n + k, 0)).toBe(4);
    expect(counts.map(([id]) => id)).toEqual(CATEGORIES.filter((x) => x.id !== 'other').map((x) => x.id));
    expect(categoryCounts([{ kind: 'widget' }]).map(([id]) => id)).toContain('other');
  });
});

describe('matchesType (the type tag: a category id or a kind)', () => {
  type R = { kind: string; group?: string; render?: { colorKey?: string } };
  const r = (kind: string, group?: string, colorKey?: string): R => ({ kind, group, render: colorKey ? { colorKey } : undefined });

  // [name, record, values that match, values that do not]
  const TABLE: [string, R, string[], string[]][] = [
    ['plain satellite', r('satellite', 'active', 'satellite'), ['satellite', 'satellites', 'Satellites', 'SATELLITE'], ['station', 'stations', 'navigation', 'debris', 'probe', 'bodies', 'ground']],
    ['starlink', r('satellite', 'starlink', 'starlink'), ['satellite', 'satellites', 'sats'], ['navigation', 'debris']],
    ['gps satellite', r('satellite', 'gps-ops', 'navigation'), ['satellite', 'navigation', 'nav', 'gnss', 'gps'], ['satellites', 'stations']],
    ['station', r('station', 'stations', 'station'), ['station', 'stations'], ['satellite', 'satellites', 'debris']],
    ['debris', r('debris', 'cosmos-2251-debris', 'debris'), ['debris', 'Debris'], ['satellite', 'satellites']],
    ['probe', r('probe', 'dsn'), ['probe', 'probes', 'Probes'], ['rover', 'lander', 'satellites', 'ground']],
    ['rover', r('rover'), ['rover', 'rovers', 'probes'], ['probe', 'lander']],
    ['lander', r('lander'), ['lander', 'landers', 'probes'], ['probe', 'rover']],
    ['launch vehicle', r('launch_vehicle', 'launch', 'vehicle'), ['launch_vehicle', 'launch-vehicle', 'launch vehicle', 'Launch_Vehicles', 'launch-vehicles', 'launch vehicles', 'LAUNCH-VEHICLES', 'vehicles', 'rocket', 'rockets', 'launch'], ['stage', 'capsule', 'ground', 'satellites']],
    ['stage', r('stage', 'launch', 'vehicle'), ['stage', 'stages', 'launch-vehicles', 'launch_vehicles'], ['launch_vehicle', 'capsule']],
    ['capsule', r('capsule'), ['capsule', 'capsules', 'launch-vehicles'], ['stage']],
    ['drone', r('drone', undefined, 'aircraft'), ['drone', 'drones', 'other'], ['probes', 'satellites']],
    ['ground station', r('ground_station', 'dsn'), ['ground_station', 'ground-station', 'ground station', 'Ground_Stations', 'ground-stations', 'ground', 'GROUND'], ['pad', 'probes']],
    ['pad', r('pad'), ['pad', 'pads', 'ground'], ['ground_station']],
    ['star', r('star', 'bodies', 'body'), ['star', 'stars', 'bodies', 'body'], ['planet', 'moon']],
    ['planet', r('planet', 'bodies', 'body'), ['planet', 'planets', 'bodies', 'Bodies'], ['moon', 'star', 'dwarf_planet', 'asteroid']],
    ['moon', r('moon', 'bodies', 'body'), ['moon', 'moons', 'bodies'], ['planet', 'star']],
    ['dwarf planet', r('dwarf_planet', 'bodies', 'body'), ['dwarf_planet', 'dwarf-planet', 'dwarf planets', 'bodies'], ['planet']],
    ['asteroid', r('asteroid', 'bodies', 'body'), ['asteroid', 'asteroids', 'bodies'], ['planet', 'moon']],
    ['unknown kind', r('widget'), ['widget', 'widgets', 'other', 'Other'], ['satellites', 'bodies']],
  ];

  it.each(TABLE)('%s', (_name, rec, yes, no) => {
    for (const v of yes) expect(matchesType(rec, v), `type:${v}`).toBe(true);
    for (const v of no) expect(matchesType(rec, v), `type:${v}`).toBe(false);
  });

  it('matches the kind whatever the case of the record', () => {
    expect(matchesType(r('Ground_Station'), 'ground_station')).toBe(true);
  });

  // every kind in the mock catalogue, the connectors (celestrak, launchlibrary, dsn) and packages/core (EntityKind)
  const NOW = Date.parse('2026-10-22T12:00:00Z');
  const mock: EntityRecord[] = [
    ...mockSatellites(NOW, 400), ...mockLaunches(NOW).entities, ...mockGroundAndProbes(NOW), ...mockBodies(NOW),
  ];
  const connectorKinds = ['satellite', 'station', 'debris', 'launch_vehicle', 'stage', 'ground_station', 'probe', 'star', 'planet', 'moon'];
  const kinds = [...new Set([...KNOWN_KINDS, ...connectorKinds, ...mock.map((e) => e.kind)])];

  it('covers the kinds of the mock catalogue', () => {
    for (const k of ['satellite', 'station', 'debris', 'launch_vehicle', 'stage', 'ground_station', 'probe', 'planet', 'moon']) expect(kinds).toContain(k);
    expect(new Set(mock.map((e) => e.kind)).size).toBeGreaterThan(6);
  });

  it('keeps every old kind: and cat: query: a value that matched under either key matches under type', () => {
    for (const e of [...mock, ...kinds.map((kind) => r(kind))]) {
      // kind:<kind>
      expect(matchesType(e, e.kind), `kind:${e.kind}`).toBe(true);
      expect(matchesType(e, e.kind.replace(/_/g, '-')), `type:${e.kind} with -`).toBe(true);
      // the plural of a kind is that kind, except where it is a category id (`satellites`, `stations`: the category, see above)
      if (!CATEGORIES.some((c) => c.id === `${e.kind}s`)) expect(matchesType(e, `${e.kind}s`), `type:${e.kind}s`).toBe(true);
      // cat:<id> (the chips)
      expect(matchesType(e, categoryOf(e)), `cat:${categoryOf(e)}`).toBe(true);
    }
  });

  it('a category is exactly what categoryOf puts in it (the chip counts and the hide eye agree)', () => {
    for (const c of CATEGORIES) {
      const viaType = mock.filter((e) => matchesType(e, c.id)).map((e) => e.id);
      expect(viaType, c.id).toEqual(mock.filter((e) => categoryOf(e) === c.id).map((e) => e.id));
    }
    for (const id of ['bodies', 'ground', 'launch-vehicles', 'probes', 'debris']) expect(mock.filter((e) => matchesType(e, id)).length, id).toBeGreaterThan(0);
  });

  it('a kind is exactly the entities of that kind', () => {
    for (const k of kinds) {
      if (CATEGORIES.some((c) => c.id === k)) continue; // `debris` is the category (it holds the debris kind)
      expect(mock.filter((e) => matchesType(e, k)).map((e) => e.id), k).toEqual(mock.filter((e) => e.kind === k).map((e) => e.id));
    }
  });

  it('normalises a value to a category id or a kind with underscores', () => {
    const n: [string, string][] = [
      ['Launch Vehicles', 'launch-vehicles'], ['launch_vehicles', 'launch-vehicles'], ['LAUNCH-VEHICLES', 'launch-vehicles'], ['nav', 'navigation'],
      ['vehicle', 'launch-vehicles'], ['Ground-Station', 'ground_station'], ['rovers', 'rover'], ['satellites', 'satellites'], ['Satellite', 'satellite'],
      ['moons', 'moon'], ['planets', 'planet'], ['pads', 'pad'], ['body', 'bodies'], ['  Probe ', 'probe'], ['widgets', 'widgets'], ['s', 's'],
    ];
    for (const [raw, want] of n) expect(normaliseType(raw), raw).toBe(want);
    for (const [raw] of n) expect(normaliseType(normaliseType(raw)), `${raw} twice`).toBe(normaliseType(raw));
  });

  it('is safe for odd values', () => {
    for (const v of ['', ' ', '-', '_', 'a:b', '*']) expect(() => matchesType(r('satellite'), v)).not.toThrow();
    expect(matchesType(r('satellite'), '')).toBe(false);
  });
});

describe('the list holds every body entity', () => {
  it('all 35 pass an empty query and a hide term, in browse order', async () => {
    const { classify, isDrawn } = await import('../src/lib/query');
    const { browseOrder } = await import('../src/lib/filters');
    const ordered = [...bodies].sort(browseOrder);
    expect(ordered.length).toBe(35);
    for (const q of [{ terms: [] as never[] }, { terms: [{ key: 'body' as const, value: 'jupiter', effect: 'hide' as const }] }]) {
      expect(ordered.filter((r) => isDrawn(classify(r, q))).length).toBe(35);
    }
    expect(categoryCounts(bodies).find(([id]) => id === 'bodies')?.[1]).toBe(35);
  });
});
