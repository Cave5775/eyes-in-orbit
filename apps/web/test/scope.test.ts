import { describe, expect, it } from 'vitest';
import { bodyInScope, bodyShown, focusBodyOf, inScope, inView, isScopeExempt, scopeBodies, type ScopeObject } from '../src/lib/scope';
import { MARKER_BELOW_PX } from '../src/lib/body-style';

describe('bodyInScope by hierarchy', () => {
  const at = (focus: string, body: string, keep = false) => bodyInScope(body, scopeBodies(focus), keep);
  it('Solar System view: the Sun and the planets, no moon of any planet', () => {
    for (const b of ['SUN', 'EARTH', 'MARS', 'JUPITER', 'PLUTO']) expect(at('SUN', b)).toBe(true);
    for (const b of ['MOON', 'PHOBOS', 'IO', 'TITAN', 'CHARON']) expect(at('SUN', b)).toBe(false);
  });
  it('Earth view: the Moon and the planets, not Phobos or Io', () => {
    for (const b of ['MOON', 'MARS', 'JUPITER', 'SUN']) expect(at('EARTH', b)).toBe(true);
    for (const b of ['PHOBOS', 'IO']) expect(at('EARTH', b)).toBe(false);
  });
  it("a planet's system holds its moons; a moon's system holds its siblings", () => {
    expect(at('JUPITER', 'IO')).toBe(true);
    expect(at('JUPITER', 'MOON')).toBe(false);
    expect(at('PHOBOS', 'DEIMOS')).toBe(true);
    expect(at('PHOBOS', 'IO')).toBe(false);
  });
  it('a kept body, Draw everything and an unknown body are always in', () => {
    expect(at('SUN', 'IO', true)).toBe(true);
    expect(bodyInScope('IO', scopeBodies('SUN'), false, 'all')).toBe(true);
    expect(at('SUN', 'NOT_A_BODY')).toBe(true);
  });
  it('out of scope is still shown once its disc is visible', () => {
    expect(bodyShown(true, 0.1)).toBe(true);
    expect(bodyShown(false, MARKER_BELOW_PX * 0.5)).toBe(false);
    expect(bodyShown(false, MARKER_BELOW_PX)).toBe(true);
    expect(bodyShown(false, Infinity)).toBe(true);
  });
});

const obj = (o: Partial<ScopeObject>): ScopeObject => ({ parent: 'EARTH', keep: false, ...o });

describe('scopeBodies', () => {
  it('is the focus body plus its ancestors', () => {
    expect([...scopeBodies('EARTH')].sort()).toEqual(['EARTH', 'SUN']);
    const moon = scopeBodies('MOON');
    for (const id of ['MOON', 'EARTH', 'SUN']) expect(moon.has(id)).toBe(true);
    expect([...scopeBodies('MARS')].sort()).toEqual(['MARS', 'SUN']);
  });

  it('an unknown body gives only itself', () => {
    expect([...scopeBodies('NOPE')]).toEqual(['NOPE']);
  });
});

describe('inScope by hierarchy', () => {
  const at = (focus: string) => scopeBodies(focus);

  it('an Earth satellite is in for the Earth and the Moon, out for Mars and the Sun', () => {
    const sat = obj({ parent: 'EARTH' });
    expect(inScope(sat, at('EARTH'))).toBe(true);
    expect(inScope(sat, at('MOON'))).toBe(true);
    expect(inScope(sat, at('MARS'))).toBe(false);
    expect(inScope(sat, at('SUN'))).toBe(false);
  });

  it('an object listed under the Sun (JWST, Voyager) is in for every focus', () => {
    for (const f of ['EARTH', 'MOON', 'MARS', 'SUN']) expect(inScope(obj({ parent: 'SUN' }), at(f))).toBe(true);
  });

  it('a Mars orbiter is out at the Earth and in at Mars; a lunar orbiter is out at the Earth and in at the Moon', () => {
    const mro = obj({ parent: 'MARS' }), lro = obj({ parent: 'MOON' });
    expect(inScope(mro, at('EARTH'))).toBe(false);
    expect(inScope(mro, at('MARS'))).toBe(true);
    expect(inScope(lro, at('EARTH'))).toBe(false);
    expect(inScope(lro, at('MOON'))).toBe(true);
  });

  it('keep, exempt kinds, mode "all" and a missing parent are always in', () => {
    const far = at('MARS');
    expect(inScope(obj({ parent: 'EARTH', keep: true }), far)).toBe(true);
    for (const kind of ['star', 'planet', 'moon']) {
      expect(isScopeExempt(kind)).toBe(true);
      expect(inScope(obj({ parent: 'EARTH', kind }), far)).toBe(true);
    }
    expect(isScopeExempt('satellite')).toBe(false);
    expect(isScopeExempt(undefined)).toBe(false);
    expect(inScope(obj({ parent: 'EARTH', kind: 'probe' }), far)).toBe(false);
    expect(inScope(obj({ parent: 'EARTH' }), far, 'all')).toBe(true);
    expect(inScope(obj({ parent: undefined }), far)).toBe(true);
  });
});

describe('focusBodyOf', () => {
  it('the first defined anchor wins; a body anchor gives its body, any other its parent', () => {
    expect(focusBodyOf([undefined, { parent: 'MARS' }, { parent: 'EARTH' }])).toBe('MARS');
    expect(focusBodyOf([{ body: 'MOON', parent: 'EARTH' }, { parent: 'MARS' }])).toBe('MOON');
    expect(focusBodyOf([{ parent: 'SUN' }])).toBe('SUN');
  });

  it('falls back to the Earth, or the given fallback, with no anchor', () => {
    expect(focusBodyOf([undefined, undefined])).toBe('EARTH');
    expect(focusBodyOf([])).toBe('EARTH');
    expect(focusBodyOf([undefined], 'SUN')).toBe('SUN');
  });
});

describe('view test', () => {
  it('accepts clip-space points inside the frustum (with a margin) and rejects ones behind the camera', () => {
    expect(inView(0, 0, 1)).toBe(true);
    expect(inView(1.02, 0, 1)).toBe(true);
    expect(inView(1.2, 0, 1)).toBe(false);
    expect(inView(0, -3, 2)).toBe(false);
    expect(inView(0, 0, -1)).toBe(false);
    expect(inView(0, 0, 0)).toBe(false);
  });
});
