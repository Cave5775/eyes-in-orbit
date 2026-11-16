import { describe, expect, it } from 'vitest';
import { DEG } from '@eio/core';
import type { V3 } from '../src/lib/camera';
import { FOLLOW_MIN_REAL_MS, SKY_TURN_DEG_PER_MS, aimForHold, followDue, followStepDeg, holdFromCentre, movedByOthers, separationDeg } from '../src/lib/sky-follow';
import { lstRad, parallacticAngleDeg, precessFromJ2000 } from '../src/lib/sky-frame';
import { poseFromLook } from '../src/lib/sky-pose';

const T0 = Date.parse('2026-11-16T04:00:00Z');
const LAT = -24.62722, LON = -70.40389; // Paranal

/** The first-person look direction (of date) for an azimuth and elevation, built like lib/first-person.ts from the local east / north / up. */
function lookDir(azDeg: number, elDeg: number, tMs: number, latDeg: number, lonDeg: number): { dir: V3; up: V3 } {
  const L = lstRad(tMs, lonDeg), p = latDeg * DEG;
  const e: V3 = [-Math.sin(L), Math.cos(L), 0];
  const n: V3 = [-Math.sin(p) * Math.cos(L), -Math.sin(p) * Math.sin(L), Math.cos(p)];
  const u: V3 = [Math.cos(p) * Math.cos(L), Math.cos(p) * Math.sin(L), Math.sin(p)];
  const az = azDeg * DEG, el = elDeg * DEG;
  const c = Math.cos(el);
  const dir = [0, 1, 2].map((i) => c * Math.sin(az) * e[i] + c * Math.cos(az) * n[i] + Math.sin(el) * u[i]) as V3;
  return { dir, up: u };
}

const sep = (a: { raDeg: number; decDeg: number }, b: { raDeg: number; decDeg: number }) => separationDeg(a.raDeg, a.decDeg, b.raDeg, b.decDeg);

describe('alt/az held -> RA/Dec at t', () => {
  it('round-trips: the centre converted to alt/az and back is the same place', () => {
    for (const [ra, dec] of [[10, 20], [200, -60], [359.5, 5], [95, 80]]) {
      const hold = holdFromCentre(ra, dec, T0, LAT, LON);
      const a = aimForHold(hold, T0, LAT, LON);
      expect(sep({ raDeg: ra, decDeg: dec }, a), `${ra},${dec}`).toBeLessThan(1e-9);
    }
  });

  it('agrees with the first-person pose (poseFromLook) for the same alt/az: centre and horizon-up rotation', () => {
    for (const [az, el] of [[40, 35], [200, 60], [310, 10], [95, 85]]) {
      for (const t of [T0, T0 + 3 * 3_600_000]) {
        const { dir, up } = lookDir(az, el, t, LAT, LON);
        const pose = poseFromLook(dir, t, 60, 16 / 10, up);
        const aim = aimForHold({ azDeg: az, elDeg: el }, t, LAT, LON);
        expect(sep(pose, aim), `${az},${el}`).toBeLessThan(1e-9);
        const dRot = ((aim.rotationDeg - pose.rotationDeg + 540) % 360) - 180;
        expect(Math.abs(dRot), `${az},${el} rot`).toBeLessThan(1e-9);
      }
    }
  });

  it('the roll is the parallactic angle of the held direction, plus the meridian convergence of the precession (under 0.3 deg)', () => {
    for (const [az, el] of [[40, 35], [200, 60], [310, 10]]) {
      const aim = aimForHold({ azDeg: az, elDeg: el }, T0, LAT, LON);
      const of = precessFromJ2000(aim.raDeg, aim.decDeg, T0);
      const q = parallacticAngleDeg((lstRad(T0, LON) / DEG) - of.raDeg, of.decDeg, LAT);
      expect(Math.abs(((aim.rotationDeg - q + 540) % 360) - 180), `${az},${el}`).toBeLessThan(0.3);
    }
  });

  it('the zenith is the special case: it is the zenith RA/Dec precessed to J2000 and the sky moves under it', () => {
    const a0 = aimForHold({ azDeg: 0, elDeg: 90 }, T0, LAT, LON);
    const of = precessFromJ2000(a0.raDeg, a0.decDeg, T0);
    expect(of.decDeg).toBeCloseTo(LAT, 6);
    expect(of.raDeg).toBeCloseTo((lstRad(T0, LON) / DEG) % 360, 6);
    // one hour later the same alt/az is 15.04 deg further east in RA, the same declination (of date)
    const a1 = aimForHold({ azDeg: 0, elDeg: 90 }, T0 + 3_600_000, LAT, LON);
    const of1 = precessFromJ2000(a1.raDeg, a1.decDeg, T0 + 3_600_000);
    expect(of1.decDeg).toBeCloseTo(LAT, 6);
    expect((of1.raDeg - of.raDeg + 360) % 360).toBeCloseTo(15.0411, 3);
  });

  it('at a high clock rate the centre keeps its altitude and azimuth (read back after a day and after a week)', () => {
    const c = { raDeg: 150, decDeg: -35 };
    const hold = holdFromCentre(c.raDeg, c.decDeg, T0, LAT, LON);
    for (const dt of [86_400_000 / 4, 86_400_000, 7 * 86_400_000]) {
      const a = aimForHold(hold, T0 + dt, LAT, LON);
      const back = holdFromCentre(a.raDeg, a.decDeg, T0 + dt, LAT, LON);
      expect(back.elDeg).toBeCloseTo(hold.elDeg, 6);
      expect(Math.abs(((back.azDeg - hold.azDeg + 540) % 360) - 180)).toBeLessThan(1e-6);
    }
  });

  it('with no time passing the aim does not move', () => {
    const hold = holdFromCentre(77, 12, T0, LAT, LON);
    const a = aimForHold(hold, T0, LAT, LON);
    const b = aimForHold(hold, T0, LAT, LON);
    expect(a).toEqual(b);
  });
});

describe('re-aim cadence', () => {
  it('the sky turns 0.05 deg in about 12 s of sim time', () => {
    expect(0.05 / SKY_TURN_DEG_PER_MS / 1000).toBeCloseTo(11.97, 1);
  });

  it('aims at once when nothing was aimed yet', () => {
    expect(followDue(null, T0, 0, 0, 60)).toBe(true);
  });

  it('waits until the sky has turned the step, in either direction, and never twice inside the minimum real interval', () => {
    const stepMs = followStepDeg(60) / SKY_TURN_DEG_PER_MS;
    expect(followDue(T0, T0 + stepMs * 0.5, 0, 1000, 60)).toBe(false);
    expect(followDue(T0, T0 + stepMs * 1.01, 0, 1000, 60)).toBe(true);
    expect(followDue(T0, T0 - stepMs * 1.01, 0, 1000, 60)).toBe(true);
    // a huge jump of the clock, but the last aim was a moment ago
    expect(followDue(T0, T0 + 86_400_000, 1000, 1000 + FOLLOW_MIN_REAL_MS - 1, 60)).toBe(false);
    expect(followDue(T0, T0 + 86_400_000, 1000, 1000 + FOLLOW_MIN_REAL_MS, 60)).toBe(true);
  });

  it('a paused clock never triggers', () => {
    expect(followDue(T0, T0, 0, 1e6, 60)).toBe(false);
  });

  it('at a fast clock the re-aims are at most about 4 per second of real time', () => {
    // 1 sim day per real second: a re-aim is due every 250 ms, never more often
    let lastSim: number | null = null, lastReal = 0, aims = 0;
    for (let real = 0; real <= 10_000; real += 16) {
      const sim = T0 + real * 86_400;
      if (followDue(lastSim, sim, lastReal, real, 60)) { aims++; lastSim = sim; lastReal = real; }
    }
    expect(aims).toBeLessThanOrEqual(Math.ceil(10_000 / FOLLOW_MIN_REAL_MS) + 1);
    expect(aims).toBeGreaterThan(30);
  });

  it('the step shrinks with the field but is capped at 0.05 deg and floored at 0.002', () => {
    expect(followStepDeg(150)).toBe(0.05);
    expect(followStepDeg(10)).toBeCloseTo(0.01, 12);
    expect(followStepDeg(0.1)).toBe(0.002);
    expect(followStepDeg(NaN)).toBe(0.05);
  });
});

describe('view moved by something else', () => {
  it('is false for the aimed place (a small rounding) and true for a real move', () => {
    const aimed = { raDeg: 100, decDeg: 20 };
    expect(movedByOthers(aimed, { raDeg: 100.0001, decDeg: 20 }, 60)).toBe(false);
    expect(movedByOthers(aimed, { raDeg: 101, decDeg: 20 }, 60)).toBe(true);
    expect(movedByOthers(aimed, { raDeg: 100, decDeg: 21 }, 1)).toBe(true);
  });
  it('separation is zero for the same place, 90 for a quarter turn and wraps RA', () => {
    expect(separationDeg(10, 10, 10, 10)).toBeCloseTo(0, 6);
    expect(separationDeg(0, 0, 90, 0)).toBeCloseTo(90, 9);
    expect(separationDeg(359.9, 0, 0.1, 0)).toBeCloseTo(0.2, 9);
  });
});
