import { describe, expect, it } from 'vitest';
import { DEG } from '@eio/core';
import type { V3 } from '../src/lib/camera';
import { FOLLOW_MIN_REAL_MS, FollowGuard, SKY_TURN_DEG_PER_MS, aimForHold, altAzOf, followDue, followStepDeg, holdFromCentre, movedByOthers, separationDeg } from '../src/lib/sky-follow';
import { dirToRaDec, lstRad, parallacticAngleDeg, precessDir, precessFromJ2000, precessToJ2000 } from '../src/lib/sky-frame';
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

const angDiff = (a: number, b: number): number => ((a - b + 540) % 360) - 180;
const zenith = (t: number) => {
  const of = lstRad(t, LON) / DEG;
  const j = precessToJ2000(of, LAT, t);
  return j;
};

describe('held view (direction and roll in the local frame) -> RA/Dec at t', () => {
  it('round-trips: the centre and roll held and aimed at the same time are the same', () => {
    for (const [ra, dec, rot] of [[10, 20, 0], [200, -60, 35], [359.5, 5, -120], [95, 80, 179]]) {
      const hold = holdFromCentre(ra, dec, rot, T0, LAT, LON);
      const a = aimForHold(hold, T0, LAT, LON);
      expect(sep({ raDeg: ra, decDeg: dec }, a), `${ra},${dec}`).toBeLessThan(1e-9);
      expect(Math.abs(angDiff(a.rotationDeg, rot)), `${ra},${dec} roll`).toBeLessThan(1e-7);
    }
  });

  it('agrees with the first-person pose (poseFromLook) for the same alt/az, horizon-up: centre and roll', () => {
    for (const [az, el] of [[40, 35], [200, 60], [310, 10], [95, 85]]) {
      for (const t of [T0, T0 + 3 * 3_600_000]) {
        const { dir, up } = lookDir(az, el, t, LAT, LON);
        const pose = poseFromLook(dir, t, 60, 16 / 10, up);
        // the view as it is entered: hold it at T0, then aim at t
        const first = lookDir(az, el, T0, LAT, LON);
        const p0 = poseFromLook(first.dir, T0, 60, 16 / 10, first.up);
        const hold = holdFromCentre(p0.raDeg, p0.decDeg, p0.rotationDeg, T0, LAT, LON);
        expect(altAzOf(hold).elDeg).toBeCloseTo(el, 6);
        const aim = aimForHold(hold, t, LAT, LON);
        expect(sep(pose, aim), `${az},${el}`).toBeLessThan(1e-7);
        expect(Math.abs(angDiff(aim.rotationDeg, pose.rotationDeg)), `${az},${el} roll`).toBeLessThan(1e-6);
      }
    }
  });

  it('the roll is the parallactic angle of the held direction, plus the meridian convergence of the precession (under 0.3 deg)', () => {
    for (const [az, el] of [[40, 35], [200, 60], [310, 10]]) {
      const { dir, up } = lookDir(az, el, T0, LAT, LON);
      const p0 = poseFromLook(dir, T0, 60, 1, up);
      const aim = aimForHold(holdFromCentre(p0.raDeg, p0.decDeg, p0.rotationDeg, T0, LAT, LON), T0, LAT, LON);
      const of = precessFromJ2000(aim.raDeg, aim.decDeg, T0);
      const q = parallacticAngleDeg((lstRad(T0, LON) / DEG) - of.raDeg, of.decDeg, LAT);
      expect(Math.abs(angDiff(aim.rotationDeg, q)), `${az},${el}`).toBeLessThan(0.3);
    }
  });

  it('the zenith: the centre is the zenith RA/Dec (J2000) and the sky moves under it', () => {
    const z0 = zenith(T0);
    const { dir, up } = lookDir(123, 90, T0, LAT, LON); // any azimuth: it is the zenith
    const p0 = poseFromLook(dir, T0, 60, 1, up);
    const hold = holdFromCentre(p0.raDeg, p0.decDeg, p0.rotationDeg, T0, LAT, LON);
    expect(sep(p0, z0)).toBeLessThan(1e-6);
    expect(altAzOf(hold).elDeg).toBeCloseTo(90, 5);
    const a1 = aimForHold(hold, T0 + 3_600_000, LAT, LON);
    expect(sep(a1, zenith(T0 + 3_600_000))).toBeLessThan(1e-6);
    const of0 = precessFromJ2000(z0.raDeg, z0.decDeg, T0);
    const of1 = precessFromJ2000(a1.raDeg, a1.decDeg, T0 + 3_600_000);
    expect((of1.raDeg - of0.raDeg + 360) % 360).toBeCloseTo(15.0411, 3);
  });

  it('at the zenith the roll is kept: entry roll preserved, and continuous across re-aims whatever the (noisy) azimuth', () => {
    // entered looking at the zenith with an arbitrary roll (here the horizon-up roll of a nearly vertical look, and two others)
    for (const roll of [null, 37, -140]) {
      const t0 = T0;
      const { dir, up } = lookDir(250, 89.9999999, t0, LAT, LON);
      const p0 = poseFromLook(dir, t0, 60, 1, up);
      const r0 = roll ?? p0.rotationDeg;
      // a noisy centre: a few 1e-7 degrees off the zenith in a random direction, as Aladin reports it
      const noisy = { raDeg: p0.raDeg + 3e-7, decDeg: p0.decDeg - 2e-7 };
      const hold = holdFromCentre(noisy.raDeg, noisy.decDeg, r0, t0, LAT, LON);
      const first = aimForHold(hold, t0, LAT, LON);
      expect(Math.abs(angDiff(first.rotationDeg, r0)), `entry roll ${roll}`).toBeLessThan(1e-4);
      // re-aim every 12 s of sim time for 20 minutes: the roll moves smoothly (the sky turns 0.05 deg per step), never snaps
      let prev = first.rotationDeg;
      for (let k = 1; k <= 100; k++) {
        const a = aimForHold(hold, t0 + k * 12_000, LAT, LON);
        expect(Math.abs(angDiff(a.rotationDeg, prev)), `step ${k} roll ${roll}`).toBeLessThan(0.1);
        prev = a.rotationDeg;
      }
    }
  });

  it('at a high clock rate the held direction keeps its altitude and azimuth (read back after a day and after a week)', () => {
    const c = { raDeg: 150, decDeg: -35 };
    const hold = holdFromCentre(c.raDeg, c.decDeg, 20, T0, LAT, LON);
    const h0 = altAzOf(hold);
    for (const dt of [86_400_000 / 4, 86_400_000, 7 * 86_400_000]) {
      const a = aimForHold(hold, T0 + dt, LAT, LON);
      const p = lookDir(h0.azDeg, h0.elDeg, T0 + dt, LAT, LON);
      const want = dirToRaDec(precessDir(p.dir, T0 + dt, true));
      expect(sep(want, a), `dt ${dt}`).toBeLessThan(1e-6);
    }
  });

  it('with no time passing the aim does not move', () => {
    const hold = holdFromCentre(77, 12, 5, T0, LAT, LON);
    expect(aimForHold(hold, T0, LAT, LON)).toEqual(aimForHold(hold, T0, LAT, LON));
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

describe('FollowGuard', () => {
  const at = { raDeg: 100, decDeg: 20 };
  it('does not read its own big step as somebody else when the centre lags one tick behind', () => {
    const g = new FollowGuard();
    g.aimed({ raDeg: 100, decDeg: 20 });
    g.moved(at, 60); // first check after the hold
    // aim 4 degrees on (a fast clock); Aladin still reports the old centre on the next tick, then the new one
    g.aimed({ raDeg: 104, decDeg: 20 });
    expect(g.moved(at, 60)).toBe(false);
    expect(g.moved({ raDeg: 104, decDeg: 20 }, 60)).toBe(false);
  });
  it('sees a real move (a marker click) after the skipped tick, and nothing before the first aim', () => {
    const g = new FollowGuard();
    expect(g.moved(at, 60)).toBe(false);
    g.aimed(at);
    expect(g.moved(at, 60)).toBe(false);
    expect(g.moved({ raDeg: 110, decDeg: 20 }, 60)).toBe(true);
    expect(g.moved(null, 60)).toBe(false);
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
