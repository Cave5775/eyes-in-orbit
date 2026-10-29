import { describe, expect, it } from 'vitest';
import { bodyPickScan, gatherWithBodies, type BodyPickContext, type DrawnBody } from '../src/lib/body-scene';
import { BODY_MARKER_PX, pickPrecedence, type BodyProbe, type PickSource } from '../src/lib/pick';
import { LABEL_H, LabelPlanner, MOON_SEP_FULL, MOON_SEP_MIN } from '../src/lib/labels';

/** A probed body: `d` px from the cursor, a disc of `disc` px, `dist` from the camera; hit area as `bodyHitRadiusPx`. */
const probe = (id: string, d: number, disc: number, dist: number): BodyProbe => ({
  id, d2: d * d, sx: 100 + d, sy: 100, dist, discPx: disc, hitPx: Math.max(14, disc + 3), rel: [dist, 0, 0],
});
const ids = (r: { hits: BodyProbe[] }) => r.hits.map((p) => p.id);

describe('pickPrecedence (bodies under one cursor)', () => {
  it('a moon whose 14 px margin overlaps the planet disc does not take the planet\'s click', () => {
    // Jupiter-like disc of 40 px, the cursor 20 px from its centre; a moon dot 10 px away (inside its margin, outside its marker)
    const r = pickPrecedence([probe('body-jupiter', 20, 40, 100), probe('body-io', BODY_MARKER_PX + 5, 1, 99)]);
    expect(ids(r)).toEqual(['body-jupiter']);
    expect(r.covers).toEqual([{ sx: 120, sy: 100, r: 40 }]);
  });

  it('a moon in front of the planet is hit on its own marker, and the planet is listed with it', () => {
    const r = pickPrecedence([probe('body-jupiter', 20, 40, 100), probe('body-io', 3, 1, 90)]);
    expect(ids(r)).toEqual(['body-jupiter', 'body-io']);
  });

  it('a moon behind the planet is not hit through the planet\'s disc', () => {
    const r = pickPrecedence([probe('body-jupiter', 20, 40, 100), probe('body-io', 3, 1, 120)]);
    expect(ids(r)).toEqual(['body-jupiter']);
  });

  it('beside the planet the moon keeps its extended margin, and the planet keeps its own', () => {
    // cursor 45 px from the planet centre (outside the disc, outside its margin) and 8 px from the moon
    expect(ids(pickPrecedence([probe('body-jupiter', 45, 40, 100), probe('body-io', 8, 1, 100)]))).toEqual(['body-io']);
    // 42 px from the planet: in its 3 px margin only
    expect(ids(pickPrecedence([probe('body-jupiter', 42, 40, 100), probe('body-io', 60, 1, 100)]))).toEqual(['body-jupiter']);
    // the planet's margin yields to a moon disc that holds the cursor
    expect(ids(pickPrecedence([probe('body-jupiter', 42, 40, 100), probe('body-io', 3, 1, 100)]))).toEqual(['body-io']);
  });

  it('two overlapping discs: the nearer smaller one is listed with the larger, a nearer larger one covers the other', () => {
    expect(ids(pickPrecedence([probe('body-saturn', 10, 40, 100), probe('body-titan', 5, 12, 80)]))).toEqual(['body-saturn', 'body-titan']);
    expect(ids(pickPrecedence([probe('body-saturn', 10, 40, 80), probe('body-titan', 5, 12, 100)]))).toEqual(['body-saturn']);
  });

  it('a lone body keeps its minimum hit area, and a far cursor hits nothing', () => {
    expect(ids(pickPrecedence([probe('body-moon', 13, 2, 100)]))).toEqual(['body-moon']);
    expect(ids(pickPrecedence([probe('body-moon', 15, 2, 100)]))).toEqual([]);
  });
});

describe('bodyPickScan and objects (projected scene)', () => {
  // a camera at x0 on the x axis looking along +x, 60 degree field of view, 200 x 200 px
  const F = 1 / Math.tan(Math.PI / 6);
  const PROJ = new Float32Array([0, 0, -1, 1, -F, 0, 0, 0, 0, F, 0, 0, 0, 0, -0.02, 0]);
  const ctx = (px: number, py = 100): BodyPickContext => ({ origin: [0, 0, 0], m: PROJ, w: 200, h: 200, px, py, fovDeg: 60 });
  const body = (id: string, c: [number, number, number], radiusKm: number): DrawnBody => ({ entityId: `body-${id}`, c, radiusKm, k: 1 });
  /** x km ahead, y km to the left: screen x px */
  const sxOf = (x: number, y: number) => (-F * y / x) * 100 + 100;
  const jupiter = body('jupiter', [1_000_000, 0, 0], 71_492);
  const big = body('jupiter', [300_000, 0, 0], 71_492); // a big disc
  const moonAt = (id: string, x: number, y: number) => body(id, [x, y, 0], 1_800);
  const opts = { max: 12, wantTotal: true, occluded: () => false, ranks: new Map([['body-jupiter', 1000], ['body-io', 2000], ['probe', 1e6 + 2]]) };
  const objectAt = (x: number, y: number): PickSource => ({
    ids: ['probe'], rel: new Float32Array([x, y, 0]), world: new Float32Array([x, y, 1]), size: new Float32Array([8]), show: new Float32Array([1]), bias: 0,
  });
  const run = (bodies: DrawnBody[], sources: PickSource[], px: number) => {
    const scan = bodyPickScan(bodies, ctx(px));
    return gatherWithBodies(sources, [], () => scan.extras, PROJ, 200, 200, px, 100, { ...opts, covers: scan.covers });
  };

  it('has a planet disc wider than the moon margin to work with', () => {
    // disc radius px = r / sqrt(d^2 - r^2) * focal (focal = 100 / tan 30 deg)
    const disc = 71_492 / Math.sqrt(300_000 ** 2 - 71_492 ** 2) * (100 / Math.tan(Math.PI / 6));
    expect(disc).toBeGreaterThan(40);
    expect(bodyPickScan([jupiter], ctx(100)).extras).toHaveLength(1);
  });

  it('the cursor inside the planet\'s disc picks the planet although a moon dot lies within its margin', () => {
    const io = moonAt('io', 290_000, 25_000); // beside the centre of the disc, in front, a few px off the cursor
    const px = sxOf(290_000, 25_000) + 9;
    const r = run([big, io], [], px);
    expect(r.items.map((h) => h.id)).toEqual(['body-jupiter']);
  });

  it('an object beside the planet (centre outside the disc) cannot take a click inside the disc; one over the disc can', () => {
    // the disc edge is ~ 70 px right of the centre; the cursor sits 4 px inside it, the probe 7 px outside the edge
    const edge = 100 + 71_492 / Math.sqrt(300_000 ** 2 - 71_492 ** 2) * (100 / Math.tan(Math.PI / 6));
    const px = edge - 4;
    const beside = objectAt(300_000, -(edge + 3 - 100) * 300_000 / (F * 100));
    expect(sxOf(300_000, beside.rel[1])).toBeGreaterThan(edge);
    expect(run([big], [beside], px).items.map((h) => h.id)).toEqual(['body-jupiter']);
    const over = objectAt(250_000, -(edge - 8 - 100) * 250_000 / (F * 100));
    expect(run([big], [over], px).items.map((h) => h.id)).toEqual(['probe']);
  });
});

describe('LabelPlanner: sizes, hierarchy and discs', () => {
  const VW = 800, VH = 600;
  const plan = (fill: (p: LabelPlanner) => void) => {
    const p = new LabelPlanner();
    p.begin();
    fill(p);
    const n = p.plan(VW, VH);
    return p.out.slice(0, n).map((o) => ({ id: o.id, opacity: o.opacity }));
  };
  const idsOf = (r: { id: string }[]) => r.map((o) => o.id);

  it('among bodies the bigger disc ranks first, however far from the centre; equal sizes fall back on the hierarchy', () => {
    const r = plan((p) => {
      p.add('moon', 'MOON', 'body', 400, 300, 10, 1, 4, 2000);
      p.add('planet', 'PLANET', 'body', 700, 100, 10, 1, 30, 1000);
    });
    expect(idsOf(r)).toEqual(['planet', 'moon']);
    const tie = plan((p) => {
      p.add('moon', 'MOON', 'body', 400, 300, 10, 1, 10, 2000);
      p.add('planet', 'PLANET', 'body', 700, 100, 10, 1, 10.2, 1000);
    });
    expect(idsOf(tie)).toEqual(['planet', 'moon']);
  });

  it('a moon\'s label that would cover the planet\'s is dropped, the planet\'s kept', () => {
    const r = plan((p) => {
      p.add('moon', 'IO', 'body', 400, 300, 40, 1, 2, 2000); // the moon is nearer the centre
      p.add('planet', 'JUPITER', 'body', 340, 300, 70, 1, 60, 1000); // its label starts at 410
      p.addDisc('planet', 340, 300, 60);
    });
    expect(idsOf(r)).toEqual(['planet']);
  });

  it('probes rank after bodies: a probe label over a planet\'s label loses', () => {
    const r = plan((p) => {
      p.add('probe', 'LRO', 'featured', 520, 300, 9);
      p.add('moon', 'MOON', 'body', 500, 300, 20, 1, 5, 2000);
    });
    expect(idsOf(r)).toEqual(['moon']);
  });

  it('a label whose anchor is inside a larger body\'s disc is dropped; the selection and the hovered object are exempt', () => {
    const fill = (cls: 'featured' | 'selected' | 'hover') => (p: LabelPlanner) => {
      p.addDisc('planet', 300, 300, 80);
      p.add('probe', 'PROBE', cls, 330, 320, 9);
    };
    expect(idsOf(plan(fill('featured')))).toEqual([]);
    expect(idsOf(plan(fill('selected')))).toEqual(['probe']);
    expect(idsOf(plan(fill('hover')))).toEqual(['probe']);
  });

  it('outside the disc the label stays; a moon in front of the planet is dropped; the planet is not held to its own disc', () => {
    expect(idsOf(plan((p) => {
      p.addDisc('planet', 300, 300, 80);
      p.add('probe', 'PROBE', 'featured', 390, 300, 9);
    }))).toEqual(['probe']);
    expect(idsOf(plan((p) => {
      p.addDisc('planet', 300, 300, 80);
      p.addDisc('moon', 330, 300, 3);
      p.add('moon', 'MOON', 'body', 330, 300, 10, 1, 3, 2000);
      p.add('planet', 'PLANET', 'body', 300, 300, 87, 1, 80, 1000);
    }))).toEqual(['planet']);
  });

  it('a body of a smaller disc than the one it sits on is dropped; a larger one is not', () => {
    // the bigger disc is not held against the smaller one
    expect(idsOf(plan((p) => {
      p.addDisc('small', 300, 300, 10);
      p.addDisc('large', 305, 300, 30);
      p.add('large', 'LARGE', 'body', 305, 300, 37, 1, 30, 1000);
      p.add('small', 'SMALL', 'body', 300, 300, 17, 1, 10, 2000);
    }))).toEqual(['large']);
  });

  it('objects in front of a backdrop (a disc over 120 px, the Earth seen from low orbit) keep their labels', () => {
    expect(idsOf(plan((p) => {
      p.addDisc('earth', 400, 600, 500);
      p.add('iss', 'ISS', 'featured', 400, 300, 9);
    }))).toEqual(['iss']);
  });

  it('a moon\'s label fades in as it clears its parent\'s limb', () => {
    const at = (gap: number) => plan((p) => {
      p.addDisc('jupiter', 300, 300, 50);
      p.add('io', 'IO', 'body', 350 + gap, 300, 10, 1, 2, 2000, 'jupiter');
    });
    expect(at(MOON_SEP_MIN - 1)).toEqual([]);
    expect(at(MOON_SEP_MIN + (MOON_SEP_FULL - MOON_SEP_MIN) / 2)[0].opacity).toBeCloseTo(0.5, 5);
    expect(at(MOON_SEP_FULL)[0].opacity).toBe(1);
    expect(MOON_SEP_MIN).toBeGreaterThanOrEqual(2 * LABEL_H);
    // selected: always shown
    const sel = plan((p) => {
      p.addDisc('jupiter', 300, 300, 50);
      p.add('io', 'IO', 'selected', 355, 300, 10, 1, 2, 2000, 'jupiter');
    });
    expect(sel).toEqual([{ id: 'io', opacity: 1 }]);
  });
});
