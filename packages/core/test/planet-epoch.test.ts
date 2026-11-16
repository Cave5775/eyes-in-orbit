import { describe, expect, it } from 'vitest';
import {
  BodyRegistry, bodyStateEci, convert, frameEpoch, frameId, precessDir, setBodyStream, sunPositionEci, type Vec3,
} from '../src';

const DEG = Math.PI / 180;
const AU = 149_597_870.7;
const hms = (h: number, m: number, s: number) => (h + m / 60 + s / 3600) * 15;
const dms = (sign: number, d: number, m: number, s: number) => sign * (d + m / 60 + s / 3600);
const raDec = (d: Vec3) => ({ ra: ((Math.atan2(d[1], d[0]) / DEG) + 360) % 360, dec: Math.atan2(d[2], Math.hypot(d[0], d[1])) / DEG });
/** angle between two directions given as RA/Dec, degrees */
const sep = (a: { ra: number; dec: number }, b: { ra: number; dec: number }) => {
  const u = unitOf(a), v = unitOf(b);
  const cx = u[1] * v[2] - u[2] * v[1], cy = u[2] * v[0] - u[0] * v[2], cz = u[0] * v[1] - u[1] * v[0];
  return Math.atan2(Math.hypot(cx, cy, cz), u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / DEG;
};
const unitOf = (a: { ra: number; dec: number }): Vec3 => [Math.cos(a.dec * DEG) * Math.cos(a.ra * DEG), Math.cos(a.dec * DEG) * Math.sin(a.ra * DEG), Math.sin(a.dec * DEG)];

describe('frameEpoch', () => {
  it('the Earth and the Moon are of date, everything else is J2000', () => {
    expect(frameEpoch('EARTH')).toBe('date');
    expect(frameEpoch('MOON')).toBe('date');
    for (const id of ['SUN', 'MERCURY', 'VENUS', 'MARS', 'JUPITER', 'CERES', 'PLUTO', 'IO', 'TITAN']) expect(frameEpoch(id)).toBe('j2000');
  });
});

describe('heliocentric states reach EARTH:inertial in the axes of date', () => {
  const t = Date.UTC(2026, 10, 16);

  it('the Sun seen from the Earth through the hop is exactly `sunPositionEci` (the of-date series), position and velocity', () => {
    const viaHop = convert({ frame: frameId('SUN', 'inertial'), r: [0, 0, 0], v: [0, 0, 0] }, 'EARTH:inertial', t);
    const direct = bodyStateEci('SUN', t);
    const s = sunPositionEci(t);
    for (let i = 0; i < 3; i++) {
      expect(viaHop.r[i]).toBeCloseTo(s[i], 3);
      // the velocity of the hop is the one in non-rotating J2000 axes, the series' is the rate in the turning axes of date: they
      // differ by omega x r, 50 arcsec/yr of 1 AU = 1.1 m/s (documented in docs/frames.md)
      expect(Math.abs(viaHop.v![i] - direct.v![i])).toBeLessThan(1.5e-3);
    }
  });

  it('a J2000 heliocentric vector (a probe in SUN:inertial) is rotated by the precession of the date, then the Earth-Sun vector is added', () => {
    const x: Vec3 = [3.0e8, -1.2e8, 4.0e7];
    const v: Vec3 = [11, -7, 2];
    const out = convert({ frame: frameId('SUN', 'inertial'), r: x, v }, 'EARTH:inertial', t);
    const rot = precessDir(x, t, false), s = sunPositionEci(t);
    for (let i = 0; i < 3; i++) expect(out.r[i]).toBeCloseTo(rot[i] + s[i], 3);
    const vRot = precessDir(v, t, false);
    const sunV = bodyStateEci('SUN', t).v!; // the Sun's velocity seen from the Earth is added (30 km/s)
    for (let i = 0; i < 3; i++) expect(Math.abs(out.v![i] - (vRot[i] + sunV[i]))).toBeLessThan(2e-3);
    // and back
    const back = convert(out, 'SUN:inertial', t);
    for (let i = 0; i < 3; i++) expect(back.r[i]).toBeCloseTo(x[i], 3);
  });

  it('without the correction a planet would be off by the precession of the 1 AU Sun vector: the hop removes it (Mars)', () => {
    // mars in the Sun's J2000 frame, then Earth->Sun of date
    const mars = convert({ frame: frameId('MARS', 'inertial'), r: [0, 0, 0], v: [0, 0, 0] }, 'SUN:inertial', t).r;
    const viaHop = bodyStateEci('MARS', t).r;
    const s = sunPositionEci(t);
    const wrong: Vec3 = [mars[0] + s[0], mars[1] + s[1], mars[2] + s[2]]; // the old mixed-epoch vector
    const diff = Math.hypot(viaHop[0] - wrong[0], viaHop[1] - wrong[1], viaHop[2] - wrong[2]);
    // the old vector and the new one differ by precess(mars) - mars (26.9 years: 22 arcmin of the heliocentric vector)
    expect(diff).toBeGreaterThan(1e5);
    const rot = precessDir(mars, t, false);
    for (let i = 0; i < 3; i++) expect(viaHop[i]).toBeCloseTo(rot[i] + s[i], 3);
  });

  it('a moon of another planet: its planet-centred offset (J2000 pole) is rotated with the planet, so the hop is Io from Jupiter in date axes', () => {
    const t2 = Date.UTC(2026, 3, 1);
    const jup = bodyStateEci('JUPITER', t2).r, io = bodyStateEci('IO', t2).r;
    const off = convert({ frame: frameId('IO', 'inertial'), r: [0, 0, 0], v: [0, 0, 0] }, 'JUPITER:inertial', t2).r;
    const offDate = precessDir(off, t2, false);
    for (let i = 0; i < 3; i++) expect(io[i] - jup[i]).toBeCloseTo(offDate[i], 3);
  });

  it('a streamed planet (ICRF samples) goes through the same hop, so it follows the sample, precessed', () => {
    const reg = new BodyRegistry();
    const base = Date.UTC(2026, 10, 1);
    const samples = [0, 1, 2, 3].map((k) => [base + k * 86_400_000, 1e8 + k * 1e5, 2e8, 3e7, 5, 6, 0]);
    expect(setBodyStream('MARS', { frame: 'SUN:inertial', samples }, reg)).toBe(true);
    const tt = base + 1.5 * 86_400_000;
    const helio = convert({ frame: frameId('MARS', 'inertial'), r: [0, 0, 0], v: [0, 0, 0] }, 'SUN:inertial', tt, reg).r;
    const geo = bodyStateEci('MARS', tt, reg).r;
    const rot = precessDir(helio, tt, false), s = sunPositionEci(tt);
    for (let i = 0; i < 3; i++) expect(geo[i]).toBeCloseTo(rot[i] + s[i], 3);
  });
});

describe('planet directions against references (geometric, no light time, aberration or nutation)', () => {
  it('Venus, Meeus example 33.a, 1992 Dec 20 0h TD: apparent RA 21h04m41.454s, Dec -18d53m16.84s (of date), within 0.02 deg', () => {
    // The scene's Earth-inertial axes are of date, so the vector can be compared with the book's apparent place directly. The
    // offline orbit is Standish's table 1 (arcmin level) and the book's place is apparent (light time 7.6 min, aberration 20
    // arcsec, nutation 17 arcsec), ours geometric: 0.02 deg covers all of it. With the J2000 orbit mixed against the Sun of
    // date (before this fix) the same place was 0.07 deg off.
    const t = Date.UTC(1992, 11, 20);
    const d = raDec(bodyStateEci('VENUS', t).r);
    const sepDeg = sep(d, { ra: hms(21, 4, 41.454), dec: dms(-1, 18, 53, 16.84) });
    expect(sepDeg).toBeLessThan(0.02);
    // the distance of the example is 0.910845 AU in the book; the Standish elements are good to ~1e-3 AU here
    expect(Math.hypot(...bodyStateEci('VENUS', t).r) / AU).toBeGreaterThan(0.90);
    expect(Math.hypot(...bodyStateEci('VENUS', t).r) / AU).toBeLessThan(0.92);
  });

  // JPL Horizons, https://ssd.jpl.nasa.gov/api/horizons.api, COMMAND '499' / '599', CENTER '500@399' (geocentre), 2026-Nov-16
  // 00:00 UT (JD 2461360.5), QUANTITIES 1,20, EXTRA_PREC YES, fetched 2026-11-16: astrometric RA/Dec (ICRF, i.e. J2000, light time
  // included, no aberration) and the distance delta.
  const HORIZONS_T = Date.UTC(2026, 10, 16);
  it('Mars, JPL Horizons 2026-Nov-16 00:00 UT: ICRF RA 148.333681928, Dec 14.875716037, delta 1.3073 AU; within 0.1 deg (offline orbit)', () => {
    const j2000 = precessDir(bodyStateEci('MARS', HORIZONS_T).r, HORIZONS_T, true);
    expect(sep(raDec(j2000), { ra: 148.333681928, dec: 14.875716037 })).toBeLessThan(0.1); // the offline Standish orbit is 0.06 deg off here; the J2000 / date mix was 0.3 deg off
    expect(Math.hypot(...j2000) / AU).toBeCloseTo(1.30732526492742, 1);
  });

  it('Jupiter streamed from Horizons (ICRF heliocentric vectors, 2026-Nov-16 00:00 UT) lands within 0.03 deg of the Horizons geocentric place', () => {
    // Horizons VECTORS, COMMAND '599', CENTER '500@10', REF_SYSTEM ICRF, REF_PLANE FRAME, VEC_CORR NONE, same epoch (fetched
    // 2026-11-16): geometric heliocentric state. The geocentric reference is the OBSERVER table above (astrometric RA 148.012588676,
    // Dec 13.723093248, light time 44 min included: Jupiter moves ~0.006 deg meanwhile) and the Sun series is good to 0.01 deg, so
    // 0.03 deg is the bound. Mixing J2000 with the date (before this fix) put it 0.07 deg off, i.e. outside.
    const reg = new BodyRegistry();
    const x = [-5.607962580275543e8, 5.142895541280728e8, 2.340894234211860e8], v = [-9.432111382877958, -7.98982038730773, -3.194963410002655];
    const samples = [-3600, 0, 3600].map((dt) => [HORIZONS_T + dt * 1000, ...x.map((c, i) => c + v[i] * dt), ...v]);
    expect(setBodyStream('JUPITER', { frame: 'SUN:inertial', samples }, reg)).toBe(true);
    const j2000 = precessDir(bodyStateEci('JUPITER', HORIZONS_T, reg).r, HORIZONS_T, true);
    expect(sep(raDec(j2000), { ra: 148.012588676, dec: 13.723093248 })).toBeLessThan(0.03);
    expect(Math.hypot(...j2000) / AU).toBeCloseTo(5.26741658179196, 2);
  });
});
