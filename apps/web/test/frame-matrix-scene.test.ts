import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EntityGraph, bodyEntityRecords, type EntityRecord, type Sample } from '@eio/core';
import { planPathWindow } from '../src/lib/paths';
import { mockLaunches } from '../src/mock/generators';
import { PathOverlay } from '../src/scene/PathOverlay';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const MIN = 60_000;

/** A probe-like sampled centre that only has data from `from` to `to` (ms), in the Earth frame, 100 000 km out. */
function centreWithRange(id: string, from: number, to: number): EntityRecord {
  const samples: Sample[] = [];
  for (let t = from; t <= to; t += MIN) samples.push([t, 1e5 + (t - from) * 1e-3, 5e4, 2e4, 0.1, 0.2, 0.05]);
  return { id, name: id, kind: 'probe', bodyId: 'EARTH', aliases: {}, provider: { type: 'sampled', frame: 'EARTH:inertial', samples }, updatedAt: 0 };
}

describe('the selected path in a frame whose centre gains a state later', () => {
  const { entities } = mockLaunches(NOW);
  const booster = entities.find((e) => e.kind === 'stage')!;
  const t0 = planPathWindow(booster.provider, NOW, {})!.t0; // liftoff: the anchored flight window starts here (the pad hold before it is not drawn)
  const centre = centreWithRange('probe-c', t0 + 5 * MIN, t0 + 60 * MIN);

  function overlay() {
    const g = new EntityGraph();
    for (const r of [...bodyEntityRecords(undefined, NOW), booster, centre]) g.upsert(r);
    const po = new PathOverlay(new THREE.Group(), new THREE.PointsMaterial(), new THREE.Color(0xffffff));
    let wall = 0;
    return { po, update: (t: number) => po.update(g, booster, t, (wall += 1000), false, centre.id) };
  }

  it('is drawn once the centre has a position: an anchored flight is not rebuilt by the clock, so the centre arriving must rebuild it', () => {
    const { update } = overlay();
    expect(update(t0 + MIN).active).toBe(false); // the centre has no state yet: nothing can be drawn relative to it
    expect(update(t0 + 6 * MIN).active).toBe(true); // ... and now it has
  });

  it('is drawn when the clock is seeked into the centre data and hidden again when it is seeked out of it', () => {
    const { update } = overlay();
    expect(update(t0 + 10 * MIN).active).toBe(true);
    expect(update(t0 + 3 * 60 * MIN).active).toBe(false);
    expect(update(t0 + 10 * MIN).active).toBe(true);
  });
});
