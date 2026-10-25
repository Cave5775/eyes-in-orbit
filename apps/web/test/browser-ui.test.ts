import { describe, expect, it } from 'vitest';
import { bodyEntityRecords, type EntityRecord } from '@eio/core';
import {
  BODY_KINDS, CATEGORIES, activeBodyTab, bodyFacts, bodyTabs, capChips, categoryCounts, categoryOf, emptyHint, GROUP_CHIP_CAP,
} from '../src/lib/browser-ui';
import { EARTH_CENTRE, bodyCentre, entityCentre } from '../src/lib/frame';
import { frameOnSelect, loadFrame, parseFrame, resolveFrame, saveFrame, serialiseFrame } from '../src/lib/frame-store';

const bodies = bodyEntityRecords();
const byId = (id: string): EntityRecord => bodies.find((b) => b.id === id)!;
const sat = (id: string): EntityRecord => ({ id, name: id, kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0 });

describe('frameOnSelect', () => {
  it('a body entity gives its body, unless the frame is locked', () => {
    expect(frameOnSelect(byId('body-moon'), false)).toEqual(bodyCentre('MOON'));
    expect(frameOnSelect(byId('body-mars'), false)).toEqual(bodyCentre('MARS'));
    expect(frameOnSelect(byId('body-earth'), true)).toBeNull();
  });
  it('an ordinary object, nothing, or a non-registry orbitable gives null', () => {
    expect(frameOnSelect(sat('iss'), false)).toBeNull();
    expect(frameOnSelect(undefined, false)).toBeNull();
    expect(frameOnSelect({ ...sat('ceres'), attrs: { orbitable: true } }, false)).toBeNull();
  });
});

describe('frame persistence helpers', () => {
  it('round-trips both kinds of centre', () => {
    for (const c of [EARTH_CENTRE, bodyCentre('MARS'), entityCentre('sat-25544')]) expect(parseFrame(serialiseFrame(c))).toEqual(c);
  });
  it('parses anything malformed to null', () => {
    for (const raw of [null, undefined, '', 'nope', '[]', 'null', '42', '{}', '{"kind":"body"}', '{"kind":"x","id":"EARTH"}', '{"kind":"body","id":""}', '{"kind":"body","id":7}']) {
      expect(parseFrame(raw as string | null | undefined)).toBeNull();
    }
  });
  it('drops extra fields (the lock is never stored)', () => {
    expect(serialiseFrame({ kind: 'body', id: 'MOON', locked: true } as never)).toBe('{"kind":"body","id":"MOON"}');
    expect(parseFrame('{"kind":"body","id":"MOON","locked":true}')).toEqual(bodyCentre('MOON'));
  });
  it('resolves a stored frame against the catalog, falling back to the Earth when stale', () => {
    const cat = new Map<string, EntityRecord>([['iss', sat('iss')], ...bodies.map((b) => [b.id, b] as [string, EntityRecord])]);
    const look = (id: string) => cat.get(id);
    expect(resolveFrame(bodyCentre('MOON'), look)).toEqual(bodyCentre('MOON'));
    expect(resolveFrame(bodyCentre('MARS'), look)).toEqual(bodyCentre('MARS'));
    expect(resolveFrame(bodyCentre('PLUTO'), look)).toEqual(EARTH_CENTRE);
    expect(resolveFrame(entityCentre('iss'), look)).toEqual(entityCentre('iss'));
    expect(resolveFrame(entityCentre('removed'), look)).toEqual(EARTH_CENTRE);
    expect(resolveFrame(null, look)).toEqual(EARTH_CENTRE);
    // an entity centre naming a body entity becomes the body centre
    expect(resolveFrame(entityCentre('body-moon'), look)).toEqual(bodyCentre('MOON'));
  });
  it('loads and saves through a storage, tolerating failures', () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(loadFrame(store)).toBeNull();
    expect(saveFrame(bodyCentre('SUN'), store)).toBe(true);
    expect(data.get('eio.frame')).toBe('{"kind":"body","id":"SUN"}');
    expect(loadFrame(store)).toEqual(bodyCentre('SUN'));
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('y'); } };
    expect(loadFrame(bad)).toBeNull();
    expect(saveFrame(EARTH_CENTRE, bad)).toBe(false);
    expect(saveFrame(EARTH_CENTRE, null)).toBe(false);
  });
});

describe('bodyTabs', () => {
  it('one tab per body entity in hierarchy order: Sun, Earth, Mars, Moon', () => {
    const shuffled = [sat('iss'), byId('body-moon'), byId('body-sun'), byId('body-mars'), byId('body-earth')];
    expect(bodyTabs(shuffled).map((t) => t.bodyId)).toEqual(['SUN', 'EARTH', 'MARS', 'MOON']);
    expect(bodyTabs(shuffled)[3]).toEqual({ bodyId: 'MOON', name: 'Moon', entityId: 'body-moon' });
  });
  it('uses the registry before the catalog has arrived', () => {
    expect(bodyTabs([sat('iss')]).map((t) => t.bodyId)).toEqual(['SUN', 'EARTH', 'MARS', 'MOON']);
  });
  it('follows the entities present', () => {
    expect(bodyTabs([byId('body-earth'), byId('body-moon')]).map((t) => t.bodyId)).toEqual(['EARTH', 'MOON']);
  });
  it('the active tab is the body that is the frame', () => {
    const tabs = bodyTabs(bodies);
    expect(activeBodyTab(tabs, bodyCentre('MARS'))).toBe('MARS');
    expect(activeBodyTab(tabs, EARTH_CENTRE)).toBe('EARTH');
    expect(activeBodyTab(tabs, entityCentre('iss'))).toBeNull();
  });
});

describe('capChips', () => {
  const many: [string, number][] = Array.from({ length: 30 }, (_, i) => [`g${i}`, 100 - i]);
  it('keeps everything when it fits', () => {
    expect(capChips(many.slice(0, 5), 14)).toEqual({ shown: many.slice(0, 5), hidden: 0 });
  });
  it('caps to the top n and counts the rest', () => {
    const r = capChips(many, GROUP_CHIP_CAP);
    expect(r.shown).toHaveLength(14);
    expect(r.hidden).toBe(16);
  });
  it('keeps pinned and active chips beyond the cap, in the original order', () => {
    const kinds: [string, number][] = [...many.slice(0, 12), ['star', 1], ['planet', 3], ['moon', 2]];
    const r = capChips(kinds, 10, { pinned: BODY_KINDS });
    expect(r.shown.map(([k]) => k)).toEqual([...kinds.slice(0, 10).map(([k]) => k), 'star', 'planet', 'moon']);
    expect(r.hidden).toBe(2);
    const a = capChips(many, 3, { active: new Set(['g20']) });
    expect(a.shown.map(([k]) => k)).toEqual(['g0', 'g1', 'g2', 'g20']);
  });
  it('expanded shows every chip', () => {
    expect(capChips(many, 3, { expanded: true })).toEqual({ shown: many, hidden: 0 });
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
