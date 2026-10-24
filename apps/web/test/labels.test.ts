import { describe, expect, it } from 'vitest';
import {
  BODY_FADE_FULL_PX, BODY_FADE_NONE_PX, BUCKETS, LABEL_CHAR_W, LABEL_H, LABEL_PAD_X, LabelPlanner, MAX_LABELS, apparentRadiusPx,
  MAX_LABEL_CHARS, bodyLabelOpacity, labelText, labelWidth, selectNearest,
} from '../src/lib/labels';

const VW = 1400, VH = 900;

describe('apparent radius and body label fade', () => {
  it('a sphere of the Earth far away is a small disc, a near one is huge, inside is infinite', () => {
    const far = apparentRadiusPx(1e6, 6371, 45, VH);
    const near = apparentRadiusPx(24_000, 6371, 45, VH);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(10);
    expect(near).toBeGreaterThan(BODY_FADE_NONE_PX);
    expect(apparentRadiusPx(6000, 6371, 45, VH)).toBe(Infinity);
    expect(apparentRadiusPx(1000, 0, 45, VH)).toBe(0);
  });

  it('matches the small-angle value: radius / (distance tan(fov/2)) * h/2', () => {
    const px = apparentRadiusPx(1e6, 1000, 45, 900);
    expect(px).toBeCloseTo((1000 / 1e6 / Math.tan(Math.PI / 8)) * 450, 2);
  });

  it('is full for a small disc, linear between the thresholds, zero once it fills the view', () => {
    expect(bodyLabelOpacity(0)).toBe(1);
    expect(bodyLabelOpacity(BODY_FADE_FULL_PX)).toBe(1);
    expect(bodyLabelOpacity((BODY_FADE_FULL_PX + BODY_FADE_NONE_PX) / 2)).toBeCloseTo(0.5, 6);
    expect(bodyLabelOpacity(BODY_FADE_NONE_PX)).toBe(0);
    expect(bodyLabelOpacity(Infinity)).toBe(0);
    expect(bodyLabelOpacity(NaN)).toBe(0);
  });

  it('the default Earth view (24,000 km) shows no Earth label; pulled out to 400,000 km it does', () => {
    expect(bodyLabelOpacity(apparentRadiusPx(24_000, 6371, 45, VH))).toBe(0);
    expect(bodyLabelOpacity(apparentRadiusPx(400_000, 6371, 45, VH))).toBe(1);
  });
});

describe('labelText', () => {
  it('leaves a short name, cuts a long one with an ellipsis', () => {
    expect(labelText('ISS (ZARYA)')).toBe('ISS (ZARYA)');
    const long = labelText('Falcon 9 Block 5 | Starlink Group 10-31 (booster)');
    expect(long.length).toBe(MAX_LABEL_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(labelText('x'.repeat(MAX_LABEL_CHARS))).toHaveLength(MAX_LABEL_CHARS);
  });
});

describe('selectNearest', () => {
  const run = (keys: number[], k: number) => {
    const out = new Int32Array(Math.max(k, keys.length));
    const n = selectNearest(Float32Array.from(keys), keys.length, k, 2, out, new Int32Array(BUCKETS));
    return [...out.subarray(0, n)];
  };

  it('returns everything when there are no more than k', () => {
    expect(run([0.5, 0.1], 5)).toEqual([0, 1]);
    expect(run([], 5)).toEqual([]);
  });

  it('keeps exactly k, and they are the nearest', () => {
    const keys = Array.from({ length: 1000 }, (_, i) => (i * 7919 % 1000) / 500); // a permutation of 0..2
    const got = run(keys, 40);
    expect(got).toHaveLength(40);
    const sorted = [...keys].sort((a, b) => a - b);
    // every kept key is within one histogram bucket of the k-th smallest
    const bucket = 2 / (BUCKETS - 1);
    for (const i of got) expect(keys[i]).toBeLessThanOrEqual(sorted[39] + bucket);
    // and everything clearly nearer than that is kept
    const kept = new Set(got);
    keys.forEach((v, i) => {
      if (v < sorted[39] - bucket) expect(kept.has(i)).toBe(true);
    });
  });

  it('copes with ties and with keys beyond the range', () => {
    const got = run([1.5, 1.5, 1.5, 1.5, 99, -3], 3);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
    expect(got).toContain(5);
  });
});

describe('LabelPlanner', () => {
  const plan = (cands: Parameters<LabelPlanner['add']>[], max?: number) => {
    const p = new LabelPlanner(max);
    p.begin();
    for (const c of cands) p.add(...c);
    const n = p.plan(VW, VH);
    return p.out.slice(0, n).map((o) => o.id);
  };

  it('places the box right of the marker, centred on it vertically', () => {
    const p = new LabelPlanner();
    p.begin();
    p.add('a', 'MOON', 'body', 300, 200, 20);
    expect(p.plan(VW, VH)).toBe(1);
    expect(p.out[0]).toMatchObject({ id: 'a', text: 'MOON', x: 320, y: 200 - LABEL_H / 2, opacity: 1 });
    expect(labelWidth('MOON')).toBe(4 * LABEL_CHAR_W + LABEL_PAD_X);
  });

  it('orders by class: selection, hover, bodies, featured, satellites', () => {
    const ids = plan([
      ['sat', 'S', 'satellite', 100, 100, 9],
      ['feat', 'F', 'featured', 100, 200, 9],
      ['body', 'B', 'body', 100, 300, 9],
      ['hover', 'H', 'hover', 100, 400, 9],
      ['sel', 'X', 'selected', 100, 500, 9],
    ]);
    expect(ids).toEqual(['sel', 'hover', 'body', 'feat', 'sat']);
  });

  it('inside a class the one nearest the screen centre goes first', () => {
    const ids = plan([
      ['far', 'A', 'satellite', 20, 20, 9],
      ['mid', 'B', 'satellite', 400, 300, 9],
      ['mine', 'C', 'satellite', 700, 450, 9],
    ]);
    expect(ids).toEqual(['mine', 'mid', 'far']);
  });

  it('drops a label that would overlap a better one, keeps one that only touches the gap', () => {
    const ids = plan([
      ['near', 'EARTH', 'body', 700, 450, 10],
      ['over', 'MOON', 'body', 705, 455, 10], // box overlaps near's
      ['clear', 'MARS', 'body', 700, 450 + LABEL_H + 4, 10],
    ]);
    expect(ids).toEqual(['near', 'clear']);
  });

  it('never drops the selection or the hovered object for overlap or cap', () => {
    const cands: Parameters<LabelPlanner['add']>[] = [];
    for (let i = 0; i < 100; i++) cands.push([`s${i}`, 'SAT', 'satellite', 100 + (i % 10) * 100, 50 + Math.floor(i / 10) * 80, 9]);
    cands.push(['sel', 'SELECTED SAT', 'selected', 705, 455, 9]);
    cands.push(['hov', 'HOVERED', 'hover', 706, 456, 9]);
    const ids = plan(cands, 5);
    expect(ids.slice(0, 2)).toEqual(['sel', 'hov']);
    expect(ids).toContain('sel');
    expect(ids).toContain('hov');
    expect(ids.length).toBeLessThanOrEqual(5);
  });

  it('caps the count at MAX_LABELS by default', () => {
    const cands: Parameters<LabelPlanner['add']>[] = [];
    for (let i = 0; i < 400; i++) cands.push([`s${i}`, 'S', 'satellite', 20 + (i % 20) * 65, 20 + Math.floor(i / 20) * 40, 9]);
    const ids = plan(cands);
    expect(ids).toHaveLength(MAX_LABELS);
  });

  it('bodies outrank satellites when the cap bites', () => {
    const cands: Parameters<LabelPlanner['add']>[] = [];
    for (let i = 0; i < 100; i++) cands.push([`s${i}`, 'S', 'satellite', 700 + (i % 10) * 30, 450 + Math.floor(i / 10) * 20, 9]);
    cands.push(['sun', 'SUN', 'body', 5, 5, 9]);
    const ids = plan(cands, 3);
    expect(ids[0]).toBe('sun');
    expect(ids).toHaveLength(3);
  });

  it('drops candidates off screen and candidates with no opacity, carries opacity through', () => {
    const p = new LabelPlanner();
    p.begin();
    p.add('left', 'X', 'body', -300, 100, 9);
    p.add('below', 'X', 'body', 100, VH + 50, 9);
    p.add('faded', 'X', 'body', 100, 100, 9, 0);
    p.add('half', 'HALF', 'body', 200, 200, 9, 0.5);
    expect(p.plan(VW, VH)).toBe(1);
    expect(p.out[0]).toMatchObject({ id: 'half', opacity: 0.5 });
  });

  it('a label shown last frame keeps its place against a slightly nearer rival (no flicker)', () => {
    const p = new LabelPlanner();
    const frame = (aY: number) => {
      p.begin();
      p.add('a', 'AAAAAA', 'satellite', 700, aY, 10);
      p.add('b', 'BBBBBB', 'satellite', 700, 450 + 8, 10); // overlaps a's box
      p.plan(VW, VH);
      return p.out.slice(0, p.count).map((o) => o.id);
    };
    expect(frame(450 - 5)).toEqual(['a']); // a is nearer the centre, shown
    // now b is a little nearer than a, but a was shown: it stays
    expect(frame(450 - 9)).toEqual(['a']);
    expect(frame(450 + 24)).toEqual(['b']); // clearly worse: b takes over
  });

  it('reuses its pooled objects: the output objects are the same across frames', () => {
    const p = new LabelPlanner();
    p.begin();
    p.add('a', 'A', 'body', 100, 100, 9);
    p.plan(VW, VH);
    const first = p.out[0];
    p.begin();
    p.add('b', 'B', 'body', 100, 100, 9);
    p.plan(VW, VH);
    expect(p.out[0]).toBe(first);
    expect(p.out[0].id).toBe('b');
  });

  it('an empty frame yields no labels', () => {
    const p = new LabelPlanner();
    p.begin();
    expect(p.plan(VW, VH)).toBe(0);
    expect(p.count).toBe(0);
  });
});
