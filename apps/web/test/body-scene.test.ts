import { describe, expect, it } from 'vitest';
import { bodyEntityRecords } from '@eio/core';
import { bodyLineAllowed, bodyLineIds, bodyPickExtras, gatherWithBodies, type BodyPickContext, type DrawnBody } from '../src/lib/body-scene';
import { EARTH_CENTRE } from '../src/lib/frame';
import type { PickExtra, PickSource } from '../src/lib/pick';

const recs = bodyEntityRecords();
const rec = (id: string) => recs.find((r) => r.id === id)!;
const base = { selectedId: null, focusBodyId: null, frame: EARTH_CENTRE };

describe('body orbit lines', () => {
  it('the Moon always, the Earth in both scales, Mars only in the true scale, the Sun never', () => {
    for (const scale of ['compressed', 'true'] as const) {
      expect(bodyLineAllowed(rec('body-moon'), scale)).toBe(true);
      expect(bodyLineAllowed(rec('body-sun'), scale)).toBe(false);
    }
    expect(bodyLineAllowed(rec('body-earth'), 'compressed')).toBe(true); // drawn scaled about the Earth (EntityOverlay.buildOrbit)
    expect(bodyLineAllowed(rec('body-mars'), 'compressed')).toBe(false);
    expect(bodyLineAllowed(rec('body-earth'), 'true')).toBe(true);
    expect(bodyLineAllowed(rec('body-mars'), 'true')).toBe(true);
  });

  it('is false for a record that is not a body or asks for no line', () => {
    const sat = { bodyId: 'EARTH', provider: { type: 'geodetic' as const, lat: 0, lon: 0, alt: 0 }, render: { orbitLine: true } };
    expect(bodyLineAllowed(sat as never, 'true')).toBe(false);
    expect(bodyLineAllowed({ ...rec('body-moon'), render: { label: true } }, 'true')).toBe(false);
  });

  it('draws the line of the selected, the camera-centred and the frame-centre body', () => {
    expect(bodyLineIds(recs, { ...base, scale: 'compressed' })).toEqual([]);
    expect(bodyLineIds(recs, { ...base, selectedId: 'body-moon', scale: 'compressed' })).toEqual(['body-moon']);
    expect(bodyLineIds(recs, { ...base, focusBodyId: 'MOON', scale: 'compressed' })).toEqual(['body-moon']);
    expect(bodyLineIds(recs, { ...base, frame: { kind: 'body', id: 'MOON' }, scale: 'true' })).toEqual(['body-moon']);
    // the Earth frame is the default: it draws nothing by itself
    expect(bodyLineIds(recs, { ...base, scale: 'true' })).toEqual([]);
  });

  it('hides the Mars line in the compressed scale and shows it in the true scale, the Earth line in both', () => {
    expect(bodyLineIds(recs, { ...base, selectedId: 'body-mars', scale: 'compressed' })).toEqual([]);
    expect(bodyLineIds(recs, { ...base, selectedId: 'body-mars', scale: 'true' })).toEqual(['body-mars']);
    expect(bodyLineIds(recs, { ...base, selectedId: 'body-earth', focusBodyId: 'EARTH', scale: 'compressed' })).toContain('body-earth');
    expect(bodyLineIds(recs, { ...base, selectedId: 'body-earth', focusBodyId: 'EARTH', scale: 'true' })).toContain('body-earth');
  });

  it('adds the direct children of the selected body, whatever the frame and the lock', () => {
    const ids = (selectedId: string | null, scale: 'compressed' | 'true', frame = EARTH_CENTRE) => bodyLineIds(recs, { selectedId, focusBodyId: null, frame, scale }).sort();
    // the Earth: its own line (around the Sun) and the Moon's (around the Earth), in the default frame
    expect(ids('body-earth', 'true')).toEqual(['body-earth', 'body-moon']);
    expect(ids('body-earth', 'compressed')).toEqual(['body-earth', 'body-moon']);
    // the Sun: Earth and Mars in the true scale, only the Earth in the compressed one; the Sun has no line of its own
    expect(ids('body-sun', 'true')).toEqual(['body-earth', 'body-mars']);
    expect(ids('body-sun', 'compressed')).toEqual(['body-earth']);
    // a leaf: its own line only; Mars has no children
    expect(ids('body-moon', 'true')).toEqual(['body-moon']);
    expect(ids('body-mars', 'true')).toEqual(['body-mars']);
    // the frame changes nothing about the selection's lines
    for (const frame of [{ kind: 'body', id: 'SUN' }, { kind: 'body', id: 'MOON' }, { kind: 'entity', id: 'sat-25544' }] as const) {
      expect(ids('body-earth', 'true', frame)).toContain('body-earth');
      expect(ids('body-earth', 'true', frame)).toContain('body-moon');
    }
    // no grandchildren: the Sun's selection does not draw the Moon
    expect(ids('body-sun', 'true')).not.toContain('body-moon');
    // nothing selected: no children
    expect(ids(null, 'true')).toEqual([]);
  });

  it('a selected object that is not a body adds no body lines', () => {
    expect(bodyLineIds(recs, { ...base, selectedId: 'sat-25544', scale: 'true' })).toEqual([]);
  });

  it('ignores records that are not body entities', () => {
    const sat = { id: 'sat', bodyId: 'EARTH', render: { orbitLine: true } };
    expect(bodyLineIds([sat as never], { ...base, selectedId: 'sat', scale: 'true' })).toEqual([]);
  });
});

// A camera at `x0` on the x axis looking along +x, z up, 60 degree field of view, 200 x 200 px (the screen centre is 100, 100).
const F = 1 / Math.tan(Math.PI / 6);
const PROJ = new Float32Array([0, 0, -1, 1, -F, 0, 0, 0, 0, F, 0, 0, 0, 0, -0.02, 0]);
const ctx = (x0: number, px = 100, py = 100): BodyPickContext => ({ origin: [x0, 0, 0], m: PROJ, w: 200, h: 200, px, py, fovDeg: 60 });
/** screen px of a point `y` km to the left of the axis, `x` km ahead of the camera */
const pxAt = (x: number, y: number) => (-F * y / x) * 0.5 * 200 + 100;
const body = (bodyId: string, c: [number, number, number], radiusKm: number, k = 1): DrawnBody => ({ entityId: `body-${bodyId.toLowerCase()}`, bodyId, c, radiusKm, k });
const earth = body('EARTH', [0, 0, 0], 6378.137);

describe('bodyPickExtras', () => {
  it('picks the Earth on its disc and not far outside it', () => {
    expect(bodyPickExtras([earth], ctx(-20000)).map((e) => e.id)).toEqual(['body-earth']);
    // the disc edge is ~6378/sqrt(20000^2 - 6378^2) * 173 px = 60 px from the centre; 120 px off is a miss
    expect(bodyPickExtras([earth], ctx(-20000, 220))).toEqual([]);
    expect(bodyPickExtras([earth], ctx(-20000, 100 + 50))).toHaveLength(1);
  });

  it('gives no ranks and no occlusion callback data (the helper decides occlusion itself)', () => {
    const [e] = bodyPickExtras([earth], ctx(-20000));
    expect(e.rank).toBeUndefined();
    expect(e.rel).toBeUndefined();
  });

  it('a body is not hidden by its own sphere, with the camera close to it', () => {
    const moon = body('MOON', [384_400, 0, 0], 1737.4);
    expect(bodyPickExtras([moon], ctx(384_400 - 5000)).map((e) => e.id)).toEqual(['body-moon']);
  });

  it('the Moon behind the Earth is dropped, beside it is kept', () => {
    const behind = body('MOON', [384_400, 0, 0], 1737.4);
    expect(bodyPickExtras([earth, behind], ctx(-20000)).map((e) => e.id)).toEqual(['body-earth']);
    // seen from far off the Earth-Moon line the Moon is a separate dot: cursor on it
    const side = body('MOON', [0, 384_400, 0], 1737.4);
    const far = ctx(-1_000_000, pxAt(1_000_000, 384_400));
    expect(bodyPickExtras([earth, side], far).map((e) => e.id)).toEqual(['body-moon']);
  });

  it('a body hidden behind another body (Mars behind the Sun) is dropped, the nearer one is kept', () => {
    const sun = body('SUN', [1.5e8, 0, 0], 695_700, 0.02);
    const mars = body('MARS', [3e8, 0, 0], 3389.5, 0.02);
    // the displayed Sun is 13,914 km across at 1.5e8 km: Mars straight behind it is covered
    const ids = bodyPickExtras([sun, mars], ctx(-1000)).map((e) => e.id);
    expect(ids).toEqual(['body-sun']);
  });

  it('uses the displayed radius (true radius times k) for the hit area', () => {
    const sun = body('SUN', [1e6, 0, 0], 695_700, 1);
    const small = body('SUN', [1e6, 0, 0], 695_700, 0.02);
    // 70 px off the axis: inside the full-size disc (168 px), outside the shrunk one (which is the 14 px floor)
    const off = ctx(0, 170, 100);
    expect(bodyPickExtras([sun], off)).toHaveLength(1);
    expect(bodyPickExtras([small], off)).toHaveLength(0);
  });
});

describe('gatherWithBodies', () => {
  // identity projection: ndc = (x, y); the cursor is at the screen centre
  const M = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const sat: PickSource = {
    ids: ['sat'], rel: new Float32Array([0.04, 0, 0]), world: new Float32Array([7000, 0, 0]), size: new Float32Array([4]), show: new Float32Array([1]), bias: 0,
  };
  const earthExtra: PickExtra = { id: 'body-earth', d2: 1 };
  const moonExtra: PickExtra = { id: 'body-moon', d2: 36 };
  const opts = { max: 12, wantTotal: true, occluded: () => false };
  const run = (src: PickSource[], bodies: PickExtra[]) => gatherWithBodies(src, [], () => bodies, M, 200, 200, 100, 100, opts);

  it('a satellite under the cursor wins over the Earth disc it is drawn over, and no popup list appears', () => {
    const r = run([sat], [earthExtra]);
    expect(r.items.map((h) => h.id)).toEqual(['sat']);
    expect(r.total).toBe(1);
  });

  it('with nothing else under the cursor the bodies are the candidates, nearest first', () => {
    expect(run([], [moonExtra, earthExtra]).items.map((h) => h.id)).toEqual(['body-earth', 'body-moon']);
  });

  it('does not compute the body extras when an object was found', () => {
    let called = false;
    const r = gatherWithBodies([sat], [], () => ((called = true), [earthExtra]), M, 200, 200, 100, 100, opts);
    expect(r.items).toHaveLength(1);
    expect(called).toBe(false);
  });

  it('finds nothing when there is neither', () => {
    expect(run([], []).items).toEqual([]);
  });

  // two satellites 4 and 6 px from the cursor, drawn over the Earth's disc
  const two: PickSource = {
    ids: ['old', 'new'], rel: new Float32Array([0.04, 0, 0, 0, 0.06, 0]), world: new Float32Array([7000, 0, 0, 7000, 0, 0]),
    size: new Float32Array([4, 4]), show: new Float32Array([1, 1]), bias: 0,
  };
  const earthAt = (discPx: number): PickExtra => ({ id: 'body-earth', d2: 1, discPx });
  const withMeta = { ...opts, ranks: new Map([['body-earth', 1000], ['old', 1e6 + 2], ['new', 1e6 + 2]]), created: new Map([['old', 1], ['new', 2]]) };

  it('zoomed in (big Earth disc) a click on overlapping satellites lists only them, newest first; the Earth is not in the list', () => {
    const r = gatherWithBodies([two], [], () => [earthAt(250)], M, 200, 200, 100, 100, withMeta);
    expect(r.items.map((h) => h.id)).toEqual(['new', 'old']);
    expect(r.grouped).toEqual([]);
    expect(r.total).toBe(2);
  });

  it('zoomed out (small Earth disc) the satellites collapse into the Earth and wait behind the "+ N objects" entry', () => {
    const r = gatherWithBodies([two], [], () => [earthAt(20)], M, 200, 200, 100, 100, withMeta);
    expect(r.items.map((h) => h.id)).toEqual(['body-earth']);
    expect(r.grouped.map((h) => h.id)).toEqual(['new', 'old']);
    expect(r.groupedTotal).toBe(2);
  });

  it('a single satellite over a small Earth is still selected, and the body lookup is skipped', () => {
    let called = false;
    const r = gatherWithBodies([sat], [], () => ((called = true), [earthAt(20)]), M, 200, 200, 100, 100, withMeta);
    expect(r.items.map((h) => h.id)).toEqual(['sat']);
    expect(called).toBe(false);
  });

  it('hover (nearestFirst) names the nearest satellite zoomed in and the body when grouped', () => {
    const hover = { ...withMeta, max: 1, wantTotal: false, nearestFirst: true };
    expect(gatherWithBodies([two], [], () => [earthAt(250)], M, 200, 200, 100, 100, hover).items.map((h) => h.id)).toEqual(['old']);
    expect(gatherWithBodies([two], [], () => [earthAt(20)], M, 200, 200, 100, 100, hover).items.map((h) => h.id)).toEqual(['body-earth']);
  });

  it('bodies under the cursor list in hierarchy order, not by distance', () => {
    const moonNear: PickExtra = { id: 'body-moon', d2: 1, discPx: 3 };
    const earthFar: PickExtra = { id: 'body-earth', d2: 100, discPx: 3 };
    const r = gatherWithBodies([], [], () => [moonNear, earthFar], M, 200, 200, 100, 100, { ...opts, ranks: new Map([['body-earth', 1000], ['body-moon', 2000]]) });
    expect(r.items.map((h) => h.id)).toEqual(['body-earth', 'body-moon']);
  });
});
