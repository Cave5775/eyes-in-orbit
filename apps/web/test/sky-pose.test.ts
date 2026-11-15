import { J2000_MS } from '@eio/core';
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/lib/camera';
import { FP_MAX_EL, firstPersonLookDir } from '../src/lib/first-person';
import { azElToRaDec, lstRad, parallacticAngleDeg, precessToJ2000, raDecToDir, dirToRaDec } from '../src/lib/sky-frame';
import { dirToAzEl, hFovToVFov, maxVFovFor, poseFromLook, vFovToHFov } from '../src/lib/sky-pose';

const DEG = Math.PI / 180;
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The local east / north / up of a site at geodetic latitude and east longitude, in equatorial axes of date (LST as the angle). */
function enuOfDate(latDeg: number, lstDeg: number): { e: V3; n: V3; u: V3 } {
  const p = latDeg * DEG, l = lstDeg * DEG;
  return {
    e: [-Math.sin(l), Math.cos(l), 0],
    n: [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)],
    u: [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)],
  };
}

describe('field of view', () => {
  it('a square view has equal fields, and the two conversions are inverses', () => {
    expect(vFovToHFov(60, 1)).toBeCloseTo(60, 12);
    expect(hFovToVFov(60, 1)).toBeCloseTo(60, 12);
    for (const a of [0.5, 1, 1.6, 16 / 9, 2.4]) {
      for (const v of [1, 20, 60, 100, 120]) {
        expect(hFovToVFov(vFovToHFov(v, a), a)).toBeCloseTo(v, 9);
      }
    }
  });

  it('is the rectilinear relation h = 2 atan(aspect tan(v/2)): at 16:9 a 60 degree vertical field is 91.5 degrees wide', () => {
    // tan(30 deg) = 0.57735; x 16/9 = 1.02640; atan = 45.74 deg; x 2 = 91.49 deg (hand arithmetic from the formula)
    expect(vFovToHFov(60, 16 / 9)).toBeCloseTo(91.49, 2);
    // a narrow field is nearly proportional to the aspect
    expect(vFovToHFov(1, 2) / 1).toBeCloseTo(2, 3);
    // wider than tall grows h faster than linearly: 90 deg vertical at aspect 2 is 2 atan(2) = 126.87 deg
    expect(vFovToHFov(90, 2)).toBeCloseTo(2 * Math.atan(2) / DEG, 10);
  });
});

describe('dirToAzEl', () => {
  const frames = [
    enuOfDate(40, 33),
    enuOfDate(-24.6, 200),
    enuOfDate(89, 10),
    // an arbitrary orthonormal basis, not tied to any site
    { e: [0, 0, 1] as V3, n: [1, 0, 0] as V3, u: [0, 1, 0] as V3 },
  ];

  it('is the exact inverse of firstPersonLookDir over a grid of azimuths and elevations up to the clamp', () => {
    for (const f of frames) {
      for (let az = -3 * Math.PI; az <= 3 * Math.PI; az += 0.37) {
        for (const el of [-FP_MAX_EL, -1.2, -0.5, 0, 0.26, 0.9, 1.4, FP_MAX_EL]) {
          const d = firstPersonLookDir(f, az, el);
          const back = dirToAzEl(f, d);
          expect(back.el).toBeCloseTo(el, 10);
          expect(Math.abs(wrapPi(back.az - az))).toBeLessThan(1e-9);
          expect(back.az).toBeGreaterThanOrEqual(0);
          expect(back.az).toBeLessThan(2 * Math.PI);
        }
      }
    }
  });

  it('takes a vector of any length, and reports the cardinal points', () => {
    const f = frames[0];
    const north = dirToAzEl(f, [f.n[0] * 7e5, f.n[1] * 7e5, f.n[2] * 7e5]);
    expect(north.az).toBeCloseTo(0, 12);
    expect(north.el).toBeCloseTo(0, 12);
    expect(dirToAzEl(f, f.e).az).toBeCloseTo(Math.PI / 2, 12);
    expect(dirToAzEl(f, f.u).el).toBeCloseTo(Math.PI / 2, 12);
    expect(dirToAzEl(f, [-f.u[0], -f.u[1], -f.u[2]]).el).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('reuses the output object when one is given', () => {
    const out = { az: 0, el: 0 };
    expect(dirToAzEl(frames[0], frames[0].e, out)).toBe(out);
  });

  it('agrees with sky-frame: the look direction of an az/el, as RA/Dec, is azElToRaDec for the same site and time', () => {
    const t = Date.UTC(2026, 5, 1, 3, 0, 0), lat = -24.627, lon = -70.404;
    const f = enuOfDate(lat, lstRad(t, lon) / DEG);
    for (const [az, el] of [[10, 20], [123, 45], [250, 80], [359, 5], [180, -30]]) {
      const got = dirToRaDec(firstPersonLookDir(f, az * DEG, el * DEG));
      const want = azElToRaDec(az, el, t, lat, lon);
      expect(got.decDeg).toBeCloseTo(want.decDeg, 8);
      expect(Math.abs(wrapPi((got.raDeg - want.raDeg) * DEG))).toBeLessThan(1e-9);
    }
  });
});

describe('poseFromLook', () => {
  const T0 = J2000_MS;

  it('at J2000 the centre is the look direction itself, and the horizontal field follows the aspect', () => {
    const p = poseFromLook(raDecToDir(41.05, 49.23), T0, 60, 16 / 9);
    expect(p.raDeg).toBeCloseTo(41.05, 9);
    expect(p.decDeg).toBeCloseTo(49.23, 9);
    expect(p.hFovDeg).toBeCloseTo(vFovToHFov(60, 16 / 9), 12);
    expect(p.rotationDeg).toBe(0);
  });

  it('later than J2000 the centre is the direction precessed to J2000 (length does not matter)', () => {
    const t = Date.UTC(2026, 10, 14, 6);
    const d = raDecToDir(200, -30);
    const p = poseFromLook([d[0] * 1e5, d[1] * 1e5, d[2] * 1e5], t, 30, 1.5);
    const want = precessToJ2000(200, -30, t);
    expect(p.raDeg).toBeCloseTo(want.raDeg, 9);
    expect(p.decDeg).toBeCloseTo(want.decDeg, 9);
    expect(p.raDeg).toBeLessThan(200);
  });

  it('rotation is the position angle of up from north toward east: 0 north, 90 east, 180 south, -90 west', () => {
    const ra = 30, dec = 20;
    const d = raDecToDir(ra, dec);
    const east: V3 = [-Math.sin(ra * DEG), Math.cos(ra * DEG), 0];
    const north: V3 = [
      -d[2] * east[1], d[2] * east[0], d[0] * east[1] - d[1] * east[0],
    ];
    const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
    expect(poseFromLook(d, T0, 60, 1, north).rotationDeg).toBeCloseTo(0, 9);
    expect(poseFromLook(d, T0, 60, 1, east).rotationDeg).toBeCloseTo(90, 9);
    expect(Math.abs(poseFromLook(d, T0, 60, 1, neg(north)).rotationDeg)).toBeCloseTo(180, 9);
    expect(poseFromLook(d, T0, 60, 1, neg(east)).rotationDeg).toBeCloseTo(-90, 9);
    // the celestial north pole direction is north, whatever its length and its component along the view
    expect(poseFromLook(d, T0, 60, 1, [0, 0, 1]).rotationDeg).toBeCloseTo(0, 9);
    expect(poseFromLook(d, T0, 60, 1, [0, 0, 5e4]).rotationDeg).toBeCloseTo(0, 9);
    // between north and east
    const ne: V3 = [north[0] + east[0], north[1] + east[1], north[2] + east[2]];
    expect(poseFromLook(d, T0, 60, 1, ne).rotationDeg).toBeCloseTo(45, 9);
  });

  it('with up = the local vertical the rotation is the parallactic angle (at J2000, where there is no precession)', () => {
    const lat = 19.82;
    for (const lstDeg of [0, 70, 200, 310]) {
      const f = enuOfDate(lat, lstDeg);
      for (const [az, el] of [[0, 20], [90, 30], [180, 10], [270, 45], [40, -10], [225, 60]]) {
        const d = firstPersonLookDir(f, az * DEG, el * DEG);
        const star = dirToRaDec(d);
        const H = lstDeg - star.raDeg;
        const q = parallacticAngleDeg(H, star.decDeg, lat);
        const p = poseFromLook(d, T0, 60, 1.6, f.u);
        expect(Math.abs(wrapPi((p.rotationDeg - q) * DEG)) / DEG).toBeLessThan(1e-7);
      }
    }
  });

  it('looking due south on the meridian from the northern hemisphere has north-up the right way round: rotation 0', () => {
    // a star on the meridian south of the zenith: the zenith is toward the celestial north, q = 0
    const f = enuOfDate(40, 100);
    const d = firstPersonLookDir(f, Math.PI, 30 * DEG);
    expect(poseFromLook(d, T0, 60, 1, f.u).rotationDeg).toBeCloseTo(0, 7);
    // looking north above the pole (el 60 > latitude 40, between the pole and the zenith) north is down: rotation 180
    const dn = firstPersonLookDir(f, 0, 60 * DEG);
    expect(Math.abs(poseFromLook(dn, T0, 60, 1, f.u).rotationDeg)).toBeCloseTo(180, 7);
    // an object in the west (az 270, el 0 at lat 0) has the zenith east of north: +90
    const eq = enuOfDate(0, 0);
    expect(poseFromLook(firstPersonLookDir(eq, (3 * Math.PI) / 2, 0), T0, 60, 1, eq.u).rotationDeg).toBeCloseTo(90, 7);
  });

  it('a zero or missing up gives rotation 0 and never NaN', () => {
    const d = raDecToDir(10, 10);
    expect(poseFromLook(d, T0, 60, 1, [0, 0, 0]).rotationDeg).toBe(0);
    expect(poseFromLook(d, T0, 60, 1).rotationDeg).toBe(0);
    const pole = poseFromLook([0, 0, 1], T0, 60, 1, [1, 0, 0]);
    expect(Number.isFinite(pole.rotationDeg)).toBe(true);
    expect(pole.decDeg).toBeCloseTo(90, 9);
  });
});

describe('cutting the scene field to what the viewer can show', () => {
  it('maxVFovFor is the vertical field whose horizontal field is the limit', () => {
    for (const aspect of [1, 1.6, 16 / 9, 21 / 9, 3]) {
      expect(vFovToHFov(maxVFovFor(150, aspect), aspect)).toBeCloseTo(150, 9);
    }
  });

  it('the first-person maximum (120 deg vertical) is 140.3 horizontal at 16:10, 144.0 at 16:9 and 152.2 at 21:9', () => {
    expect(vFovToHFov(120, 1.6)).toBeCloseTo(140.3, 1);
    expect(vFovToHFov(120, 16 / 9)).toBeCloseTo(144.0, 1);
    expect(vFovToHFov(120, 21 / 9)).toBeCloseTo(152.2, 1);
    expect(maxVFovFor(150, 21 / 9)).toBeLessThan(120); // so only the widest aspects are cut
    expect(maxVFovFor(150, 16 / 9)).toBeGreaterThan(120);
  });
});
