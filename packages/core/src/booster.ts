import type { AscentRow } from './ascent-model';

/**
 * MODELED booster return for a recovered first stage. Nothing here is measured: the path is a reconstruction in the
 * launch plane (x = ground distance along the launch azimuth from the pad, z = altitude) that passes through the
 * published event times (boostback, entry burn, landing burn, touchdown) and ends on the landing point.
 *
 *   separation .. boostback start   ballistic coast (constant g), horizontal speed unchanged
 *   boostback (RTLS) / trim         horizontal speed ramps to `vxHold`; `vxHold` is solved so the touchdown lands on the
 *                                   target (reversed for RTLS, a little slower for a droneship landing)
 *   .. entry burn                   ballistic coast
 *   entry burn .. landing burn      cubic descent between the ballistic state and the landing-burn start state; the
 *                                   horizontal speed is bled off by the entry-burn thrust and by atmospheric drag
 *   landing burn                    constant deceleration to zero speed at the surface
 *
 * The horizontal bleed is not a chosen curve. Drag and thrust both act along the velocity, so the horizontal speed obeys
 * dvx/dt = -k(t) vx with k = rho(z) |v| / (2 beta) + [entry burn] T / (m |v|), beta = m / (Cd A), and
 * vx(t) = vxHold * exp(-integral of k). The altitude and speed along the descent are the modeled ones, so the curve falls
 * out of the vehicle's mass, drag area and entry-burn thrust and the standard atmosphere.
 */

const G_KM_S2 = 0.0094;
const G0 = 9.80665;
const FINE_STEP_SEC = 0.5;
const BLEED_STEP_SEC = 0.25;

/** Tunable shape of the return path. Typical values, not from any particular flight. */
export const BOOSTER_SHAPE = {
  /** RTLS boostback burn length, s */
  boostbackBurnSec: 25,
  /** droneship landings only trim the trajectory (no timeline event), s, starting a few seconds after separation */
  trimBurnSec: 15,
  trimStartDelaySec: 8,
  /** vertical speed at the start of the landing burn, km/s (negative: descending) */
  landingBurnVzKmS: -0.3,
  /** touchdown distance from the pad along the launch azimuth, km: the landing zone (RTLS) or the droneship (typical) */
  rtlsLandingDownrangeKm: 8,
  droneshipDownrangeKm: 600,
} as const;

/** What the descent physics needs to know about the stage. */
export interface BoosterPhysics {
  /** mass at the start of the entry burn (dry mass plus the remaining propellant), kg */
  massKg: number;
  /** drag reference area, m^2 */
  areaM2: number;
  /** effective drag coefficient for that area (grid fins and the angle of attack are folded into it) */
  cd: number;
  /** entry-burn thrust, N, and how long it burns, s */
  entryThrustN: number;
  entryBurnSec: number;
  /** specific impulse of the burn, s (sets how fast the stage lightens) */
  ispS: number;
}

/**
 * Falcon 9 Block 5 first stage, rough public figures: about 22 t dry plus a few tonnes of landing propellant, 3.66 m
 * diameter flown engines-first, an entry burn of about 20 s on three Merlins at partial throttle (about 1 MN).
 */
export const FALCON9_BOOSTER: BoosterPhysics = {
  massKg: 26_000, areaM2: Math.PI * 1.83 ** 2, cd: 1.3, entryThrustN: 1.0e6, entryBurnSec: 20, ispS: 300,
};

/** (altitude km, density kg/m^3) of the International Standard Atmosphere. */
const ATMOSPHERE: [number, number][] = [
  [0, 1.225], [5, 0.7364], [10, 0.4135], [15, 0.1948], [20, 0.08891], [30, 0.01841], [40, 0.003996],
  [50, 0.001027], [60, 0.0003097], [80, 1.846e-5], [100, 5.604e-7],
];

/** Air density at `altKm` (log-linear between the standard-atmosphere table points, a 6 km scale height above 100 km). */
export function airDensity(altKm: number): number {
  const z = Math.max(0, altKm);
  const last = ATMOSPHERE[ATMOSPHERE.length - 1];
  if (z >= last[0]) return last[1] * Math.exp(-(z - last[0]) / 6);
  let i = 1;
  while (ATMOSPHERE[i][0] < z) i++;
  const [z0, d0] = ATMOSPHERE[i - 1], [z1, d1] = ATMOSPHERE[i];
  return Math.exp(Math.log(d0) + ((Math.log(d1) - Math.log(d0)) * (z - z0)) / (z1 - z0));
}

/** Speed (km/s) at which drag balances weight at `altKm`: sqrt(2 m g / (rho Cd A)). */
export function terminalVelocityKmS(altKm: number, p: BoosterPhysics): number {
  return Math.sqrt((2 * p.massKg * G0) / (airDensity(altKm) * p.cd * p.areaM2)) / 1000;
}

export interface BoosterStart {
  /** at stage separation */
  sepSec: number;
  /** ground distance from the pad, km */
  downrangeKm: number;
  altKm: number;
  /** speed along the launch azimuth, km/s */
  vxKmS: number;
  /** vertical speed, km/s */
  vzKmS: number;
}

export interface BoosterOptions {
  recovery: 'droneship' | 'rtls';
  physics: BoosterPhysics;
  /** event times, seconds since liftoff */
  boostbackSec?: number;
  entrySec: number;
  landingBurnSec: number;
  landingSec: number;
  /** override the touchdown distance from the pad, km */
  landingDownrangeKm?: number;
  /** sample spacing of the rows, default 2 s (event instants are always included) */
  stepSec?: number;
}

export interface BoosterTrack {
  recovery: 'droneship' | 'rtls';
  /** from stage separation to touchdown; `downrangeKm` is along the launch azimuth from the pad */
  rows: AscentRow[];
  landingDownrangeKm: number;
  /** highest point of the return arc */
  apogeeKm: number;
  /** horizontal speed held between the boostback / trim and the entry burn (negative: heading back towards the pad) */
  vxHoldKmS: number;
  /** horizontal speed at the start of the landing burn as a fraction of `vxHoldKmS`, from the drag and thrust integral */
  residualHorizontal: number;
  /** boundaries of the return phases, seconds since liftoff */
  phases: { id: 'coast' | 'boostback' | 'trim' | 'entry' | 'landing-burn'; fromSec: number }[];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function modelBoosterReturn(start: BoosterStart, o: BoosterOptions): BoosterTrack {
  const S = BOOSTER_SHAPE, P = o.physics;
  const rtls = o.recovery === 'rtls';
  const sep = start.sepSec;
  const bb0 = rtls ? Math.max(o.boostbackSec ?? sep + 12, sep) : sep + S.trimStartDelaySec;
  const bb1 = Math.min(bb0 + (rtls ? S.boostbackBurnSec : S.trimBurnSec), o.entrySec - 1);
  const entry = o.entrySec, lb = o.landingBurnSec, land = o.landingSec;
  if (!(sep < bb0 && bb0 < bb1 && bb1 < entry && entry < lb && lb < land)) throw new Error('inconsistent booster timeline');
  const xL = o.landingDownrangeKm ?? (rtls ? S.rtlsLandingDownrangeKm : S.droneshipDownrangeKm);
  const vzLB = S.landingBurnVzKmS;
  const burnSec = land - lb;
  const hLB = (Math.abs(vzLB) * burnSec) / 2;

  // ballistic vertical motion up to the entry burn
  const zBallistic = (t: number) => start.altKm + start.vzKmS * (t - sep) - 0.5 * G_KM_S2 * (t - sep) ** 2;
  const vzBallistic = (t: number) => start.vzKmS - G_KM_S2 * (t - sep);
  const zEntry = Math.max(zBallistic(entry), hLB + 1);
  const vzEntry = Math.min(vzBallistic(entry), -0.05);

  // cubic Hermite descent between the entry state and the landing-burn start state
  const descent = (t: number): { z: number; vz: number } => {
    const T = lb - entry, u = (t - entry) / T, u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const z = h00 * zEntry + h10 * T * vzEntry + h01 * hLB + h11 * T * vzLB;
    const dz = ((6 * u2 - 6 * u) * zEntry + (3 * u2 - 4 * u + 1) * T * vzEntry + (-6 * u2 + 6 * u) * hLB + (3 * u2 - 2 * u) * T * vzLB) / T;
    return { z, vz: dz };
  };
  const vertical = (t: number): { z: number; vz: number } => {
    if (t <= entry) return { z: Math.max(0, zBallistic(t)), vz: vzBallistic(t) };
    if (t <= lb) return descent(t);
    const s = t - lb;
    return { z: Math.max(0, hLB + vzLB * (s - (s * s) / (2 * burnSec))), vz: vzLB * (1 - s / burnSec) };
  };

  // fraction of the held horizontal speed that is left at each step of the entry burn .. landing burn stretch:
  // exp(-integral of the drag and thrust rates), evaluated along the modeled descent for a given held speed
  const nb = Math.max(1, Math.ceil((lb - entry) / BLEED_STEP_SEC));
  const dtB = (lb - entry) / nb;
  const beta = P.massKg / (P.cd * P.areaM2);
  const mdot = P.entryThrustN / (P.ispS * G0);
  const burnEnd = entry + Math.min(P.entryBurnSec, lb - entry);
  const bleedFor = (vxHold: number): Float64Array => {
    const r = new Float64Array(nb + 1);
    r[0] = 1;
    let integral = 0;
    const rate = (t: number, fraction: number): number => {
      const v = vertical(t);
      const speed = Math.max(50, Math.hypot(vxHold * fraction, v.vz) * 1000); // m/s
      let k = (airDensity(v.z) * speed) / (2 * beta);
      if (t < burnEnd) k += P.entryThrustN / ((P.massKg - mdot * (t - entry)) * speed);
      return k;
    };
    for (let i = 1; i <= nb; i++) {
      const t0 = entry + (i - 1) * dtB;
      integral += 0.5 * (rate(t0, r[i - 1]) + rate(t0 + dtB, r[i - 1])) * dtB;
      r[i] = Math.exp(-integral);
    }
    return r;
  };
  const bleedAt = (r: Float64Array, t: number): number => {
    const f = Math.min(nb, Math.max(0, (t - entry) / dtB));
    const i = Math.min(nb - 1, Math.floor(f));
    return r[i] + (r[i + 1] - r[i]) * (f - i);
  };

  // horizontal speed history for a held speed and a bleed curve
  const vxAt = (t: number, vxHold: number, r: Float64Array): number => {
    if (t <= bb0) return start.vxKmS;
    if (t <= bb1) return start.vxKmS + (vxHold - start.vxKmS) * ((t - bb0) / (bb1 - bb0));
    if (t <= entry) return vxHold;
    if (t <= lb) return vxHold * bleedAt(r, t);
    return vxHold * r[nb] * (1 - (t - lb) / burnSec);
  };
  const n = Math.ceil((land - sep) / FINE_STEP_SEC);
  const integrate = (vxHold: number, r: Float64Array): Float64Array => {
    const x = new Float64Array(n + 1);
    x[0] = start.downrangeKm;
    for (let i = 1; i <= n; i++) {
      const t0 = sep + (i - 1) * FINE_STEP_SEC;
      x[i] = x[i - 1] + 0.5 * (vxAt(t0, vxHold, r) + vxAt(t0 + FINE_STEP_SEC, vxHold, r)) * FINE_STEP_SEC;
    }
    return x;
  };
  // for a fixed bleed curve the end point is affine in the held speed, so two evaluations solve for the speed that touches
  // down on the target; the bleed curve itself depends (weakly, through |v|) on the held speed, so iterate
  const solveHold = (r: Float64Array): number => {
    const e0 = integrate(0, r)[n], e1 = integrate(1, r)[n];
    const slope = e1 - e0;
    return (xL - e0) / (Math.abs(slope) < 1e-9 ? 1e-9 : slope);
  };
  let r = bleedFor(0);
  let vxHold = solveHold(r);
  for (let i = 0; i < 5; i++) {
    r = bleedFor(vxHold);
    vxHold = solveHold(r);
  }
  const xs = integrate(vxHold, r);
  const xAt = (t: number): number => {
    const f = Math.min(n, Math.max(0, (t - sep) / FINE_STEP_SEC));
    const i = Math.min(n - 1, Math.floor(f));
    return xs[i] + (xs[i + 1] - xs[i]) * (f - i);
  };

  // sample grid: uniform plus the exact event instants
  const step = Math.max(0.5, o.stepSec ?? 2);
  const times = new Set<number>();
  for (let t = sep; t < land; t += step) times.add(round3(t));
  for (const t of [sep, bb0, bb1, entry, lb, land]) times.add(round3(t));
  const grid = [...times].sort((a, b) => a - b);
  let apogee = 0;
  const rows: AscentRow[] = grid.map((t) => {
    const v = vertical(t);
    apogee = Math.max(apogee, v.z);
    return { tSec: t, altKm: v.z, speedKmS: Math.hypot(vxAt(t, vxHold, r), v.vz), downrangeKm: xAt(t) };
  });
  rows[rows.length - 1] = { ...rows[rows.length - 1], altKm: 0, speedKmS: 0 };

  return {
    recovery: o.recovery, rows, landingDownrangeKm: xL, apogeeKm: apogee, vxHoldKmS: vxHold, residualHorizontal: r[nb],
    phases: [
      { id: 'coast', fromSec: sep },
      { id: rtls ? 'boostback' : 'trim', fromSec: bb0 },
      { id: 'coast', fromSec: bb1 },
      { id: 'entry', fromSec: entry },
      { id: 'landing-burn', fromSec: lb },
    ],
  };
}
