import { describe, expect, it } from 'vitest';
import { defaultBodies } from '@eio/core';
import { BODY_GROUPS, bodyGroupInfo, bodyGroupLabel, bodyGroupOrder, registryBodyKinds } from '../src/lib/body-groups';

describe('body groups', () => {
  it('has a folder for planets, dwarf planets, moons and asteroids in that order, the asteroid one before any such kind exists', () => {
    const kinds = Object.keys(BODY_GROUPS).sort((a, b) => bodyGroupOrder(a) - bodyGroupOrder(b));
    expect(kinds).toEqual(['star', 'planet', 'dwarf_planet', 'moon', 'asteroid']);
    expect(bodyGroupLabel('dwarf_planet')).toBe('Dwarf planets');
    expect(bodyGroupLabel('asteroid')).toBe('Asteroids');
  });

  it('puts an unknown kind after the known ones under its own name', () => {
    expect(bodyGroupInfo('comet')).toEqual({ label: 'Comets', order: 99 });
    expect(bodyGroupInfo('other').label).toBe('Other bodies');
  });

  it('classes the registry: a root is a star, the dwarf flag wins, a child of the star is a planet, deeper is a moon', () => {
    const kinds = registryBodyKinds([
      { id: 'SUN' }, { id: 'EARTH', parentId: 'SUN' }, { id: 'MOON', parentId: 'EARTH' }, { id: 'PLUTO', parentId: 'SUN', dwarf: true },
    ]);
    expect(Object.fromEntries(kinds)).toEqual({ SUN: 'star', EARTH: 'planet', MOON: 'moon', PLUTO: 'dwarf_planet' });
  });

  it('agrees with the real registry', () => {
    const kinds = registryBodyKinds(defaultBodies.all());
    expect(kinds.get('SUN')).toBe('star');
    expect(kinds.get('EARTH')).toBe('planet');
    expect(kinds.get('MOON')).toBe('moon');
    expect(kinds.get('PLUTO')).toBe('dwarf_planet');
  });
});
