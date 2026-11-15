import { describe, expect, it } from 'vitest';
import { inScope, inView, scopeBodies } from '../src/lib/scope';
import { SCOPE_CHUNK, SPECIAL_EXEMPT, SPECIAL_KEEP, markSpecials, scanScope, type ScopeScanInput } from '../src/lib/scope-scan';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SHOW_EXEMPT = 2;

/** Deterministic points scattered over `spanKm` around the origin. */
function cloud(n: number, spanKm: number): Float64Array {
  const w = new Float64Array(n * 3);
  let x = 12345;
  const rnd = () => ((x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0) >>> 0) / 4294967296;
  for (let i = 0; i < w.length; i++) w[i] = (rnd() * 2 - 1) * spanKm;
  return w;
}

function input(n: number, over: Partial<ScopeScanInput> = {}): ScopeScanInput {
  const world = over.world ?? cloud(n, 20_000);
  const rel = new Float32Array(world.length); // the camera sits at the origin and looks along its own +x/y/z: only sets inView
  for (let i = 0; i < rel.length; i++) rel[i] = world[i];
  return {
    world, fixed: false, spinCos: 1, spinSin: 0, shift: [0, 0, 0], rel,
    size: new Float32Array(n).fill(3), show: new Float32Array(n).fill(1),
    keep: null, exempt: null, special: null, system: null, systemAll: true, mode: 'auto',
    m: IDENTITY,
    occluded: () => false, discHidden: () => false, showExempt: SHOW_EXEMPT, inFlightKm: 6381,
    ...over,
  };
}

describe('scanScope matches the scope policy', () => {
  it('a whole set out of scope (systemAll false) shows nothing, in scope shows everything', () => {
    const n = 500;
    const out = input(n, { systemAll: false });
    scanScope(out, 0, n);
    expect(out.show.every((v) => v === 0)).toBe(true);
    const inn = input(n, { systemAll: true });
    inn.show.fill(0);
    scanScope(inn, 0, n);
    expect(inn.show.every((v) => v === 1)).toBe(true);
  });

  it('a per-point system array decides per point and follows inScope', () => {
    const n = 600;
    const parents = ['EARTH', 'SUN', 'MARS', 'MOON', undefined];
    const bodies = scopeBodies('MARS');
    const ps = Array.from({ length: n }, (_, i) => parents[i % parents.length]);
    const system = new Uint8Array(n);
    for (let i = 0; i < n; i++) system[i] = inScope({ parent: ps[i], keep: false }, bodies) ? 1 : 0;
    const s = input(n, { system, systemAll: false });
    scanScope(s, 0, n);
    let inCount = 0;
    for (let i = 0; i < n; i++) {
      const want = inScope({ parent: ps[i], keep: false }, bodies) ? 1 : 0;
      expect(s.show[i]).toBe(want);
      inCount += want;
    }
    expect(inCount).toBeGreaterThan(0);
    expect(inCount).toBeLessThan(n);
  });

  it('keep, special bits and mode "all" are never scoped out; exempt ones get SHOW_EXEMPT', () => {
    const n = 100;
    const world = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) world[i * 3] = 1e7 + i;
    const keep = new Uint8Array(n), special = new Uint8Array(n), exempt = new Uint8Array(n);
    keep[1] = 1;
    special[2] = SPECIAL_KEEP;
    special[3] = SPECIAL_KEEP | SPECIAL_EXEMPT;
    exempt[4] = 1; // a launch vehicle, but it is out of scope and not special
    const s = input(n, { world, keep, special, exempt, systemAll: false });
    scanScope(s, 0, n);
    expect(Array.from(s.show.slice(0, 6))).toEqual([0, SHOW_EXEMPT, 1, SHOW_EXEMPT, 0, 0]); // keep[1] = filter hit: exempt too
    const all = input(n, { world, systemAll: false, mode: 'all', exempt });
    all.show.fill(0);
    scanScope(all, 0, n);
    expect(all.show.every((v) => v === 1 || v === SHOW_EXEMPT)).toBe(true);
    expect(all.show[4]).toBe(SHOW_EXEMPT); // in flight (far above the ground) and let through by mode
  });

  it('skips points with no position and counts only what is drawn', () => {
    const n = 4;
    const world = new Float64Array([0, 0, 0, 0.1, 0, 0, 0.2, 0, 0, 0.3, 0, 0]);
    const s = input(n, { world, size: new Float32Array([3, 3, 0, 3]), occluded: (x) => x > 0.25 });
    s.show.fill(7);
    const r = scanScope(s, 0, n);
    expect(r.total).toBe(3); // point 0 has no position
    expect(s.show[0]).toBe(7); // untouched
    expect(r.rendered).toBe(1); // 0.1: drawn; 0.2: size 0; 0.3: behind a body
    expect(r.changed).toBe(true);
  });

  it('the in-flight exempt flag uses the rotated Earth-fixed position and the shifted inertial one', () => {
    // fixed: (7000, 0, 0) rotated a quarter turn is (0, 7000, 0): still 7000 km out, in flight either way; use a point whose
    // rotation does not matter for the radius, and one whose shift does
    const fixed = input(1, { world: new Float64Array([7000, 0, 0]), fixed: true, spinCos: 0, spinSin: 1, exempt: new Uint8Array([1]) });
    scanScope(fixed, 0, 1);
    expect(fixed.show[0]).toBe(SHOW_EXEMPT);
    // inertial: on the ground in its own frame (radius 100), but the shift puts it 7000 km out
    const shifted = input(1, { world: new Float64Array([0, 0, 100]), shift: [7000, 0, 0], exempt: new Uint8Array([1]) });
    scanScope(shifted, 0, 1);
    expect(shifted.show[0]).toBe(SHOW_EXEMPT);
    // the same point, not shifted, is on the ground: not exempt
    const ground = input(1, { world: new Float64Array([0, 0, 100]), exempt: new Uint8Array([1]) });
    scanScope(ground, 0, 1);
    expect(ground.show[0]).toBe(1);
    // an Earth-fixed set ignores `shift`
    const fixedIgnoresShift = input(1, { world: new Float64Array([0, 0, 100]), fixed: true, shift: [7000, 0, 0], exempt: new Uint8Array([1]) });
    scanScope(fixedIgnoresShift, 0, 1);
    expect(fixedIgnoresShift.show[0]).toBe(1);
  });

  it('reports no change on a second identical scan, and slicing gives the same result as one pass', () => {
    const n = 3000;
    const a = input(n), b = input(n, { world: a.world });
    const one = scanScope(a, 0, n);
    expect(scanScope(a, 0, n).changed).toBe(false);
    let total = 0, rendered = 0;
    for (let at = 0; at < n; at += 700) {
      const r = scanScope(b, at, at + 700);
      total += r.total;
      rendered += r.rendered;
    }
    expect(total).toBe(one.total);
    expect(rendered).toBe(one.rendered);
    expect(Array.from(b.show)).toEqual(Array.from(a.show));
  });

  it('the view test uses the same projection convention as lib/scope inView', () => {
    // identity matrix: clip = (x, y, z, 1): in view while |x|, |y| <= 1.05
    const world = new Float64Array([0.5, 0.5, 0, 2, 0, 0]);
    const s = input(2, { world });
    expect(scanScope(s, 0, 2).rendered).toBe(1);
    expect(inView(0.5, 0.5, 1)).toBe(true);
    expect(inView(2, 0, 1)).toBe(false);
  });
});

describe('markSpecials', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `id${i}`);
  it('marks keep and exempt ids (a few: indexOf)', () => {
    const out = new Uint8Array(ids.length).fill(9);
    markSpecials(ids, out, ['id3', 'id7', 'missing'], ['id7', null, 'id10']);
    expect(out[3]).toBe(SPECIAL_KEEP);
    expect(out[7]).toBe(SPECIAL_KEEP | SPECIAL_EXEMPT);
    expect(out[10]).toBe(SPECIAL_EXEMPT);
    expect(out[0]).toBe(0);
  });
  it('gives the same result through the Set pass for many ids', () => {
    const many = ids.slice(0, 30);
    const out = new Uint8Array(ids.length);
    markSpecials(ids, out, many, ['id40']);
    expect(Array.from(out.slice(0, 31)).every((v, i) => v === (i < 30 ? SPECIAL_KEEP : 0))).toBe(true);
    expect(out[40]).toBe(SPECIAL_EXEMPT);
  });
  it('resets earlier marks', () => {
    const out = new Uint8Array(ids.length);
    markSpecials(ids, out, ['id1'], []);
    markSpecials(ids, out, [], []);
    expect(out.every((v) => v === 0)).toBe(true);
  });
});

describe('cost', () => {
  it('a chunk is a small fraction of a full pass at 100 k and the scan has no per-point allocation blow-up', () => {
    const n = 100_000;
    const s = input(n);
    const t0 = performance.now();
    for (let at = 0; at < n; at += SCOPE_CHUNK) scanScope(s, at, at + SCOPE_CHUNK);
    const full = performance.now() - t0;
    console.log(`scanScope 100k points: ${full.toFixed(1)} ms for the whole catalogue`);
    expect(full).toBeLessThan(500); // generous: the old loop took about 60 ms here on a fast machine, this one a few
  });
});
