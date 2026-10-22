import { describe, expect, it } from 'vitest';
import {
  EARTH, EntityGraph, defaultBodies, destinationPoint, profileToFixedSamples,
  type CompositeSegment, type EntityRecord, type ProviderSpec, type Sample, type Vec3,
} from '@eio/core';
import { SHELL_THRESHOLD_KM, shellRadius } from '../src/lib/deepspace';
import {
  FIXED_FRAME_MAX_WINDOW_MS, PATH_BUFFER_CAPACITY, PATH_MAX_POINTS, displayPosition, liftNearSurface, makePathBuffers,
  nowIndex, pathStale, planPathWindow, sampleTimes, samplePath,
} from '../src/lib/paths';
import { mockGroundAndProbes } from '../src/mock/generators';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const RE = EARTH.radiusKm;

/** Same shape as the server's demo booster: pad, sampled ascent in EARTH:fixed, relative landing arc, landed. */
function demoBooster(t0: number): { rec: EntityRecord; recs: EntityRecord[] } {
  const PAD = { latDeg: 28.6082, lonDeg: -80.6041 };
  const lz = destinationPoint(PAD.latDeg, PAD.lonDeg, 90, 8, RE);
  const padSpec: ProviderSpec = { type: 'geodetic', bodyId: 'EARTH', latDeg: PAD.latDeg, lonDeg: PAD.lonDeg, altKm: 0 };
  const lzSpec: ProviderSpec = { type: 'geodetic', bodyId: 'EARTH', latDeg: lz.latDeg, lonDeg: lz.lonDeg, altKm: 0 };
  const sec = (s: number) => s * 1000;
  const liftoff = t0 + sec(30), landingStart = t0 + sec(150), landed = t0 + sec(330);
  const rows = Array.from({ length: 25 }, (_, i) => {
    const s = i / 24;
    return { tSec: s * 120, altKm: 70 * s ** 1.6, downrangeKm: 40 * s ** 2.4 };
  });
  const landing: Sample[] = Array.from({ length: 37 }, (_, i) => {
    const s = i / 36;
    return [landingStart + s * sec(180), 32 * (1 - s) ** 1.5, 0, 70 * (1 - s) ** 2];
  });
  const segments: CompositeSegment[] = [
    { fromMs: t0, toMs: liftoff - 1, phase: 'pad', spec: padSpec },
    { fromMs: liftoff, toMs: landingStart - 1, phase: 'ascent', spec: { type: 'sampled', frame: 'EARTH:fixed', samples: profileToFixedSamples(defaultBodies.get('EARTH'), PAD, 90, liftoff, rows) } },
    { fromMs: landingStart, toMs: landed - 1, phase: 'landing', spec: { type: 'relative', parentId: 'demo-lz', mode: 'enu', samples: landing } },
    { fromMs: landed, toMs: t0 + 600_000 - 1, phase: 'landed', spec: lzSpec },
  ];
  const recs: EntityRecord[] = [
    { id: 'demo-lz', name: 'LZ', kind: 'pad', bodyId: 'EARTH', aliases: {}, provider: lzSpec, updatedAt: 0 },
    { id: 'demo-booster', name: 'Booster', kind: 'stage', bodyId: 'EARTH', aliases: {}, provider: { type: 'composite', segments }, updatedAt: 0 },
  ];
  return { rec: recs[1], recs };
}

function graphOf(recs: EntityRecord[]): EntityGraph {
  const g = new EntityGraph();
  recs.forEach((r) => g.upsert(r));
  return g;
}

describe('planPathWindow', () => {
  it('has no path for SGP4 (own orbit line), geodetic points or missing providers', () => {
    expect(planPathWindow(undefined, NOW)).toBeNull();
    expect(planPathWindow({ type: 'geodetic', bodyId: 'EARTH', latDeg: 0, lonDeg: 0, altKm: 0 }, NOW)).toBeNull();
    expect(planPathWindow({ type: 'sgp4', omm: {} as never }, NOW)).toBeNull();
  });

  it('draws a long ephemeris (Horizons probe) over its valid range inside -1 d .. +2 d', () => {
    const samples: Sample[] = [];
    for (let t = NOW - DAY; t <= NOW + 2 * DAY; t += 30 * MIN) samples.push([t, 1, 2, 3]);
    const plan = planPathWindow({ type: 'sampled', frame: 'EARTH:inertial', samples }, NOW)!;
    expect(plan.t0).toBe(NOW - DAY);
    expect(plan.t1).toBe(NOW + 2 * DAY);
    // a longer file is trimmed to the window
    const wide: Sample[] = [[NOW - 10 * DAY, 0, 0, 0], [NOW + 10 * DAY, 1, 1, 1]];
    const w = planPathWindow({ type: 'sampled', frame: 'EARTH:inertial', samples: wide }, NOW)!;
    expect([w.t0, w.t1]).toEqual([NOW - DAY, NOW + 2 * DAY]);
  });

  it('uses a short window around now for trajectory-scale samples, composites and relative providers', () => {
    const arc: Sample[] = [[NOW - 2 * MIN, 0, 0, 0], [NOW + 3 * HOUR, 1, 1, 1]];
    const s = planPathWindow({ type: 'sampled', frame: 'EARTH:fixed', samples: arc }, NOW, { trailSeconds: 240 })!;
    expect(s.t0).toBe(NOW - 2 * MIN); // clipped to the file
    expect(s.t1).toBe(NOW + 10 * MIN);
    const { rec } = demoBooster(NOW - 60_000);
    const c = planPathWindow(rec.provider, NOW, { trailSeconds: 120 })!;
    expect(c.t0).toBe(NOW - 60_000); // composite starts a minute ago
    expect(c.t1).toBe(NOW - 60_000 + 600_000 - 1);
    const r = planPathWindow({ type: 'relative', parentId: 'x', mode: 'enu', offsetKm: [0, 0, 0] }, NOW, { trailSeconds: 60 })!;
    expect([r.t0, r.t1]).toEqual([NOW - 3 * MIN, NOW + 3 * MIN]);
    // a longer trail hint widens the past
    const longTrail = planPathWindow({ type: 'relative', parentId: 'x', mode: 'enu', offsetKm: [0, 0, 0] }, NOW, { trailSeconds: 900 })!;
    expect(longTrail.t0).toBe(NOW - 15 * MIN);
  });

  it('draws a keplerian orbit as a quarter past and a full period ahead, and nothing outside the valid range', () => {
    const a = 12_000;
    const period = 2 * Math.PI * Math.sqrt(a ** 3 / EARTH.gm) * 1000;
    const p = planPathWindow({ type: 'keplerian', bodyId: 'EARTH', elements: { a, e: 0, i: 0, raan: 0, argp: 0, m0: 0, epochMs: NOW } }, NOW)!;
    expect(p.t1 - p.t0).toBeCloseTo(period * 1.25, -2);
    const gone = planPathWindow({ type: 'sampled', frame: 'EARTH:fixed', samples: [[NOW - 5 * DAY, 0, 0, 0], [NOW - 4 * DAY, 1, 0, 0]] }, NOW);
    expect(gone).toBeNull();
  });

  it('pathStale after the window slid by a tenth of its length', () => {
    const plan = { t0: NOW - 5 * MIN, t1: NOW + 10 * MIN };
    expect(pathStale(NOW, NOW + 60_000, plan)).toBe(false);
    expect(pathStale(NOW, NOW + 2 * MIN, plan)).toBe(true);
    expect(pathStale(NOW, NOW - 2 * MIN, plan)).toBe(true);
    expect(pathStale(NOW, NOW + 99 * MIN, null)).toBe(false);
  });
});

describe('sampleTimes', () => {
  it('is ascending, capped, and contains exact composite boundaries', () => {
    const { rec } = demoBooster(NOW - 100_000);
    const plan = planPathWindow(rec.provider, NOW)!;
    const t = sampleTimes(plan, rec.provider);
    expect(t.length).toBeLessThanOrEqual(PATH_MAX_POINTS + 20);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
    const spec = rec.provider as Extract<ProviderSpec, { type: 'composite' }>;
    for (const seg of spec.segments) if (seg.fromMs > plan.t0 && seg.fromMs < plan.t1) expect(t).toContain(seg.fromMs);
  });

  it('nowIndex finds the last sample not after t', () => {
    const times = [10, 20, 30, 40];
    expect(nowIndex(times, 4, 5)).toBe(-1);
    expect(nowIndex(times, 4, 10)).toBe(0);
    expect(nowIndex(times, 4, 35)).toBe(2);
    expect(nowIndex(times, 4, 99)).toBe(3);
  });
});

describe('samplePath: composite booster in EARTH:fixed (real-server data shape)', () => {
  const t0 = NOW - 60_000;
  const { rec, recs } = demoBooster(t0);
  const graph = graphOf(recs);
  const plan = planPathWindow(rec.provider, NOW, { trailSeconds: 120 })!;
  const buf = makePathBuffers();
  const res = samplePath(graph, rec.id, plan, rec.provider, buf);

  it('is drawn in the body-fixed frame (rides the rotating Earth), within the point cap', () => {
    expect(res.frame).toBe('fixed');
    expect(res.moving).toBe(true);
    expect(res.compressed).toBe(false);
    expect(res.count).toBeGreaterThan(100);
    expect(res.count).toBeLessThanOrEqual(PATH_BUFFER_CAPACITY);
  });

  it('starts on the pad and ends at the landing zone, apex ~70 km up, all in display space', () => {
    const pos = (i: number): Vec3 => [buf.pos[i * 3], buf.pos[i * 3 + 1], buf.pos[i * 3 + 2]];
    const radius = (i: number) => Math.hypot(...pos(i));
    // first point: pad phase (lifted ~12 km), last: landed
    expect(radius(0) - RE).toBeGreaterThan(5);
    expect(radius(0) - RE).toBeLessThan(40);
    let maxAlt = 0;
    for (let i = 0; i < res.count; i++) maxAlt = Math.max(maxAlt, radius(i) - RE * (1 - EARTH.flattening * (pos(i)[2] / radius(i)) ** 2));
    expect(maxAlt).toBeGreaterThan(70);
    expect(maxAlt).toBeLessThan(90);
    const first = pos(0), last = pos(res.count - 1);
    const dEnd = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]);
    expect(dEnd).toBeGreaterThan(6); // LZ is 8 km east of the pad
    expect(dEnd).toBeLessThan(12);
  });

  it('the current position lies on the path (marker on the line)', () => {
    const now = graph.stateIn(rec.id, NOW, 'EARTH:fixed')!;
    const lifted = liftNearSurface(now.r);
    const i = nowIndex(buf.times, res.count, NOW);
    expect(i).toBeGreaterThanOrEqual(0);
    const d = Math.hypot(buf.pos[i * 3] - lifted[0], buf.pos[i * 3 + 1] - lifted[1], buf.pos[i * 3 + 2] - lifted[2]);
    expect(d).toBeLessThan(2.5); // within one sample step (a couple of seconds of flight)
  });

  it('reports phase boundaries with the composite phase names, on exact points', () => {
    expect(res.phases.map((p) => p.name)).toEqual(['ascent', 'landing', 'landed']);
    for (const p of res.phases) expect(buf.times[p.index]).toBe(p.tMs);
  });

  it('does not draw a streak for a booster standing still on its pad', () => {
    // window entirely inside the "landed" phase
    const landedAt = t0 + 330_000;
    const quiet = samplePath(graph, rec.id, { t0: landedAt + 10_000, t1: landedAt + 200_000 }, rec.provider, makePathBuffers());
    expect(quiet.frame).toBe('fixed');
    expect(quiet.moving).toBe(false);
  });

  it('falls back to the inertial frame for long windows (the Earth turns too far)', () => {
    const long = samplePath(graph, rec.id, { t0: plan.t0, t1: plan.t0 + FIXED_FRAME_MAX_WINDOW_MS + 60_000 }, rec.provider, makePathBuffers());
    expect(long.frame).toBe('inertial');
  });
});

describe('samplePath: mock data', () => {
  const recs = mockGroundAndProbes(NOW);
  const graph = graphOf(recs);
  const get = (id: string) => recs.find((r) => r.id === id)!;

  it('mock demo booster (plain sampled arc) is drawn fixed, with the arc apex', () => {
    const rec = get('demo-booster');
    const plan = planPathWindow(rec.provider, NOW, { trailSeconds: rec.render?.trailSeconds })!;
    const res = samplePath(graph, rec.id, plan, rec.provider, makePathBuffers());
    expect(res.frame).toBe('fixed');
    expect(res.moving).toBe(true);
    expect(res.phases).toEqual([]);
  });

  it('Voyager 1 path stays on the compressed shell, same as its marker', () => {
    const rec = get('dsn-VGR1');
    const plan = planPathWindow(rec.provider, NOW)!;
    const buf = makePathBuffers();
    const res = samplePath(graph, rec.id, plan, rec.provider, buf);
    expect(res.frame).toBe('inertial');
    expect(res.compressed).toBe(true);
    const marker = displayPosition(graph.stateIn(rec.id, NOW, 'EARTH:inertial')!.r).r;
    const i = nowIndex(buf.times, res.count, NOW);
    expect(Math.hypot(buf.pos[i * 3] - marker[0], buf.pos[i * 3 + 1] - marker[1], buf.pos[i * 3 + 2] - marker[2])).toBeLessThan(5e3);
    for (let k = 0; k < res.count; k++) {
      const r = Math.hypot(buf.pos[k * 3], buf.pos[k * 3 + 1], buf.pos[k * 3 + 2]);
      expect(r).toBeGreaterThan(SHELL_THRESHOLD_KM);
      expect(r).toBeLessThan(shellRadius(3e10));
    }
  });

  it('MRO (Mars orbiter seen from Earth) draws a visible arc across the shell', () => {
    const rec = get('dsn-MRO');
    const plan = planPathWindow(rec.provider, NOW)!;
    const res = samplePath(graph, rec.id, plan, rec.provider, makePathBuffers());
    expect(res.compressed).toBe(true);
    expect(res.moving).toBe(true);
    expect(res.count).toBeGreaterThan(300);
  });

  it('JWST near-Earth (1.5e6 km, below the shell threshold) is not compressed', () => {
    const rec = get('dsn-JWST');
    const plan = planPathWindow(rec.provider, NOW)!;
    const res = samplePath(graph, rec.id, plan, rec.provider, makePathBuffers());
    expect(res.compressed).toBe(false);
    expect(res.moving).toBe(true);
  });

  it('returns an empty path when the provider has no state in the window', () => {
    const g = new EntityGraph();
    const res = samplePath(g, 'nope', { t0: NOW, t1: NOW + MIN }, undefined, makePathBuffers());
    expect(res.count).toBe(0);
    expect(res.moving).toBe(false);
  });
});

describe('display position', () => {
  it('lifts a surface point by the marker nudge and leaves higher points alone', () => {
    const lifted = liftNearSurface([RE, 0, 0]);
    expect(lifted[0] - RE).toBeCloseTo(12, 6);
    expect(liftNearSurface([RE + 400, 0, 0])).toEqual([RE + 400, 0, 0]);
    expect(displayPosition([3e6, 0, 0]).compressed).toBe(true);
    expect(displayPosition([RE + 400, 0, 0]).compressed).toBe(false);
  });
});
