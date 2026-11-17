import { describe, expect, it } from 'vitest';
import { MARS, MOON, convert, inertialToFixedMatrix, mulMV, precessDir, streamToFrameAxes, type Vec3 } from '../src';

const t = Date.UTC(2026, 10, 16);
const DEG = Math.PI / 180;
const raDec = (d: Vec3) => [Math.atan2(d[1], d[0]) / DEG, Math.asin(d[2]) / DEG];

describe('the Moon frame is of date, its IAU pole is J2000', () => {
  it('the Moon pole in MOON:inertial is the IAU pole precessed to the date, and the prime meridian turns by about 0.37 deg', () => {
    const rot = MOON.rotation as { poleRaDeg: number; poleDecDeg: number };
    const ra = rot.poleRaDeg * DEG, dec = rot.poleDecDeg * DEG;
    const j2000: Vec3 = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    // fixed +z back to inertial: transpose row 3 of the matrix
    const m = inertialToFixedMatrix(MOON, t);
    const pole: Vec3 = [m[6], m[7], m[8]];
    const want = precessDir(j2000, t, false);
    expect(Math.hypot(pole[0] - want[0], pole[1] - want[1], pole[2] - want[2])).toBeLessThan(1e-9);
    // the pole is near the ecliptic pole, which precession barely moves (0.01 deg); the prime meridian (fixed +x) turns by the full ~0.3 deg
    const raw = inertialToFixedMatrix({ ...MOON, id: 'X' }, t); // the same IAU rotation in the J2000 axes
    const sep = Math.hypot(m[0] - raw[0], m[1] - raw[1], m[2] - raw[2]);
    expect(sep / DEG).toBeGreaterThan(0.2);
    expect(sep / DEG).toBeLessThan(0.5);
    expect(raDec(pole)[1]).toBeCloseTo(raDec(want)[1], 6);
  });

  it('a Moon surface point goes through convert to the same place as the precessed J2000 mesh, and the Mars matrix is unchanged', () => {
    const fixed = { frame: 'MOON:fixed' as const, r: [1737.4, 0, 0] as Vec3 };
    const inert = convert(fixed, 'MOON:inertial', t).r;
    const back = mulMV(inertialToFixedMatrix(MOON, t), inert);
    expect(Math.hypot(back[0] - 1737.4, back[1], back[2])).toBeLessThan(1e-9);
    // J2000-group bodies keep the plain IAU matrix (their frame is J2000)
    const m = inertialToFixedMatrix(MARS, t);
    expect(Math.hypot(m[6], m[7], m[8])).toBeCloseTo(1, 12);
  });
});

describe('streamToFrameAxes', () => {
  it('precesses position and velocity of each sample by its own date and leaves samples without velocity at 4 columns', () => {
    const out = streamToFrameAxes('EARTH:inertial', [[t, 1e6, 2e6, 3e6, 1, 2, 3], [t + 3600_000, 1e6, 0, 0]]);
    const r = precessDir([1e6, 2e6, 3e6], t, false), v = precessDir([1, 2, 3], t, false);
    expect(out[0].slice(1)).toEqual([...r, ...v]);
    expect(out[1]).toHaveLength(4);
  });
});
