import type { AscentRow } from './ascent-model';

/**
 * MODELED booster return for a Falcon 9 first stage. Nothing here is measured: the path is a kinematic reconstruction in
 * the launch plane (x = ground distance along the launch azimuth from the pad, z = altitude) that passes through the
 * published event times (boostback, entry burn, landing burn, touchdown) and ends on the landing point.
 *
 *   separation .. boostback start   ballistic coast (constant g), horizontal speed unchanged
 *   boostback (RTLS) / trim         horizontal speed ramps to `vxHold`; `vxHold` is solved so the touchdown lands on the
 *                                   target (reversed for RTLS, a little slower for a droneship landing)
 *   .. entry burn                   ballistic coast
 *   entry burn .. landing burn      cubic descent between the ballistic state and the landing-burn start state; the
 *                                   horizontal speed bleeds off (`horizontalBleed`)
 *   landing burn                    constant deceleration to zero speed at the surface
 */

const G_KM_S2 = 0.0094;
const FINE_STEP_SEC = 0.5;

/** Tunable shape of the return path. Typical values, not from any particular flight. */
export const BOOSTER_SHAPE = {
  /** RTLS boostback burn length, s */
  boostbackBurnSec: 25,
  /** droneship landings only trim the trajectory (no timeline event), s, starting a few seconds after separation */
  trimBurnSec: 15,
  trimStartDelaySec: 8,
  /** vertical speed at the start of the landing burn, km/s (negative: descending) */
  landingBurnVzKmS: -0.3,
  /** horizontal speed at the start of the landing burn as a fraction of the speed held before the entry burn */
  residualHorizontal: 0.05,
  /** touchdown distance from the pad along the launch azimuth, km: the landing zone (RTLS) or the droneship (typical) */
  rtlsLandingDownrangeKm: 8,
  droneshipDownrangeKm: 600,
} as const;

/**
 * How the horizontal speed falls between the entry burn (u = 0, factor 1) and the landing burn (u = 1, factor
 * `residualHorizontal`). Any curve that starts at 1 and ends at `residual` works; the landing point is solved afterwards.
 */
export function horizontalBleed(u: number, residual: number): number {
  // TODO(human): the shape of the horizontal-speed decay during the entry burn and the aerodynamic descent.
  // This default is a plain cosine ease. Drag is strongest where the air is thick, so a real descent loses most of its
  // horizontal speed late; an ease that stays high for longer (and drops near u = 1) would be closer to that.
  return residual + (1 - residual) * 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.max(0, u))));
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
  /** boundaries of the return phases, seconds since liftoff */
  phases: { id: 'coast' | 'boostback' | 'trim' | 'entry' | 'landing-burn'; fromSec: number }[];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function modelBoosterReturn(start: BoosterStart, o: BoosterOptions): BoosterTrack {
  const S = BOOSTER_SHAPE;
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

  // horizontal speed history for a given held speed
  const vxAt = (t: number, vxHold: number): number => {
    if (t <= bb0) return start.vxKmS;
    if (t <= bb1) return start.vxKmS + (vxHold - start.vxKmS) * ((t - bb0) / (bb1 - bb0));
    if (t <= entry) return vxHold;
    if (t <= lb) return vxHold * horizontalBleed((t - entry) / (lb - entry), S.residualHorizontal);
    return vxHold * S.residualHorizontal * (1 - (t - lb) / burnSec);
  };
  const n = Math.ceil((land - sep) / FINE_STEP_SEC);
  const integrate = (vxHold: number): Float64Array => {
    const x = new Float64Array(n + 1);
    x[0] = start.downrangeKm;
    for (let i = 1; i <= n; i++) {
      const t0 = sep + (i - 1) * FINE_STEP_SEC;
      x[i] = x[i - 1] + 0.5 * (vxAt(t0, vxHold) + vxAt(t0 + FINE_STEP_SEC, vxHold)) * FINE_STEP_SEC;
    }
    return x;
  };
  // the end point is affine in the held speed, so two evaluations solve for the speed that touches down on the target
  const x0 = integrate(0), x1 = integrate(1);
  const slope = x1[n] - x0[n];
  const vxHold = (xL - x0[n]) / (Math.abs(slope) < 1e-9 ? 1e-9 : slope);
  const xs = integrate(vxHold);
  const xAt = (t: number): number => {
    const f = Math.min(n, Math.max(0, (t - sep) / FINE_STEP_SEC));
    const i = Math.min(n - 1, Math.floor(f));
    return xs[i] + (xs[i + 1] - xs[i]) * (f - i);
  };

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
    return { tSec: t, altKm: v.z, speedKmS: Math.hypot(vxAt(t, vxHold), v.vz), downrangeKm: xAt(t) };
  });
  rows[rows.length - 1] = { ...rows[rows.length - 1], altKm: 0, speedKmS: 0 };

  return {
    recovery: o.recovery, rows, landingDownrangeKm: xL, apogeeKm: apogee, vxHoldKmS: vxHold,
    phases: [
      { id: 'coast', fromSec: sep },
      { id: rtls ? 'boostback' : 'trim', fromSec: bb0 },
      { id: 'coast', fromSec: bb1 },
      { id: 'entry', fromSec: entry },
      { id: 'landing-burn', fromSec: lb },
    ],
  };
}
