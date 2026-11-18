import { describe, expect, it } from 'vitest';
import {
  AU_KM, OrbitBuilder, SUN, keplerFromDegrees, keplerState, orbitAt, precessDir, readContainer, readMpcorb, DEG, type MpcOrbit, type UnpackedOrbits,
} from '@eio/core';
import {
  CELL_ERROR_KM, CELL_FAR_KM, CELL_NEAR_KM, JUMP_MS, MIN_RERUN_MS, cellDrawCount, eclipticToDate, orbitPosition, pickBelt, pickedOrbit, pointLook,
  propagateBelt, rerunDue, sphereInCone,
} from '../src/lib/minor-planets';
import { MPCORB_HEAD } from '../../../packages/core/test/fixtures/mpcorb-head';

async function fixtureOrbits(): Promise<UnpackedOrbits> {
  const b = new OrbitBuilder();
  await readMpcorb(MPCORB_HEAD.split('\n'), b);
  return readContainer(b.finish({ skipped: 0 }));
}

/** deterministic synthetic orbits (not data: a stress set for the maths and the timing) */
export function syntheticOrbits(n: number, seed = 1, far = 0): UnpackedOrbits {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const b = new OrbitBuilder();
  for (let i = 0; i < n; i++) {
    const isFar = i < far;
    const o: MpcOrbit = {
      packed: String(i % 99999 + 1).padStart(5, '0'), h: 3 + rnd() * 22, epochMs: Date.UTC(2020 + Math.floor(rnd() * 6), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28)),
      m0Deg: rnd() * 360, argpDeg: rnd() * 360, nodeDeg: rnd() * 360, incDeg: rnd() * 30, e: rnd() * 0.35, aAu: isFar ? 30 + rnd() * 20 : 1.3 + rnd() * 4.2,
    };
    b.add(o);
  }
  return readContainer(b.finish({ skipped: 0 }));
}

const T = Date.UTC(2026, 10, 18, 12);

describe('propagateBelt agrees with core keplerState', () => {
  it('real orbits: anchor + offset is keplerState (ecliptic elements rotated to the equator) precessed to the date, within the float32 step', async () => {
    const u = await fixtureOrbits();
    for (const t of [T, T + 3 * 365.25 * 86_400_000, T - 400 * 86_400_000]) {
      const r = propagateBelt([u], t);
      expect(r.cells.reduce((a, c) => a + c.count, 0)).toBe(u.count);
      for (const cell of r.cells) {
        for (let s = cell.start; s < cell.start + cell.count; s++) {
          const o = orbitAt(u, r.index[s]);
          const k = keplerFromDegrees(o.aAu, o.e, o.incDeg, o.nodeDeg, o.argpDeg, o.m0Deg, o.epochMs);
          const want = precessDir(keplerState(k, SUN.gm, t).r, t, false);
          const got = [cell.ax + r.offsets[s * 3], cell.ay + r.offsets[s * 3 + 1], cell.az + r.offsets[s * 3 + 2]];
          expect(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2])).toBeLessThan(CELL_ERROR_KM * 2 + 1);
        }
      }
    }
  });

  it('orbitPosition is float64-exact against keplerState (1e-3 km at 4e8 km)', async () => {
    const u = await fixtureOrbits();
    const tm = eclipticToDate(T);
    for (let i = 0; i < u.count; i++) {
      const o = orbitAt(u, i);
      const k = keplerFromDegrees(o.aAu, o.e, o.incDeg, o.nodeDeg, o.argpDeg, o.m0Deg, o.epochMs);
      const want = precessDir(keplerState(k, SUN.gm, T).r, T, false);
      const got = orbitPosition(u, i, T, tm);
      expect(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2])).toBeLessThan(1e-3);
    }
  });
});

describe('cells (the floating origin)', () => {
  const u = syntheticOrbits(30_000, 7, 300);

  it('every point is within the stated float32 granularity of its float64 position', () => {
    const r = propagateBelt([u], T);
    const tm = eclipticToDate(T);
    let nearMax = 0, farMax = 0, offMax = 0;
    for (const cell of r.cells) {
      const far = cell.radiusKm > CELL_NEAR_KM;
      for (let s = cell.start; s < cell.start + cell.count; s++) {
        const p = orbitPosition(u, r.index[s], T, tm);
        const dx = cell.ax + r.offsets[s * 3] - p[0], dy = cell.ay + r.offsets[s * 3 + 1] - p[1], dz = cell.az + r.offsets[s * 3 + 2] - p[2];
        const err = Math.hypot(dx, dy, dz);
        if (far) farMax = Math.max(farMax, err); else nearMax = Math.max(nearMax, err);
        offMax = Math.max(offMax, Math.abs(r.offsets[s * 3]), Math.abs(r.offsets[s * 3 + 1]), Math.abs(r.offsets[s * 3 + 2]));
        // inside its cell
        expect(Math.abs(p[0] - cell.ax)).toBeLessThanOrEqual((far ? CELL_FAR_KM : CELL_NEAR_KM) / 2 + 1);
      }
    }
    // half a float32 step per axis, three axes: sqrt(3) * 4 km near, sqrt(3) * 32 km far
    expect(nearMax).toBeLessThanOrEqual(CELL_ERROR_KM * Math.sqrt(3));
    expect(farMax).toBeLessThanOrEqual(CELL_ERROR_KM * 8 * Math.sqrt(3));
    expect(offMax).toBeLessThanOrEqual(CELL_FAR_KM / 2 + 1);
    expect(r.cells.some((c) => c.radiusKm > CELL_NEAR_KM)).toBe(true);
  });

  it('keeps the file order (brightest first) inside a cell and owns contiguous slots', () => {
    const r = propagateBelt([u], T);
    let at = 0;
    for (const c of r.cells) {
      expect(c.start).toBe(at);
      at += c.count;
      for (let s = c.start + 1; s < c.start + c.count; s++) expect(r.index[s]).toBeGreaterThan(r.index[s - 1]);
    }
    expect(at).toBe(u.count);
    expect(new Set(r.index).size).toBe(u.count);
    // within a cell H is non-decreasing because the container is sorted
    for (const c of r.cells) for (let s = c.start + 1; s < c.start + c.count; s++) expect(r.h[s]).toBeGreaterThanOrEqual(r.h[s - 1]);
    expect(r.cells.length).toBeLessThan(1500); // one draw call each
  });

  it('the camera-relative offset (anchor - camera in float64, plus the float32 offset) keeps metres near a point 1 AU from the origin', () => {
    const r = propagateBelt([u], T);
    const c = r.cells[0];
    const s = c.start;
    const exact = [c.ax + r.offsets[s * 3], c.ay + r.offsets[s * 3 + 1], c.az + r.offsets[s * 3 + 2]];
    // camera 100 km from the point (float64): the cell uniform is a float32, the offset a float32
    const cam = [exact[0] + 100, exact[1], exact[2]];
    const uni = [Math.fround(c.ax - cam[0]), Math.fround(c.ay - cam[1]), Math.fround(c.az - cam[2])];
    const rel = [uni[0] + r.offsets[s * 3], uni[1] + r.offsets[s * 3 + 1], uni[2] + r.offsets[s * 3 + 2]];
    // the point is at -100 km on x: the cell uniform's float32 rounding (< 8 km at 1.5e8) is the whole error
    expect(Math.abs(rel[0] + 100)).toBeLessThan(CELL_ERROR_KM * 4);
  });
});

describe('level of detail and culling', () => {
  it('draws everything inside the cell sphere, a share of the brightest when it is small on screen, nothing for none', () => {
    const px = 965;
    expect(cellDrawCount(5000, CELL_NEAR_KM, CELL_NEAR_KM * 0.5, px)).toBe(5000);
    const far = cellDrawCount(50_000, CELL_NEAR_KM, 10 * AU_KM, px);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(50_000);
    expect(cellDrawCount(50_000, CELL_NEAR_KM, 2 * AU_KM, px)).toBeGreaterThan(far);
    expect(cellDrawCount(50_000, CELL_NEAR_KM, 100 * AU_KM, px)).toBeLessThan(far);
    expect(cellDrawCount(0, CELL_NEAR_KM, AU_KM, px)).toBe(0);
  });
  it('a sphere outside the view cone is culled', () => {
    expect(sphereInCone([0, 0, 1e8], 1e6, [0, 0, 1], 0.4)).toBe(true);
    expect(sphereInCone([1e8, 0, 0], 1e6, [0, 0, 1], 0.4)).toBe(false);
    expect(sphereInCone([0, 0, -1e8], 1e6, [0, 0, 1], 0.4)).toBe(false);
    expect(sphereInCone([1e6, 0, 0], 2e6, [0, 0, 1], 0.1)).toBe(true);
  });
  it('size and brightness follow H and are clamped to 1-2 px', () => {
    expect(pointLook(100 * (5 + 10))).toEqual({ px: 2, alpha: 1 });
    expect(pointLook(100 * (30 + 10))).toEqual({ px: 1, alpha: 0.35 });
    expect(pointLook(65535).px).toBe(1);
    const mid = pointLook(100 * (14.5 + 10));
    expect(mid.px).toBeCloseTo(1.5, 5);
    expect(mid.alpha).toBeGreaterThan(0.35);
  });
});

describe('when to run again', () => {
  const base = { simMs: T, atMs: T, nearestKm: 1e8, fovRad: 45 * DEG, viewportPx: 800, sinceLastMs: 1e6, running: false };
  it('runs first, never while running, and rarely at 1x real time with the belt in view', () => {
    expect(rerunDue({ ...base, atMs: null })).toBe('first');
    expect(rerunDue({ ...base, atMs: null, running: true })).toBeNull();
    expect(rerunDue(base)).toBeNull();
    // pixel = 1e8 * 0.785 / 800 = 98 000 km; half of it at 30 km/s is 1630 s
    expect(rerunDue({ ...base, simMs: T + 600_000 })).toBeNull();
    expect(rerunDue({ ...base, simMs: T + 2_000_000 })).toBe('drift');
  });
  it('a close camera wants new positions sooner, but not within the minimum interval', () => {
    const near = { ...base, nearestKm: 1e5, simMs: T + 20_000 };
    expect(rerunDue(near)).toBe('drift');
    expect(rerunDue({ ...near, sinceLastMs: MIN_RERUN_MS - 1 })).toBeNull();
  });
  it('a jump of the clock reruns at once', () => {
    expect(rerunDue({ ...base, simMs: T + JUMP_MS + 1, sinceLastMs: 0 })).toBe('jump');
    expect(rerunDue({ ...base, simMs: T - 5 * JUMP_MS, sinceLastMs: 0 })).toBe('jump');
  });
});

describe('picking', () => {
  it('finds the point nearest to the ray, in a drawn cell only, and not one that is hidden', () => {
    const cells = [{ ax: 0, ay: 0, az: 0, start: 0, count: 3, radiusKm: 1e6 }, { ax: 0, ay: 0, az: 0, start: 3, count: 1, radiusKm: 1e6 }];
    // camera-relative cell origins; the point offsets are in km
    const offsets = new Float32Array([0, 0, 0, 1000, 0, 0, -5000, 0, 0, 0, 10, 0]);
    const rel = [0, 0, 1e7, 0, 0, 1e7];
    const base = { cells, offsets, rel, dir: [0, 0, 1] as [number, number, number], tan: 1e-3 };
    expect(pickBelt({ ...base, drawn: [3, 1] })).toMatchObject({ slot: 0 });
    // the first point is nearest to the ray (angle 0); the one at slot 3 is only 10 km off but the second cell has to be drawn
    expect(pickBelt({ ...base, drawn: [3, 1], offsets: new Float32Array([500, 0, 0, 1000, 0, 0, -5000, 0, 0, 0, 10, 0]) }).slot).toBe(3);
    expect(pickBelt({ ...base, drawn: [3, 0], offsets: new Float32Array([500, 0, 0, 1000, 0, 0, -5000, 0, 0, 0, 10, 0]) }).slot).toBe(0);
    expect(pickBelt({ ...base, drawn: [1, 0], hidden: () => true }).slot).toBe(-1);
    expect(pickBelt({ ...base, drawn: [3, 1], dir: [1, 0, 0] }).slot).toBe(-1);
    // a cell behind the camera is skipped whole
    expect(pickBelt({ ...base, drawn: [3, 1], rel: [0, 0, -1e7, 0, 0, -1e7] }).slot).toBe(-1);
  });
});

describe('pickedOrbit', () => {
  it('gives the designation, H, the epoch and elements that reproduce the stored orbit', async () => {
    const u = await fixtureOrbits();
    const p = pickedOrbit(u, 0);
    expect(p.designation).toBe('4');
    expect(p.h).toBeCloseTo(3.25, 2);
    expect(p.epochMs).toBe(Date.UTC(2026, 5, 9));
    expect(p.elements.a / AU_KM).toBeCloseTo(2.3613660, 5);
  });
});

describe('time and size of a pass (synthetic orbits, Node)', () => {
  it('propagates and bins 200,000 orbits (the 1.4 million of MPCORB scale linearly)', () => {
    const u = syntheticOrbits(200_000, 3, 2000);
    const r = propagateBelt([u], T);
    expect(r.offsets.length).toBe(600_000);
    // not an assertion on speed (machine dependent): the number is reported in docs/reference.md
    expect(r.ms).toBeGreaterThan(0);
  }, 60_000);
});
