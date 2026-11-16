import { describe, expect, it } from 'vitest';
import { EntityGraph, bodyEntityId, bodyEntityRecords, bodyPeriodSec, bodyStateEci, defaultBodies, type Vec3 } from '@eio/core';
import { orbitLinePoint, orbitSampleFrame } from '../src/lib/frame';

const graph = new EntityGraph();
for (const rec of bodyEntityRecords()) graph.upsert(rec);
const REF = Date.UTC(2026, 10, 16);
const angleDeg = (a: Vec3, b: Vec3) => (Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))))) * 180) / Math.PI;

/** a heliocentric orbit line the way scene/overlays.ts buildOrbit samples it: relative to the Sun, around the Sun at REF */
function line(id: string, fixedRotation: boolean): Vec3[] {
  const period = bodyPeriodSec(defaultBodies.get(id), defaultBodies)!;
  const sunRef = bodyStateEci('SUN', REF).r;
  const out: Vec3[] = [];
  for (let i = 0; i <= 128; i++) {
    const ts = REF + (i / 128) * period * 1000;
    if (fixedRotation) {
      const s = graph.stateIn(bodyEntityId(id), ts, orbitSampleFrame('SUN')!)!;
      out.push(orbitLinePoint(s.r as Vec3, REF, sunRef));
    } else {
      const s = graph.stateIn(bodyEntityId(id), ts, 'EARTH:inertial')!, sun = bodyStateEci('SUN', ts).r;
      out.push([s.r[0] - sun[0] + sunRef[0], s.r[1] - sun[1] + sunRef[1], s.r[2] - sun[2] + sunRef[2]]);
    }
  }
  return out;
}

describe('heliocentric orbit lines close (one precession for the whole line)', () => {
  for (const id of ['NEPTUNE', 'PLUTO', 'ERIS']) {
    it(`${id}: the loop ends where it starts, and starts on the drawn body`, () => {
      const pts = line(id, true);
      const sunRef = bodyStateEci('SUN', REF).r;
      const rel = (p: Vec3): Vec3 => [p[0] - sunRef[0], p[1] - sunRef[1], p[2] - sunRef[2]];
      expect(angleDeg(rel(pts[0]), rel(pts[pts.length - 1]))).toBeLessThan(1e-4);
      // at REF the line passes through the body as the scene draws it
      const body = bodyStateEci(id, REF).r;
      expect(Math.hypot(pts[0][0] - body[0], pts[0][1] - body[1], pts[0][2] - body[2])).toBeLessThan(1e-3);
    });
  }

  it('sampling the Earth-inertial position per sample time does not close (what the fix replaces)', () => {
    const pts = line('NEPTUNE', false);
    const sunRef = bodyStateEci('SUN', REF).r;
    const rel = (p: Vec3): Vec3 => [p[0] - sunRef[0], p[1] - sunRef[1], p[2] - sunRef[2]];
    expect(angleDeg(rel(pts[0]), rel(pts[pts.length - 1]))).toBeGreaterThan(1);
  });
});
