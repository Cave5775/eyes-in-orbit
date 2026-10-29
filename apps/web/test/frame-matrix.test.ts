import { describe, expect, it } from 'vitest';
import { EntityGraph, bodyEntityRecords, norm, type EntityRecord, type Vec3 } from '@eio/core';
import {
  EARTH_CENTRE, centrePositionEci, centreStateEci, distanceFromCentre, entityRelativeToCentre, frameForRec, framePathPoint, frameSampler, graphLookup,
} from '../src/lib/frame';
import { makePathBuffers, planPathWindow, samplePath } from '../src/lib/paths';
import { computeTelemetry } from '../src/lib/telemetry';
import { mockGroundAndProbes, mockLaunches, mockSatellites } from '../src/mock/generators';

/**
 * The frame matrix: every kind of object the mock catalogue has as the frame CENTRE, at every kind of time, checked against the
 * invariants of a frame (docs/frames.md): the centre is at the origin of its own frame, a path sample is r(t_i) - c(t_i) + c(ref),
 * readouts are |r - c| and |v - v_c|, nothing is NaN. The graph is built the way the scene builds the main-thread one: every
 * non-SGP4 entity, the bodies, and an SGP4 entity only once something put it there (the centre, `ensureCentreInGraph`).
 */
const NOW = Date.parse('2026-10-22T12:00:00Z');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const sats = mockSatellites(NOW);
const { entities: launchEntities } = mockLaunches(NOW);
const everything: EntityRecord[] = [...bodyEntityRecords(undefined, NOW), ...sats, ...launchEntities, ...mockGroundAndProbes(NOW)];
const byId = new Map(everything.map((r) => [r.id, r]));
const isSgp4 = (r: EntityRecord): boolean => r.provider?.type === 'sgp4';

/** The scene's main-thread graph: no SGP4 entity unless listed in `with`. */
function sceneGraph(withIds: string[] = []): EntityGraph {
  const g = new EntityGraph();
  for (const r of everything) if (!isSgp4(r) || withIds.includes(r.id)) g.upsert(r);
  return g;
}

const flying = launchEntities.find((r) => r.kind === 'launch_vehicle' && r.provider?.type === 'composite' && r.phase === 'ACTIVE_ASCENT')
  ?? launchEntities.find((r) => r.kind === 'launch_vehicle' && r.provider?.type === 'composite')!;
const OBJECTS: Record<string, string> = {
  Sun: 'body-sun', Earth: 'body-earth', Moon: 'body-moon', Mars: 'body-mars',
  'ISS (SGP4)': 'sat-25544', 'LRO (Moon orbiter)': 'dsn-LRO', 'MRO (Mars orbiter)': 'dsn-MRO', Voyager: 'dsn-VGR1', JWST: 'dsn-JWST',
  'launch vehicle': flying.id, booster: `${flying.id}-booster`, payload: `${flying.id}-payload`, 'ground station': 'dsn-madrid',
};
const TIMES: Record<string, number> = {
  now: NOW, '+1 min': NOW + MIN, '-1 min': NOW - MIN, '+10 min': NOW + 10 * MIN, '+2 h': NOW + 2 * HOUR, '+1 day': NOW + DAY, '-1 day': NOW - DAY,
  '+30 days': NOW + 30 * DAY,
};

const finite = (v: readonly number[] | undefined | null): boolean => !!v && v.every(Number.isFinite);

describe('frame matrix: every object as the centre', () => {
  for (const [label, id] of Object.entries(OBJECTS)) {
    const rec = byId.get(id);
    describe(label, () => {
      it('exists in the mock catalogue', () => {
        expect(rec, id).toBeDefined();
      });
      if (!rec) return;
      const g = sceneGraph(isSgp4(rec) ? [id] : []);
      const lookup = graphLookup(g);
      const range = g.provider(id)?.validRange;
      for (const [tl, t] of Object.entries(TIMES)) {
        const covered = !range || (t >= range[0] && t <= range[1]);
        it(`@${tl}: ${covered ? 'a position, finite, and 0 relative to itself' : 'no position outside its data range (never NaN)'}`, () => {
          const c = centrePositionEci(id, t, lookup);
          if (!covered) {
            expect(c).toBeNull();
            return;
          }
          expect(finite(c)).toBe(true);
          const self = entityRelativeToCentre(id, id, t, lookup)!;
          expect(norm(self.r)).toBe(0);
        });
      }
      it('another object seen from it: path samples are r - c(t_i) + c(ref); readouts are |r - c|, |v - vc|', () => {
        const other = id === 'dsn-JWST' ? byId.get('dsn-LRO')! : byId.get('dsn-JWST')!;
        const g2 = sceneGraph(isSgp4(rec) ? [id] : []);
        const lk = graphLookup(g2);
        const t = NOW;
        const plan = planPathWindow(other.provider, t, { validRange: g2.provider(other.id)?.validRange });
        expect(plan).not.toBeNull();
        const buf = makePathBuffers();
        const sampler = frameSampler(id, t, lk)!;
        const res = samplePath(g2, other.id, plan!, other.provider, buf, sampler);
        const ref = centrePositionEci(id, t, lk)!;
        expect(res.count).toBeGreaterThan(2);
        for (let i = 0; i < res.count; i += 7) {
          const ts = buf.times[i];
          const s = g2.stateIn(other.id, ts, 'EARTH:inertial')!;
          const c = centrePositionEci(id, ts, lk)!;
          const want = framePathPoint(s.r, c, ref);
          const got = [buf.pos[i * 3], buf.pos[i * 3 + 1], buf.pos[i * 3 + 2]] as Vec3;
          expect(norm([got[0] - want[0], got[1] - want[1], got[2] - want[2]])).toBeLessThan(0.05);
        }
        const tel = computeTelemetry(g2, other, t, id);
        const so = g2.stateIn(other.id, t, 'EARTH:inertial')!, sc = centreStateEci(id, t, lk)!;
        if (id !== 'body-earth') expect(tel!.refRangeKm).toBeCloseTo(norm([so.r[0] - sc.r[0], so.r[1] - sc.r[1], so.r[2] - sc.r[2]]), 3);
      });
    });
  }
});

describe('frameForRec: nothing is drawn relative to itself', () => {
  it('the centre object is drawn in its primary body frame; a body entity in its parent frame', () => {
    expect(frameForRec('dsn-LRO', byId.get('dsn-LRO')!)).toBe('body-moon');
    expect(frameForRec('dsn-LRO', byId.get('dsn-MRO')!)).toBe('dsn-LRO');
    expect(frameForRec('body-sun', byId.get('body-moon')!)).toBe('body-earth');
    expect(EARTH_CENTRE).toBe('body-earth');
  });
});

describe('the HUD distance is from the frame centre, not from the camera target', () => {
  it('a camera 3 000 km from the selection and 10 000 km from the locked centre reads 10 000 km', () => {
    expect(distanceFromCentre([10_000, 0, 0], [0, 0, 0], 3_000)).toBe(10_000);
    expect(distanceFromCentre([1000, 2000, 2000], [1000, 2000, 5000], 77)).toBe(3000);
  });
  it('keeps the target distance while the centre has no position', () => {
    expect(distanceFromCentre([1, 2, 3], null, 42)).toBe(42);
  });
});

describe('an object that stands still on the Earth moves in any other frame', () => {
  const gs = byId.get('dsn-madrid')!;
  const g = sceneGraph();
  const lk = graphLookup(g);
  it('has no path in the Earth frame and a window of its own in a framed one', () => {
    expect(planPathWindow(gs.provider, NOW, {})).toBeNull();
    const plan = planPathWindow(gs.provider, NOW, { framed: true });
    expect(plan).not.toBeNull();
    expect(plan!.t0).toBeLessThan(NOW);
    expect(plan!.t1).toBeGreaterThan(NOW);
  });
  it('is sampled as r - c(t_i) + c(ref) round the Moon, a curve of thousands of km', () => {
    const plan = planPathWindow(gs.provider, NOW, { framed: true })!;
    const buf = makePathBuffers();
    const res = samplePath(g, gs.id, plan, gs.provider, buf, frameSampler('body-moon', NOW, lk));
    expect(res.count).toBeGreaterThan(50);
    expect(res.moving).toBe(true);
    const ref = centrePositionEci('body-moon', NOW, lk)!;
    for (let i = 0; i < res.count; i += 13) {
      const s = g.stateIn(gs.id, buf.times[i], 'EARTH:inertial')!;
      const want = framePathPoint(s.r, centrePositionEci('body-moon', buf.times[i], lk)!, ref);
      expect(norm([buf.pos[i * 3] - want[0], buf.pos[i * 3 + 1] - want[1], buf.pos[i * 3 + 2] - want[2]])).toBeLessThan(0.05);
    }
  });
});
