import { describe, expect, it } from 'vitest';
import {
  HEADING_RELAX, POLE_ZONE_FAR, advanceSurfaceFrame, basisFromUp, ellipsoidUp, type SurfaceFrame, type V3,
} from '../src/lib/camera';

const DEG = Math.PI / 180;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const upAt = (latDeg: number, lonDeg: number): V3 => {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  return ellipsoidUp([Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]);
};
const angle = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

/** Heading change of a step: the angle between the previous east axis carried to the new place and the new east axis. */
function turn(prev: { e: V3; u: V3 }, next: { e: V3; u: V3 }): number {
  const k = dot(prev.e, next.u);
  const t: V3 = [prev.e[0] - k * next.u[0], prev.e[1] - k * next.u[1], prev.e[2] - k * next.u[2]];
  const n = len(t);
  const c = dot([t[0] / n, t[1] / n, t[2] / n], next.e);
  const s = dot(cross([t[0] / n, t[1] / n, t[2] / n], next.e), next.u);
  return Math.abs(Math.atan2(s, c));
}

/** Walk the places in order, return the worst heading change over its step, with the frames. */
function walk(places: V3[], advance = advanceSurfaceFrame, check = true): { worst: number; worstStep: number; frames: SurfaceFrame[] } {
  const frames: SurfaceFrame[] = [];
  let prev: SurfaceFrame | null = null;
  let worst = 0, worstStep = 0;
  for (const up of places) {
    const f = advance(prev, up);
    if (prev) {
      const step = angle(prev.u, f.u);
      const t = turn(prev, f);
      if (t > worst) worst = t;
      if (step > 0 && t / step > worstStep) worstStep = t / step;
      // every step is at most a small multiple of the distance moved
      if (check) expect(t).toBeLessThanOrEqual(HEADING_RELAX * step + 1e-9);
    }
    frames.push(f);
    prev = f;
  }
  return { worst, worstStep, frames };
}

/** The old north-up frame as a "frame advancer", to show what the new one fixes. */
const northUp = (_prev: SurfaceFrame | null, up: V3): SurfaceFrame => ({ ...basisFromUp(up), psi: 0 });

/** Places along a meridian great circle through the pole: from latitude `from` up and over to the other side. */
function overThePole(from: number, stepDeg: number, lon: number, south = false): V3[] {
  const out: V3[] = [];
  const total = 2 * (90 - from);
  const sgn = south ? -1 : 1;
  for (let d = 0; d <= total + 1e-9; d += stepDeg) {
    const lat = from + d;
    out.push(lat <= 90 ? upAt(sgn * lat, lon) : upAt(sgn * (180 - lat), lon + 180));
  }
  return out;
}

describe('surface frame', () => {
  it('starts north-up and keeps an orthonormal east/north/up', () => {
    const up = upAt(40, 20);
    const f = advanceSurfaceFrame(null, up);
    const b = basisFromUp(up);
    expect(f.psi).toBeCloseTo(0, 9);
    for (let i = 0; i < 3; i++) {
      expect(f.e[i]).toBeCloseTo(b.e[i], 12);
      expect(f.n[i]).toBeCloseTo(b.n[i], 12);
      expect(f.u[i]).toBeCloseTo(b.u[i], 12);
    }
    const { frames } = walk(overThePole(60, 0.2, 10));
    for (const g of frames) {
      expect(len(g.e)).toBeCloseTo(1, 9);
      expect(dot(g.e, g.u)).toBeCloseTo(0, 9);
      expect(g.n[0]).toBeCloseTo(cross(g.u, g.e)[0], 9);
      expect(g.n[2]).toBeCloseTo(cross(g.u, g.e)[2], 9);
    }
  });

  it('is exactly north-up for normal movement away from the poles', () => {
    // an orbit at 51.6 degrees inclination, a full circle of longitude, plus a drive along latitude 70
    for (const lat of [0, 30, 51.6, 70, -51.6, -70]) {
      let prev: SurfaceFrame | null = null;
      for (let lon = 0; lon <= 720; lon += 2) {
        const up = upAt(lat, lon);
        const f = advanceSurfaceFrame(prev, up);
        const b = basisFromUp(up);
        expect(f.psi).toBeCloseTo(0, 9);
        expect(angle(f.e, b.e)).toBeLessThan(1e-6);
        prev = f;
      }
    }
    // a ground track that rises and falls in latitude
    let prev: SurfaceFrame | null = null;
    for (let i = 0; i <= 360; i++) {
      const up = upAt(51.6 * Math.sin(i * DEG), i * 4);
      const f = advanceSurfaceFrame(prev, up);
      expect(angle(f.e, basisFromUp(up).e)).toBeLessThan(1e-6);
      prev = f;
    }
  });

  it('does not turn faster than it travels over the north pole, including exactly on it', () => {
    const places = overThePole(85, 0.05, 30);
    expect(places.some((p) => Math.abs(p[2]) > 0.99999999)).toBe(true); // a sample sits on the pole
    const r = walk(places);
    expect(r.worstStep).toBeLessThanOrEqual(HEADING_RELAX + 1e-6);
    expect(r.worstStep).toBeLessThan(3.1); // a small factor of the step
    // the plain north-up frame turns by half a revolution in one step there
    const old = walk(places, northUp as typeof advanceSurfaceFrame, false);
    expect(old.worst).toBeGreaterThan(1);
  });

  it('does the same over the south pole', () => {
    const places = overThePole(85, 0.05, -120, true);
    expect(places.some((p) => Math.abs(p[2]) > 0.99999999)).toBe(true);
    expect(walk(places).worstStep).toBeLessThanOrEqual(HEADING_RELAX + 1e-6);
    expect(walk(places, northUp as typeof advanceSurfaceFrame, false).worst).toBeGreaterThan(1);
  });

  it('is continuous on passes beside the pole and circles around it', () => {
    // a pass 0.05, 0.5 and 3 degrees from the pole, at coarse and fine steps
    for (const miss of [0.05, 0.5, 3]) {
      for (const stepDeg of [0.02, 0.5, 2]) {
        const places: V3[] = [];
        // straight-ish line past the pole: the great circle at colatitude `miss` from the pole at its closest
        for (let d = -30; d <= 30; d += stepDeg) {
          const x = Math.tan(d * DEG), y = Math.tan(miss * DEG);
          const v: V3 = [x, y, 1];
          const n = len(v);
          places.push(upAt(Math.asin(v[2] / n) / DEG, Math.atan2(v[1], v[0]) / DEG));
        }
        const r = walk(places);
        expect(r.worstStep).toBeLessThanOrEqual(HEADING_RELAX + 1e-6);
      }
    }
    // a full circle around the pole 2 degrees away, in 1 degree longitude steps: 2*pi of north-up spin that is not followed
    const circle: V3[] = [];
    for (let lon = 0; lon <= 720; lon += 1) circle.push(upAt(88, lon));
    const c = walk(circle);
    expect(c.worstStep).toBeLessThanOrEqual(HEADING_RELAX + 1e-6);
    expect(walk(circle, northUp as typeof advanceSurfaceFrame, false).worstStep).toBeGreaterThan(20);
  });

  it('never turns by more than HEADING_RELAX times the distance moved, whatever the random path', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let run = 0; run < 20; run++) {
      const places: V3[] = [];
      let lat = (rnd() - 0.5) * 20 + (run % 2 ? 85 : -85), lon = rnd() * 360;
      for (let i = 0; i < 300; i++) {
        const bear = rnd() * 2 * Math.PI, d = rnd() * 3 * DEG;
        // small step on the sphere at the current place
        const la = lat * DEG, lo = lon * DEG;
        const u: V3 = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
        const e: V3 = [-Math.sin(lo), Math.cos(lo), 0];
        const n = cross(u, e);
        const dir: V3 = [Math.cos(bear) * e[0] + Math.sin(bear) * n[0], Math.cos(bear) * e[1] + Math.sin(bear) * n[1], Math.cos(bear) * e[2] + Math.sin(bear) * n[2]];
        const q: V3 = [u[0] * Math.cos(d) + dir[0] * Math.sin(d), u[1] * Math.cos(d) + dir[1] * Math.sin(d), u[2] * Math.cos(d) + dir[2] * Math.sin(d)];
        lat = Math.asin(q[2]) / DEG;
        lon = Math.atan2(q[1], q[0]) / DEG;
        places.push(upAt(lat, lon));
      }
      walk(places); // asserts every step inside
    }
  });

  it('returns to north-up on the way away from the pole, in proportion to the distance travelled', () => {
    const pass = walk(overThePole(80, 0.1, 40)).frames;
    const last = pass[pass.length - 1];
    expect(Math.abs(last.psi)).toBeGreaterThan(Math.PI - 0.3); // carried across: east is now west of the north-up frame
    // keep going along the meridian down to 40 degrees, then along the equator: the turn winds back monotonically
    let f = last;
    let prevAbs = Math.abs(f.psi);
    let travelled = 0;
    let lat = 80;
    for (; lat > -80; lat -= 0.25) {
      const n = advanceSurfaceFrame(f, upAt(lat, 220));
      travelled += angle(f.u, n.u);
      expect(Math.abs(n.psi)).toBeLessThanOrEqual(prevAbs + 1e-12);
      prevAbs = Math.abs(n.psi);
      f = n;
      if (lat < 90 - (POLE_ZONE_FAR / DEG) - 5 && lat > 0) {
        // outside the polar zone it winds back by HEADING_RELAX per radian
        expect(prevAbs).toBeLessThan(Math.PI - 1e-3);
      }
    }
    expect(travelled).toBeGreaterThan(2);
    for (let lon = 220; Math.abs(f.psi) > 0 && lon < 220 + 2000; lon += 2) f = advanceSurfaceFrame(f, upAt(0, lon));
    expect(f.psi).toBeCloseTo(0, 9);
    expect(angle(f.e, basisFromUp(f.u).e)).toBeLessThan(1e-6);
  });

  it('keeps the turn while sitting over a pole and does not drift when nothing moves', () => {
    let f = advanceSurfaceFrame(null, upAt(89.9, 10));
    for (let i = 0; i < 100; i++) f = advanceSurfaceFrame(f, upAt(89.9, 10));
    expect(f.psi).toBeCloseTo(0, 9);
    const g = advanceSurfaceFrame(advanceSurfaceFrame(null, upAt(60, 0)), upAt(60, 0));
    expect(g.psi).toBeCloseTo(0, 9);
    // a frame carried across the pole and then left alone far from it keeps its heading
    const across = walk(overThePole(80, 0.5, 0)).frames;
    let h = across[across.length - 1];
    const before = h.e;
    for (let i = 0; i < 50; i++) h = advanceSurfaceFrame(h, h.u);
    expect(angle(h.e, before)).toBeLessThan(1e-9);
  });

  it('restarts north-up after a jump to another place', () => {
    const a = advanceSurfaceFrame(null, upAt(10, 0));
    const far = upAt(70, 120);
    const b = advanceSurfaceFrame(a, far);
    expect(b.psi).toBeCloseTo(0, 9);
    expect(angle(b.e, basisFromUp(far).e)).toBeLessThan(1e-6);
    // bad input does not poison the state
    const c = advanceSurfaceFrame(a, [NaN, 0, 1]);
    expect(Number.isFinite(c.e[0])).toBe(true);
  });
});
