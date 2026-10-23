import { DEG, J2000_MS, MS_PER_DAY, Vec3, wrap2Pi } from './math';

/**
 * Low-precision (~0.01 deg) unit vector from Earth to the Sun in the Earth-inertial
 * (equatorial, of-date ~ TEME) frame. Used for day/night shading and eclipse hints.
 */
export function sunDirectionEci(tMs: number): Vec3 {
  const n = (tMs - J2000_MS) / MS_PER_DAY;
  const L = wrap2Pi((280.46 + 0.9856474 * n) * DEG);
  const g = wrap2Pi((357.528 + 0.9856003 * n) * DEG);
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  return [Math.cos(lambda), Math.cos(eps) * Math.sin(lambda), Math.sin(eps) * Math.sin(lambda)];
}

export const AU_KM = 149_597_870.7;
/** Mean obliquity of the ecliptic at J2000, radians: tilt between the ecliptic and the equatorial axes of the inertial frames. */
export const OBLIQUITY_J2000 = 23.4392911 * DEG;

/** Rotate a vector from ecliptic axes into equatorial axes (the axes of every `<BODY>:inertial` frame here). */
export function eclipticToEquatorial(v: Vec3, eps = OBLIQUITY_J2000): Vec3 {
  const c = Math.cos(eps), s = Math.sin(eps);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

/** Earth-Sun distance, km (Astronomical Almanac low-precision series, about 1e-5 relative). */
export function sunDistanceKm(tMs: number): number {
  const g = wrap2Pi((357.528 + 0.9856003 * ((tMs - J2000_MS) / MS_PER_DAY)) * DEG);
  return (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU_KM;
}

/** Sun position relative to the Earth in the Earth-inertial frame, km. Direction is `sunDirectionEci`. */
export function sunPositionEci(tMs: number): Vec3 {
  const d = sunDirectionEci(tMs), r = sunDistanceKm(tMs);
  return [d[0] * r, d[1] * r, d[2] * r];
}

const EARTH_EQUATORIAL_RADIUS_KM = 6378.14;

/**
 * Moon position relative to the Earth in the Earth-inertial (equatorial of date) frame, km. Low precision: the
 * Astronomical Almanac series (about 0.3 deg in direction and 0.5 percent in distance), enough to draw the Moon in the
 * right place and phase. Fixed Kepler elements would drift by degrees within a few years, so the series is used instead.
 */
export function moonPositionEci(tMs: number): Vec3 {
  const T = (tMs - J2000_MS) / (MS_PER_DAY * 36525);
  const a = (deg0: number, rate: number) => (deg0 + rate * T) * DEG;
  const lon = (218.32 + 481267.881 * T
    + 6.29 * Math.sin(a(135.0, 477198.87)) - 1.27 * Math.sin(a(259.3, -413335.36))
    + 0.66 * Math.sin(a(235.7, 890534.22)) + 0.21 * Math.sin(a(269.9, 954397.74))
    - 0.19 * Math.sin(a(357.5, 35999.05)) - 0.11 * Math.sin(a(186.5, 966404.03))) * DEG;
  const lat = (5.13 * Math.sin(a(93.3, 483202.02)) + 0.28 * Math.sin(a(228.2, 960400.89))
    - 0.28 * Math.sin(a(318.3, 6003.15)) - 0.17 * Math.sin(a(217.6, -407332.21))) * DEG;
  const parallax = (0.9508 + 0.0518 * Math.cos(a(135.0, 477198.87)) + 0.0095 * Math.cos(a(259.3, -413335.36))
    + 0.0078 * Math.cos(a(235.7, 890534.22)) + 0.0028 * Math.cos(a(269.9, 954397.74))) * DEG;
  const dist = EARTH_EQUATORIAL_RADIUS_KM / Math.sin(parallax);
  const ecl: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const eq = eclipticToEquatorial(ecl);
  return [eq[0] * dist, eq[1] * dist, eq[2] * dist];
}

/** Moon position and velocity (km, km/s) relative to the Earth in the Earth-inertial frame; the velocity is a central difference. */
export function moonStateEci(tMs: number): { r: Vec3; v: Vec3 } {
  const half = 30_000;
  const a = moonPositionEci(tMs - half), b = moonPositionEci(tMs + half);
  const span = (2 * half) / 1000; // seconds
  return { r: moonPositionEci(tMs), v: [(b[0] - a[0]) / span, (b[1] - a[1]) / span, (b[2] - a[2]) / span] };
}
