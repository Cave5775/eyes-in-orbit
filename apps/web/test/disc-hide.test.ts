import { describe, expect, it } from 'vitest';
import { GROUP_SLOTS, discGroups, hiddenByDisc, offGroup, type GroupBody } from '../src/lib/disc-hide';
import { BODY_MIN_HIT_PX, GROUP_DISC_PX, bodyDiscRadiusPx, bodyHitRadiusPx, bodyPickExtra } from '../src/lib/pick';

// 60 degree vertical field of view, 600 px viewport: 519.6 px focal length. The camera sits at the origin looking along +x.
const FOV = 60, VP = 600;
const FOCAL = VP / (2 * Math.tan((FOV * Math.PI) / 360));
const F = 1 / Math.tan(Math.PI / 6);
const PROJ = new Float32Array([0, 0, -1, 1, -F, 0, 0, 0, 0, F, 0, 0, 0, 0, -0.02, 0]);
const px = (x: number, y: number) => (-F * y / x) * 0.5 * VP + VP / 2; // screen x of a point at (x, y, 0)

const R_EARTH = 6378.137, R_MOON = 1737.4;
const earthAt = (dist: number): GroupBody => ({ rel: [dist, 0, 0], radiusKm: R_EARTH, k: 1 });
/** distance at which the Earth's disc has radius `disc` px */
const distForDisc = (disc: number) => R_EARTH * Math.sqrt(1 + (FOCAL / disc) ** 2);
const groups = (...bodies: GroupBody[]) => discGroups(bodies, FOV, VP);

describe('discGroups', () => {
  it('always returns GROUP_SLOTS entries; unused slots are off', () => {
    const g = groups(earthAt(100_000));
    expect(g).toHaveLength(GROUP_SLOTS);
    expect(g[0].sinR).toBeLessThan(1);
    expect(g.slice(1).every((s) => s.sinR > 1)).toBe(true);
    expect(discGroups([], FOV, VP).every((s) => s.sinR > 1)).toBe(true);
    // more bodies than slots: the extra ones are dropped, not wrapped
    expect(discGroups(Array.from({ length: 7 }, () => earthAt(100_000)), FOV, VP)).toHaveLength(GROUP_SLOTS);
  });

  it('holds the unit direction, the distance and the sine of the pick hit radius', () => {
    const [g] = discGroups([{ rel: [0, 60_000, 80_000], radiusKm: R_EARTH, k: 1 }], FOV, VP);
    expect(g.dist).toBeCloseTo(100_000, 6);
    expect(Math.hypot(g.x, g.y, g.z)).toBeCloseTo(1, 12);
    expect(g.y).toBeCloseTo(0.6, 12);
    const hitPx = bodyHitRadiusPx(R_EARTH, 1, 100_000, FOV, VP);
    expect(g.sinR).toBeCloseTo(hitPx / Math.hypot(hitPx, FOCAL), 12);
  });

  it('switches on exactly when the disc radius is at most GROUP_DISC_PX', () => {
    const d = distForDisc(GROUP_DISC_PX);
    expect(bodyDiscRadiusPx(R_EARTH, 1, d, FOV, VP)).toBeCloseTo(GROUP_DISC_PX, 6);
    expect(groups(earthAt(d * 1.001))[0].sinR).toBeLessThan(1); // a hair farther: 39.96 px, on
    expect(groups(earthAt(d * 0.999))[0].sinR).toBeGreaterThan(1); // a hair nearer: 40.04 px, off
    expect(groups(earthAt(60_000))[0].sinR).toBeGreaterThan(1); // zoomed in
    // a custom limit
    expect(discGroups([earthAt(60_000)], FOV, VP, 100)[0].sinR).toBeLessThan(1);
  });

  it('is off with the camera inside the sphere or on its centre', () => {
    expect(groups(earthAt(5000))[0].sinR).toBeGreaterThan(1);
    expect(groups({ rel: [0, 0, 0], radiusKm: R_EARTH, k: 1 })[0].sinR).toBeGreaterThan(1);
  });

  it('uses the displayed radius (radius times k): a Sun shrunk by k is a small disc, and the 14 px floor applies', () => {
    const sun: GroupBody = { rel: [1.5e8, 0, 0], radiusKm: 695_700, k: 0.02 };
    const [g] = groups(sun);
    expect(g.sinR).toBeCloseTo(BODY_MIN_HIT_PX / Math.hypot(BODY_MIN_HIT_PX, FOCAL), 9);
    const moon: GroupBody = { rel: [384_400, 0, 0], radiusKm: R_MOON, k: 1 };
    expect(groups(moon)[0].sinR).toBeCloseTo(BODY_MIN_HIT_PX / Math.hypot(BODY_MIN_HIT_PX, FOCAL), 9); // disc 2.3 px + 3 < 14
  });
});

describe('hiddenByDisc', () => {
  const g = groups(earthAt(100_000)); // disc 33 px, hit radius 36 px
  const hitPx = bodyHitRadiusPx(R_EARTH, 1, 100_000, FOV, VP);
  /** lateral offset (km) at depth x that is `s` px from the body's centre on screen */
  const lateral = (x: number, s: number) => (s / FOCAL) * x;

  it('hides a point in front of the body inside the cone and not one outside it', () => {
    expect(hiddenByDisc(50_000, 0, 0, g)).toBe(true); // straight in front
    expect(hiddenByDisc(50_000, lateral(50_000, hitPx - 2), 0, g)).toBe(true);
    expect(hiddenByDisc(50_000, lateral(50_000, hitPx + 2), 0, g)).toBe(false);
    expect(hiddenByDisc(50_000, 0, -lateral(50_000, hitPx - 2), g)).toBe(true); // any side
    expect(hiddenByDisc(50_000, 0, lateral(50_000, hitPx + 2), g)).toBe(false);
  });

  it('the cone is the pick hit radius (disc + 3 px), wider than the disc itself', () => {
    const disc = bodyDiscRadiusPx(R_EARTH, 1, 100_000, FOV, VP);
    expect(hitPx).toBeCloseTo(disc + 3, 9);
    expect(hiddenByDisc(60_000, lateral(60_000, disc + 1.5), 0, g)).toBe(true); // in the 3 px margin
  });

  it('only hides what is in front of the body: a point behind it (or at its depth and beyond) stays', () => {
    expect(hiddenByDisc(99_000, 0, 0, g)).toBe(true);
    expect(hiddenByDisc(101_000, 0, 0, g)).toBe(false);
    expect(hiddenByDisc(200_000, 100, 0, g)).toBe(false);
  });

  it('a point behind the camera or at the camera is never hidden', () => {
    expect(hiddenByDisc(-50_000, 0, 0, g)).toBe(false);
    expect(hiddenByDisc(0, 0, 0, g)).toBe(false);
  });

  it('is false when every slot is off (zoomed in)', () => {
    const off = groups(earthAt(60_000));
    expect(hiddenByDisc(30_000, 0, 0, off)).toBe(false);
    expect(hiddenByDisc(30_000, 0, 0, [offGroup()])).toBe(false);
  });

  it('checks every slot: a Moon dot hides what is over it though the Earth cone is off', () => {
    const moon: GroupBody = { rel: [0, 384_400, 0], radiusKm: R_MOON, k: 1 };
    const both = groups(earthAt(60_000), moon);
    expect(both[0].sinR).toBeGreaterThan(1);
    expect(hiddenByDisc(1000, 900, 0, both)).toBe(false); // elsewhere on the sky
    expect(hiddenByDisc(0, 100_000, 0, both)).toBe(true); // between the camera and the Moon, on its line of sight
    expect(hiddenByDisc(0, 500_000, 0, both)).toBe(false); // behind it
  });

  it('agrees with the pick: a point is hidden exactly when a click on it lands within the body hit radius', () => {
    const body = earthAt(100_000);
    const pick = (cursorPx: number) => bodyPickExtra({
      id: 'body-earth', rel: [100_000, 0, 0], radiusKm: R_EARTH, k: 1, fovDeg: FOV, m: PROJ, w: VP, h: VP, px: cursorPx, py: VP / 2,
    });
    const gs = groups(body);
    for (const s of [0, 5, 20, hitPx - 1, hitPx + 1, hitPx + 10, 120]) {
      for (const x of [20_000, 70_000]) {
        const y = lateral(x, s);
        expect(hiddenByDisc(x, y, 0, gs), `${s} px at ${x} km`).toBe(pick(px(x, y)) !== null);
      }
    }
  });

  it('the Moon floor: a satellite 10 px from a far Moon dot is hidden, 20 px is not', () => {
    const gs = groups({ rel: [384_400, 0, 0], radiusKm: R_MOON, k: 1 });
    expect(hiddenByDisc(10_000, lateral(10_000, 10), 0, gs)).toBe(true);
    expect(hiddenByDisc(10_000, lateral(10_000, 20), 0, gs)).toBe(false);
  });
});
