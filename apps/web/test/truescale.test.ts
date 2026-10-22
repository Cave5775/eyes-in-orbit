import { describe, expect, it } from 'vitest';
import { EARTH, EntityGraph, norm, type EntityRecord, type Sample, type Vec3 } from '@eio/core';
import {
  MAX_DIST_KM, MAX_DIST_TRUE_KM, fitDistance, fitDistanceClamped, maxDistKm, settleDistance, zoomDistance, boundingSphere,
} from '../src/lib/camera';
import { SHELL_THRESHOLD_KM, shellRadius } from '../src/lib/deepspace';
import { displayPosition, makePathBuffers, nowIndex, planPathWindow, samplePath } from '../src/lib/paths';
import { toCameraRelative, spinOf } from '../src/lib/floating-origin';
import { inScope, scopeRadius } from '../src/lib/scope';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const DAY = 86_400_000, MIN = 60_000;
const RE = EARTH.radiusKm;
const VGR: Vec3 = [-1.0e10, 2.2e10, 0.6e10];

describe('display position by distance scale', () => {
  it('compressed moves far objects onto the shell, true scale leaves them where they are', () => {
    const c = displayPosition(VGR, 'compressed');
    expect(c.compressed).toBe(true);
    expect(norm(c.r)).toBeLessThan(shellRadius(3e10) + 1);
    const t = displayPosition(VGR, 'true');
    expect(t.compressed).toBe(false);
    expect(t.r).toEqual(VGR);
  });

  it('true scale changes nothing near Earth (identity beyond the ground nudge)', () => {
    for (const r of [[RE + 400, 0, 0], [0, 4.2e4, 0], [3.8e5, 1e5, 0], [1.9e6, 0, 0]] as Vec3[]) {
      expect(displayPosition(r, 'true').r).toEqual(displayPosition(r, 'compressed').r);
    }
  });

  it('the default scale is compressed', () => {
    expect(displayPosition([3e6, 0, 0]).compressed).toBe(true);
  });
});

describe('paths at true scale', () => {
  const samples: Sample[] = [];
  const dir = VGR.map((c) => c / norm(VGR)) as Vec3;
  for (let t = NOW - DAY; t <= NOW + 2 * DAY; t += 30 * MIN) samples.push([t, ...(dir.map((c) => c * (2.5e10 + 17 * ((t - NOW) / 1000))) as Vec3)]);
  const rec: EntityRecord = {
    id: 'dsn-VGR1', name: 'Voyager 1', kind: 'probe', bodyId: 'EARTH', aliases: {},
    provider: { type: 'sampled', frame: 'EARTH:inertial', samples }, updatedAt: NOW,
  };
  const graph = new EntityGraph();
  graph.upsert(rec);
  const plan = planPathWindow(rec.provider, NOW)!;

  it('draws the path at the real distance, and flags it compressed only in the compressed mode', () => {
    const buf = makePathBuffers();
    const res = samplePath(graph, rec.id, plan, rec.provider, buf, 'true');
    expect(res.compressed).toBe(false);
    expect(res.count).toBeGreaterThan(100);
    for (let k = 0; k < res.count; k++) {
      const r = Math.hypot(buf.pos[k * 3], buf.pos[k * 3 + 1], buf.pos[k * 3 + 2]);
      expect(r).toBeGreaterThan(2.4e10);
      expect(r).toBeLessThan(2.6e10);
    }
    const compressed = samplePath(graph, rec.id, plan, rec.provider, makePathBuffers());
    expect(compressed.compressed).toBe(true);
  });

  it('matches the marker (same display position at "now") and spans the real 3-day travel', () => {
    const buf = makePathBuffers();
    const res = samplePath(graph, rec.id, plan, rec.provider, buf, 'true');
    const marker = displayPosition(graph.stateIn(rec.id, NOW, 'EARTH:inertial')!.r, 'true').r;
    const i = nowIndex(buf.times, res.count, NOW);
    expect(Math.hypot(buf.pos[i * 3] - marker[0], buf.pos[i * 3 + 1] - marker[1], buf.pos[i * 3 + 2] - marker[2])).toBeLessThan(2.5e5);
    const first = [buf.pos[0], buf.pos[1], buf.pos[2]], last = [buf.pos[(res.count - 1) * 3], buf.pos[(res.count - 1) * 3 + 1], buf.pos[(res.count - 1) * 3 + 2]];
    const span = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]);
    expect(span).toBeGreaterThan(17 * 3 * 86400 * 0.95); // 17 km/s over ~3 days
    expect(span).toBeLessThan(17 * 3 * 86400 * 1.05);
    expect(res.moving).toBe(true);
  });
});

describe('camera limits at true scale', () => {
  it('zoom-out limit: 3e7 km compressed, 1e11 km true', () => {
    expect(maxDistKm('compressed')).toBe(MAX_DIST_KM);
    expect(maxDistKm('true')).toBe(MAX_DIST_TRUE_KM);
    expect(MAX_DIST_TRUE_KM).toBeGreaterThan(3e10);
  });

  it('wheel zoom around a probe 2.5e10 km out steps in proportion to the distance to it, up to the limit', () => {
    const alt = 2.5e10; // height above the Earth: huge, so the step falls back to the target distance
    const opts = { minDist: 0.2, maxDist: MAX_DIST_TRUE_KM };
    const d = zoomDistance(1e9, 0.9, alt, opts);
    expect(d).toBeCloseTo(0.9e9, -3);
    expect(zoomDistance(9e10, 2, alt, opts)).toBe(MAX_DIST_TRUE_KM);
    // the compressed limit would have refused to go that far
    expect(zoomDistance(1e9, 100, alt, { minDist: 0.2, maxDist: MAX_DIST_KM })).toBe(MAX_DIST_KM);
    // and the near clamp is unchanged
    expect(zoomDistance(0.25, 0.1, alt, opts)).toBe(0.2);
  });

  it('FIT of everything out to Voyager (2.5e10 km) gets a distance that fits and is within the limit', () => {
    const pts = [0, 0, 0, ...VGR];
    const { r } = boundingSphere(pts);
    const dist = fitDistanceClamped(r, 45, 1.3, 1.3, 0.2, 'true');
    expect(dist).toBeGreaterThan(fitDistance(r, 45, 1.3, 1) * 0.99);
    expect(dist).toBeLessThanOrEqual(MAX_DIST_TRUE_KM);
    expect(dist).toBeGreaterThan(3e7);
    // the same request in compressed mode is capped at 3e7 km
    expect(fitDistanceClamped(r, 45, 1.3, 1.3, 0.2, 'compressed')).toBe(MAX_DIST_KM);
    // a tiny set keeps the minimum
    expect(fitDistanceClamped(0, 45, 1.3, 1.3, 0.2, 'true')).toBe(0.2);
  });

  it('a fly-to for a probe at true distance settles at a distance within the zoom limit', () => {
    expect(settleDistance(2.5e10)).toBeLessThan(MAX_DIST_TRUE_KM);
    expect(settleDistance(2.5e10)).toBeCloseTo(2.5e10 * 0.45, 0);
    expect(settleDistance(7000)).toBe(3200);
    expect(settleDistance(1e6)).toBeCloseTo(6e5, 3);
  });
});

describe('precision far from the origin', () => {
  it('rebasing keeps ~metre accuracy for points 1,000 km from a camera parked at Voyager', () => {
    const origin: [number, number, number] = [-1.0e10 + 0.123456789, 2.2e10 - 0.987654321, 0.6e10];
    const world = new Float64Array([origin[0] + 1000.25, origin[1] - 333.5, origin[2] + 5]);
    const out = new Float32Array(3);
    toCameraRelative(world, out, 1, origin, spinOf(0), false);
    expect(out[0]).toBeCloseTo(1000.25, 3);
    expect(out[1]).toBeCloseTo(-333.5, 3);
    expect(out[2]).toBeCloseTo(5, 3);
    // a float32 world position at this distance is ~1,000 km coarse
    let worst = 0;
    for (let i = 0; i < 50; i++) worst = Math.max(worst, Math.abs(Math.fround(origin[0] + i * 37.3) - (origin[0] + i * 37.3)));
    expect(worst).toBeGreaterThan(100);
  });
});

describe('scope and true scale', () => {
  it('a camera pulled back far enough to see a probe at true scale keeps it in scope', () => {
    expect(inScope({ d: 2.5e10, key: 0, bulk: false, keep: false }, scopeRadius(1.1e10))).toBe(true);
    expect(inScope({ d: 2.5e10, key: 0, bulk: false, keep: false }, scopeRadius(24_000))).toBe(false);
    expect(SHELL_THRESHOLD_KM).toBe(2e6);
  });
});
