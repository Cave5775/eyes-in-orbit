import { describe, expect, it } from 'vitest';
import {
  SCOPE_FACTOR, SCOPE_MIN_KM, SCOPE_SOLO_CUT, hash01, inScope, inView, scopeRadius, scopeWeight, type ScopeObject,
} from '../src/lib/scope';
import { SHELL_THRESHOLD_KM } from '../src/lib/deepspace';

const obj = (o: Partial<ScopeObject>): ScopeObject => ({ d: 0, key: 0, bulk: false, keep: false, ...o });

describe('scope radius', () => {
  it('grows with the camera distance and has a floor', () => {
    expect(scopeRadius(1)).toBe(SCOPE_MIN_KM);
    expect(scopeRadius(4)).toBe(320);
    expect(scopeRadius(0)).toBe(SCOPE_MIN_KM);
    expect(scopeRadius(24_000)).toBe(24_000 * SCOPE_FACTOR);
    expect(scopeRadius(1e6)).toBeGreaterThan(scopeRadius(1e5));
  });

  it('a low view keeps the neighbourhood and drops the catalogue and the deep-space shell', () => {
    const r = scopeRadius(4); // 4 km above a pad
    expect(r).toBeLessThan(1000);
    expect(inScope(obj({ d: 50 }), r)).toBe(true); // a pad 50 km away
    expect(inScope(obj({ d: 550 }), r)).toBe(false); // a probe in the sky / a LEO satellite directly overhead
    expect(inScope(obj({ d: 2.5e6 }), r)).toBe(false);
    expect(inScope(obj({ d: 600, key: 5, bulk: true }), r)).toBe(false);
  });

  it('the default Earth view keeps near-Earth space and starts to drop the shell; pulling out keeps everything', () => {
    const def = scopeRadius(24_000);
    expect(inScope(obj({ d: 1.5e6 }), def)).toBe(true); // JWST
    expect(inScope(obj({ d: SHELL_THRESHOLD_KM * 1.6 }), def)).toBe(false);
    expect(inScope(obj({ d: 4.0e6 }), scopeRadius(60_000))).toBe(true);
  });
});

describe('thinning', () => {
  it('weights are 1 inside, 0 beyond twice the radius, linear between', () => {
    expect(scopeWeight(50, 100)).toBe(1);
    expect(scopeWeight(100, 100)).toBe(1);
    expect(scopeWeight(150, 100)).toBeCloseTo(0.5, 12);
    expect(scopeWeight(200, 100)).toBe(0);
    expect(scopeWeight(1e9, 100)).toBe(0);
  });

  it('keeps a stable subset whose size follows the weight', () => {
    expect(hash01(7)).toBe(hash01(7));
    const n = 20_000;
    let kept = 0;
    for (let i = 0; i < n; i++) if (inScope(obj({ d: 150, key: i, bulk: true }), 100)) kept++;
    expect(kept / n).toBeGreaterThan(0.47);
    expect(kept / n).toBeLessThan(0.53);
    for (let i = 0; i < 1000; i++) {
      const a = hash01(i);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  it('thinned points do not come back as the radius shrinks (nested subsets)', () => {
    // the same hash is compared with a weight that only falls as d grows
    const keptAt = (d: number) => Array.from({ length: 2000 }, (_, i) => i).filter((i) => inScope(obj({ d, key: i, bulk: true }), 100));
    const near = new Set(keptAt(130)), far = keptAt(170);
    for (const i of far) expect(near.has(i)).toBe(true);
  });

  it('single entities are cut at SCOPE_SOLO_CUT radii, not thinned', () => {
    expect(inScope(obj({ d: 100 * SCOPE_SOLO_CUT - 1 }), 100)).toBe(true);
    expect(inScope(obj({ d: 100 * SCOPE_SOLO_CUT + 1 }), 100)).toBe(false);
  });
});

describe('exemptions and mode', () => {
  it('always keeps selected / related / hovered / filtered-in objects', () => {
    expect(inScope(obj({ d: 1e10, keep: true }), 100)).toBe(true);
    expect(inScope(obj({ d: 1e10, keep: true, bulk: true, key: 3 }), 100)).toBe(true);
  });

  it('"all" mode keeps everything', () => {
    expect(inScope(obj({ d: 1e10 }), 100, 'all')).toBe(true);
    expect(inScope(obj({ d: 1e10, bulk: true, key: 9 }), 100, 'all')).toBe(true);
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
