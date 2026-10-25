import { describe, expect, it } from 'vitest';
import { bodyEntityRecords, type EntityRecord } from '@eio/core';
import {
  CATEGORIES, bodyFacts, categoryCounts, categoryOf, emptyHint,
} from '../src/lib/browser-ui';
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
    expect(resolveFrame(parseFrame('{"kind":"body","id":"PLUTO"}'), look)).toBe(EARTH_CENTRE);
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
  it('names the DSN panel only while it is shown', () => {
    expect(emptyHint(false)).not.toMatch(/DSN/);
    expect(emptyHint(true)).toMatch(/DSN panel/);
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
