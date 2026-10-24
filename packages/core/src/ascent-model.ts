import { DEG } from './math';
import { EARTH } from './bodies';
import { destinationPoint, profileToFixedSamples, reconstructDownrange } from './ascent';
import { modelBoosterReturn, type BoosterTrack } from './booster';
import type { Launch } from './feeds';
import type { CompositeSegment, EntityEvent, Sample } from './types';

/**
 * MODELED / NOMINAL Falcon 9 low-Earth-orbit ascent.
 *
 * Nothing in this file is measured. There is no open programmatic ascent telemetry (reference doc,
 * section 2), so the profile is a parametric reconstruction of the figures SpaceX webcasts typically
 * show for a Starlink-class mission (altitude and Earth-relative speed against T+). Real flights
 * differ by tens of seconds and a few percent; use the telemetry ingest endpoint for measured data.
 *
 * Other vehicles reuse the same shape through a `VehicleProfile` (see `VEHICLES`): only the timeline and the per-vehicle
 * notes differ, so a profile for a vehicle whose ascent looks very different (multi-booster, long core burn) would be
 * misleading and is not provided.
 *
 * Assumptions for Falcon 9 (all "typical", from public webcasts and launch reports, not from any one flight):
 *  - Max-Q at about T+1:10 (altitude ~12 km, speed ~0.42 km/s).
 *  - MECO at about T+2:30 (altitude ~68 km, speed ~2.3 km/s, Earth-relative), stage separation
 *    3 s later, second-stage ignition (SES) 8 s after MECO, fairing separation at about T+3:30.
 *  - SECO-1 at about T+8:30 into a 165 x 280 km (Starlink) or 190 x 300 km transfer orbit; the
 *    Earth-relative speed there follows from vis-viva minus the Earth's rotation along the azimuth.
 *  - First stage: smooth monotone (PCHIP) curve through hand-picked keyframes.
 *  - Second stage: altitude saturates towards the SECO altitude (1 - (1-u)^4.3), speed follows the
 *    rocket equation with a stage mass ratio of 5.4 (Isp-independent shape, scaled to the SECO speed).
 *  - Booster recovery on a droneship (entry burn ~T+6:20, landing burn ~T+7:55, touchdown ~T+8:20)
 *    or back at the launch site (boostback ~T+2:45, entry ~T+6:05, touchdown ~T+7:45).
 *  - After SECO the state is held (constant altitude and speed) for 10 minutes; the real orbit
 *    rises towards apogee, this is only a placeholder until the payload appears in CelesTrak.
 *  - Downrange is integrated from speed and altitude rate (`reconstructDownrange`, reference doc
 *    section 2) along one constant ground azimuth, so the ground track is a great circle.
 */

export const MODELED_LABEL = 'MODELED / NOMINAL (not measured)';

const OMEGA_EARTH = 7.2921159e-5; // rad/s
const R_EARTH = EARTH.radiusKm;

export type LaunchBranch = 'north' | 'south';
export type Recovery = 'droneship' | 'rtls' | 'none';
export type InclinationSource = 'explicit' | 'description' | 'starlink-group' | 'mission' | 'orbit' | 'site-default';

export interface AscentRow {
  /** seconds since liftoff */
  tSec: number;
  altKm: number;
  /** Earth-relative speed, km/s */
  speedKmS: number;
  downrangeKm: number;
}

export type AscentTrack = 'vehicle' | 'booster';

export interface AscentEvent {
  /** stable id, e.g. MAX_Q, MECO, STAGE_SEP, SES, FAIRING_SEP, BOOSTBACK, ENTRY_BURN, LANDING_BURN, LANDING, SECO */
  name: string;
  /** short display label, e.g. `MAX-Q` */
  label: string;
  tSec: number;
  /** `booster` events do not lie on the vehicle (upper stage) curves */
  track: AscentTrack;
  detail?: string;
  altKm?: number;
  speedKmS?: number;
  /** true when the time was reported with live telemetry rather than modeled */
  reported?: boolean;
}

/** Vehicle phase spans on the T+ axis (used by the timeline and for composite segment names). */
export interface AscentPhaseSpan {
  id: 'first-stage' | 'staging' | 'second-stage' | 'orbit-coast';
  label: string;
  fromSec: number;
  toSec: number;
}

export interface Falcon9Timeline {
  maxQSec: number;
  mecoSec: number;
  mecoAltKm: number;
  mecoSpeedKmS: number;
  /** seconds from MECO */
  sepDelaySec: number;
  /** seconds from MECO */
  sesDelaySec: number;
  fairingSec: number;
  secoSec: number;
  /** altitude at SECO-1 */
  secoAltKm: number;
  /** apogee of the SECO-1 transfer orbit (sets the SECO speed) */
  apogeeKm: number;
  /** seconds the final state is held after SECO */
  coastSec: number;
}

export interface Falcon9AscentOptions {
  padLatDeg: number;
  padLonDeg: number;
  inclinationDeg: number;
  inclinationSource?: InclinationSource;
  branch?: LaunchBranch;
  recovery?: Recovery;
  /** `starlink` uses the lower 165 x 280 km SECO orbit, `generic` 190 x 300 km */
  profile?: 'starlink' | 'generic';
  timeline?: Partial<Falcon9Timeline>;
  /** sample spacing of `rows`, default 2 s */
  stepSec?: number;
}

export interface ModeledAscent {
  kind: 'modeled';
  label: string;
  /** display name of the vehicle profile used, e.g. `Falcon 9` */
  vehicle: string;
  inclinationDeg: number;
  inclinationSource: InclinationSource;
  branch: LaunchBranch;
  recovery: Recovery;
  /** inertial launch azimuth from the inclination and pad latitude, degrees from north */
  inertialAzimuthDeg: number;
  /** ground-track azimuth after the Earth's rotation is removed */
  azimuthDeg: number;
  timeline: Falcon9Timeline;
  rows: AscentRow[];
  events: AscentEvent[];
  phases: AscentPhaseSpan[];
  /** modeled return path of the first stage (null when it is expended); its events lie on this track */
  booster: BoosterTrack | null;
  assumptions: string[];
}

// ---------------------------------------------------------------- azimuth

const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

/**
 * Inertial launch azimuth (degrees clockwise from north) for a target inclination from a pad at
 * `padLatDeg`: sin(Az) = cos(i) / cos(lat). `north` is the ascending (north-going) solution,
 * `south` the descending one (180 - Az), which is what Vandenberg uses. An inclination below
 * the pad latitude is unreachable without a dogleg; it is clamped to due east/south-east.
 */
export function inertialAzimuthDeg(inclinationDeg: number, padLatDeg: number, branch: LaunchBranch = 'north'): number {
  const x = Math.cos(inclinationDeg * DEG) / Math.cos(padLatDeg * DEG);
  const a = Math.asin(Math.max(-1, Math.min(1, x))) / DEG; // -90..90
  return norm360(branch === 'north' ? a : 180 - a);
}

/**
 * Azimuth of the velocity relative to the rotating Earth. The pad moves east at
 * omega*R*cos(lat) (0.41 km/s at 28.5 N), so a vehicle that reaches orbital speed `orbitSpeedKmS`
 * on an inertial heading flies a more southerly / northerly ground track.
 */
export function groundAzimuthDeg(inertialAz: number, padLatDeg: number, orbitSpeedKmS = 7.8): number {
  const az = inertialAz * DEG;
  const vx = orbitSpeedKmS * Math.sin(az) - OMEGA_EARTH * R_EARTH * Math.cos(padLatDeg * DEG);
  const vy = orbitSpeedKmS * Math.cos(az);
  return norm360(Math.atan2(vx, vy) / DEG);
}

/** Inclination that makes `azimuth` the inertial azimuth: cos(i) = sin(Az) cos(lat). */
export function inclinationForAzimuthDeg(inertialAz: number, padLatDeg: number): number {
  return Math.acos(Math.sin(inertialAz * DEG) * Math.cos(padLatDeg * DEG)) / DEG;
}

/** West-coast pads (Vandenberg) fly south, everything else launches north-east. */
export function defaultBranch(padLatDeg: number, padLonDeg: number): LaunchBranch {
  return padLonDeg < -110 && padLatDeg > 30 ? 'south' : 'north';
}

// ---------------------------------------------------------------- inclination defaults

/**
 * Typical Starlink shell inclination per group number (approximate, from public launch reports;
 * a launch description that states an inclination wins). Group 15 is the ~70 deg Vandenberg shell.
 */
export const STARLINK_GROUP_INCLINATION: Readonly<Record<number, number>> = {
  2: 70, 3: 97.6, 4: 53, 5: 53, 6: 43, 7: 53, 8: 53, 9: 97, 10: 53, 11: 53, 12: 43, 15: 70, 17: 97,
};

export interface InclinationInput {
  name: string;
  missionName?: string;
  orbit?: string;
  description?: string;
  padLatDeg: number;
  padLonDeg: number;
}

/** Best-effort target inclination for a launch whose provider data carries no orbit elements. */
export function defaultInclination(i: InclinationInput): { deg: number; source: InclinationSource } {
  const text = i.description ?? '';
  const m = /inclination[^\d]{0,24}(\d{1,2}(?:\.\d+)?)\s*(?:°|deg)/i.exec(text) ?? /(\d{1,2}(?:\.\d+)?)\s*(?:°|deg(?:rees?)?)\s+inclination/i.exec(text);
  if (m && Number(m[1]) > 0 && Number(m[1]) < 180) return { deg: Number(m[1]), source: 'description' };

  const west = i.padLonDeg < -110 && i.padLatDeg > 30;
  const sl = /starlink\s+group\s+(\d+)-\d+/i.exec(`${i.missionName ?? ''} ${i.name}`);
  if (sl) {
    const g = STARLINK_GROUP_INCLINATION[Number(sl[1])];
    return g ? { deg: g, source: 'starlink-group' } : { deg: west ? 70 : 53.2, source: 'site-default' };
  }
  const label = `${i.missionName ?? ''} ${i.name}`;
  if (/\b(crew|crs|cygnus|axiom|ax-\d|iss)\b|dragon/i.test(label) && !west) return { deg: 51.6, source: 'mission' };
  const orbit = (i.orbit ?? '').toLowerCase();
  if (/sun-synch|sso/.test(orbit)) return { deg: 97.4, source: 'orbit' };
  if (/geostationary|gto|gso|geosynchronous|transfer|heliocentric|lunar|moon|escape/.test(orbit)) {
    return { deg: Math.max(Math.abs(i.padLatDeg), 27), source: 'orbit' };
  }
  return { deg: west ? 97.4 : 53, source: 'site-default' };
}

// ---------------------------------------------------------------- profile curves

/** Monotone cubic (Fritsch-Carlson / PCHIP) interpolant through (xs, ys); xs strictly increasing. */
export function pchip(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const h: number[] = [], d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] > 0) {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  const end = (h0: number, h1: number, d0: number, d1: number): number => {
    const e = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(e) !== Math.sign(d0)) return 0;
    if (Math.sign(d0) !== Math.sign(d1) && Math.abs(e) > 3 * Math.abs(d0)) return 3 * d0;
    return e;
  };
  if (n === 2) m[0] = m[1] = d[0];
  else {
    m[0] = end(h[0], h[1], d[0], d[1]);
    m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  }
  return (x: number): number => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - xs[lo]) / h[lo], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h[lo] * m[lo]
      + (-2 * t3 + 3 * t2) * ys[lo + 1] + (t3 - t2) * h[lo] * m[lo + 1];
  };
}

/** Reference first-stage keyframes: [T+ s, altitude km, Earth-relative speed km/s] for MECO at 150 s / 68 km / 2.3 km/s. */
const STAGE1_KEYFRAMES: [number, number, number][] = [
  [0, 0, 0], [10, 0.2, 0.03], [30, 2.3, 0.12], [50, 6, 0.25], [70, 12, 0.42], [90, 21, 0.7],
  [110, 32, 1.03], [130, 47, 1.55], [150, 68, 2.3],
];
const REF_MECO = { sec: 150, alt: 68, speed: 2.3 };
/** shape exponent of the second-stage altitude saturation */
const STAGE2_ALT_K = 4.3;
/** upper-stage mass ratio (ignition mass / SECO mass) of the rocket-equation speed shape */
const STAGE2_MASS_RATIO = 5.4;
const G_KM_S2 = 0.0094;

export function defaultTimeline(profile: 'starlink' | 'generic' = 'starlink'): Falcon9Timeline {
  return {
    maxQSec: 70, mecoSec: REF_MECO.sec, mecoAltKm: REF_MECO.alt, mecoSpeedKmS: REF_MECO.speed,
    sepDelaySec: 3, sesDelaySec: 8, fairingSec: 210, secoSec: 510,
    secoAltKm: profile === 'starlink' ? 165 : 190, apogeeKm: profile === 'starlink' ? 280 : 300, coastSec: 600,
  };
}

/** Inertial speed at perigee of a `secoAlt x apogee` orbit (vis-viva). */
export function secoInertialSpeedKmS(t: Pick<Falcon9Timeline, 'secoAltKm' | 'apogeeKm'>): number {
  const r = R_EARTH + t.secoAltKm;
  const a = R_EARTH + (t.secoAltKm + t.apogeeKm) / 2;
  return Math.sqrt(EARTH.gm * (2 / r - 1 / a));
}

/** Earth-relative speed at SECO: the inertial speed minus the Earth's rotation along the launch azimuth. */
export function secoSpeedKmS(t: Pick<Falcon9Timeline, 'secoAltKm' | 'apogeeKm'>, padLatDeg: number, inertialAz: number): number {
  const r = R_EARTH + t.secoAltKm;
  const vi = secoInertialSpeedKmS(t);
  const az = inertialAz * DEG;
  const vx = vi * Math.sin(az) - OMEGA_EARTH * r * Math.cos(padLatDeg * DEG);
  return Math.hypot(vx, vi * Math.cos(az));
}

// ---------------------------------------------------------------- vehicle profiles

/**
 * What differs between vehicles in this model: the name that selects it, the nominal timeline and whether the first
 * stage can come back (the booster path is only modeled for Falcon 9 so far). The ascent shape itself is shared.
 */
export interface VehicleProfile {
  id: string;
  /** shown as `ModeledAscent.vehicle` */
  name: string;
  /** tested against `<LL2 vehicle> <launch name>` */
  match: RegExp;
  exclude?: RegExp;
  /** the LL2 landing plan decides between droneship, RTLS and expended; otherwise the first stage is expended */
  recoverable: boolean;
  /** nominal timeline; `orbit` is `starlink` only for Falcon 9 Starlink missions */
  timeline(orbit: 'starlink' | 'generic'): Falcon9Timeline;
  /** first entry of `ModeledAscent.assumptions` */
  assumption: string;
}

export const VEHICLES = {
  falcon9: {
    id: 'falcon-9', name: 'Falcon 9', match: /falcon\s*9/i, exclude: /heavy/i, recoverable: true,
    timeline: (orbit) => defaultTimeline(orbit),
    assumption: 'Typical Falcon 9 / Starlink webcast figures, not a specific flight.',
  },
  electron: {
    id: 'electron', name: 'Electron', match: /\belectron\b/i, recoverable: false,
    // Rough public figures (Rocket Lab webcast timelines): first-stage burn about 2.5 minutes, a 6 minute second-stage burn.
    timeline: () => ({
      maxQSec: 65, mecoSec: 150, mecoAltKm: 78, mecoSpeedKmS: 2.5, sepDelaySec: 3, sesDelaySec: 6, fairingSec: 185,
      secoSec: 535, secoAltKm: 190, apogeeKm: 520, coastSec: 600,
    }),
    assumption: 'Approximate Electron figures from public webcast timelines (rough and unverified: expect errors of tens of seconds), not a specific flight. The kick stage burns are not modeled.',
  },
} as const satisfies Record<string, VehicleProfile>;

const VEHICLE_LIST: readonly VehicleProfile[] = [VEHICLES.falcon9, VEHICLES.electron];

/** The profile that models this launch's vehicle, or null when there is none (such launches stay at the pad). */
export function vehicleProfileFor(launch: Pick<Launch, 'vehicle' | 'name'>): VehicleProfile | null {
  const text = `${launch.vehicle ?? ''} ${launch.name}`;
  return VEHICLE_LIST.find((v) => v.match.test(text) && !v.exclude?.test(text)) ?? null;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const memo = new Map<string, ModeledAscent>();

/** Build the nominal Falcon 9 LEO ascent. Results are memoised by options (the model is pure). */
export function modelFalcon9Ascent(opts: Falcon9AscentOptions): ModeledAscent {
  return modelAscent(VEHICLES.falcon9, opts);
}

/** Build the nominal LEO ascent of `vehicle`. Results are memoised by vehicle and options (the model is pure). */
export function modelAscent(vehicle: VehicleProfile, opts: Falcon9AscentOptions): ModeledAscent {
  const key = `${vehicle.id}:${JSON.stringify(opts)}`;
  const hit = memo.get(key);
  if (hit) return hit;

  const profile = opts.profile ?? 'starlink';
  const tl: Falcon9Timeline = { ...vehicle.timeline(profile), ...opts.timeline };
  const branch = opts.branch ?? defaultBranch(opts.padLatDeg, opts.padLonDeg);
  const recovery: Recovery = vehicle.recoverable ? opts.recovery ?? 'droneship' : 'none';
  const stepSec = Math.max(0.5, opts.stepSec ?? 2);
  const sesSec = tl.mecoSec + tl.sesDelaySec;
  const sepSec = tl.mecoSec + tl.sepDelaySec;
  if (!(tl.secoSec > sesSec + 10) || !(tl.mecoSec > tl.maxQSec)) throw new Error(`inconsistent ${vehicle.name} timeline`);

  const inertialAz = inertialAzimuthDeg(opts.inclinationDeg, opts.padLatDeg, branch);
  const vSeco = secoSpeedKmS(tl, opts.padLatDeg, inertialAz);
  const azimuthDeg = groundAzimuthDeg(inertialAz, opts.padLatDeg, secoInertialSpeedKmS(tl));

  // first stage + coast: scale the reference keyframes to this MECO state
  const ts = tl.mecoSec / REF_MECO.sec, as = tl.mecoAltKm / REF_MECO.alt, vs = tl.mecoSpeedKmS / REF_MECO.speed;
  const xs = STAGE1_KEYFRAMES.map((k) => k[0] * ts);
  const alts = STAGE1_KEYFRAMES.map((k) => k[1] * as);
  const spds = STAGE1_KEYFRAMES.map((k) => k[2] * vs);
  const n = xs.length;
  const vzMeco = (alts[n - 1] - alts[n - 2]) / (xs[n - 1] - xs[n - 2]);
  const coast = sesSec - tl.mecoSec;
  xs.push(sesSec);
  alts.push(tl.mecoAltKm + vzMeco * coast - 0.5 * G_KM_S2 * coast * coast);
  spds.push(tl.mecoSpeedKmS - G_KM_S2 * coast * 0.45);
  const alt1 = pchip(xs, alts), spd1 = pchip(xs, spds);
  const alt0 = alts[alts.length - 1], v0 = spds[spds.length - 1];
  const altSeco = Math.max(tl.secoAltKm, alt0 + 1);
  const mu = 1 - 1 / STAGE2_MASS_RATIO;

  const altAt = (t: number): number => {
    if (t <= sesSec) return alt1(t);
    if (t >= tl.secoSec) return altSeco;
    const u = (t - sesSec) / (tl.secoSec - sesSec);
    return alt0 + (altSeco - alt0) * (1 - Math.pow(1 - u, STAGE2_ALT_K));
  };
  const speedAt = (t: number): number => {
    if (t <= sesSec) return spd1(t);
    if (t >= tl.secoSec) return vSeco;
    const u = (t - sesSec) / (tl.secoSec - sesSec);
    return v0 + (vSeco - v0) * (Math.log(1 / (1 - mu * u)) / Math.log(STAGE2_MASS_RATIO));
  };

  // booster timeline (typical)
  const booster = recovery === 'rtls'
    ? { boostback: 165, entry: 365, landingBurn: 440, landing: 465 }
    : { boostback: undefined, entry: 380, landingBurn: 475, landing: 500 };

  const events: AscentEvent[] = [
    { name: 'LIFTOFF', label: 'LIFTOFF', tSec: 0, track: 'vehicle' },
    { name: 'MAX_Q', label: 'MAX-Q', tSec: tl.maxQSec, track: 'vehicle', detail: 'maximum dynamic pressure' },
    { name: 'MECO', label: 'MECO', tSec: tl.mecoSec, track: 'vehicle', detail: 'first-stage main engine cutoff' },
    { name: 'STAGE_SEP', label: 'SEP', tSec: sepSec, track: 'vehicle', detail: 'stage separation' },
    { name: 'SES', label: 'SES', tSec: sesSec, track: 'vehicle', detail: 'second-stage engine start' },
    { name: 'FAIRING_SEP', label: 'FAIRING', tSec: tl.fairingSec, track: 'vehicle', detail: 'payload fairing separation' },
    { name: 'SECO', label: 'SECO', tSec: tl.secoSec, track: 'vehicle', detail: 'second-stage engine cutoff (SECO-1)' },
  ];
  if (recovery !== 'none') {
    if (booster.boostback !== undefined) events.push({ name: 'BOOSTBACK', label: 'BOOSTBACK', tSec: booster.boostback, track: 'booster', detail: 'booster boostback burn' });
    events.push(
      { name: 'ENTRY_BURN', label: 'ENTRY', tSec: booster.entry, track: 'booster', detail: 'booster entry burn' },
      { name: 'LANDING_BURN', label: 'LAND BURN', tSec: booster.landingBurn, track: 'booster', detail: 'booster landing burn' },
      { name: 'LANDING', label: 'LANDING', tSec: booster.landing, track: 'booster', detail: recovery === 'rtls' ? 'booster touchdown at the landing zone' : 'booster touchdown on the droneship' },
    );
  }
  events.sort((a, b) => a.tSec - b.tSec);

  // sample grid: uniform plus exact event instants and the end of the coast hold
  const end = tl.secoSec + tl.coastSec;
  const times = new Set<number>();
  for (let t = 0; t < end; t += stepSec) times.add(round3(t));
  times.add(end);
  for (const e of events) if (e.track === 'vehicle') times.add(round3(e.tSec));
  const grid = [...times].sort((a, b) => a - b);

  const base = grid.map((t) => ({ tSec: t, altKm: altAt(t), speedKmS: speedAt(t) }));
  const dr = reconstructDownrange(base);
  const rows: AscentRow[] = base.map((b, i) => ({ ...b, downrangeKm: dr[i].downrangeKm }));
  const at = (t: number) => rows.reduce((best, r) => (Math.abs(r.tSec - t) < Math.abs(best.tSec - t) ? r : best), rows[0]);
  for (const e of events) {
    if (e.track !== 'vehicle') continue;
    const r = at(e.tSec);
    e.altKm = r.altKm;
    e.speedKmS = r.speedKmS;
  }

  // booster return from the separation state; its events now lie on this track
  let boosterTrack: BoosterTrack | null = null;
  if (recovery !== 'none') {
    const a = sampleAscentRows(rows, sepSec)!;
    const vz = (sampleAscentRows(rows, sepSec + 1)!.altKm - sampleAscentRows(rows, sepSec - 1)!.altKm) / 2;
    boosterTrack = modelBoosterReturn(
      { sepSec, downrangeKm: a.downrangeKm, altKm: a.altKm, vxKmS: Math.sqrt(Math.max(0, a.speedKmS ** 2 - vz ** 2)), vzKmS: vz },
      { recovery, boostbackSec: booster.boostback, entrySec: booster.entry, landingBurnSec: booster.landingBurn, landingSec: booster.landing },
    );
    for (const e of events) {
      if (e.track !== 'booster') continue;
      const r = sampleAscentRows(boosterTrack.rows, e.tSec)!;
      e.altKm = r.altKm;
      e.speedKmS = r.speedKmS;
    }
  }

  const phases: AscentPhaseSpan[] = [
    { id: 'first-stage', label: 'FIRST STAGE', fromSec: 0, toSec: tl.mecoSec },
    { id: 'staging', label: 'STAGING', fromSec: tl.mecoSec, toSec: sesSec },
    { id: 'second-stage', label: 'SECOND STAGE', fromSec: sesSec, toSec: tl.secoSec },
    { id: 'orbit-coast', label: 'ORBIT (HELD)', fromSec: tl.secoSec, toSec: end },
  ];

  const out: ModeledAscent = {
    kind: 'modeled', label: MODELED_LABEL, vehicle: vehicle.name,
    inclinationDeg: opts.inclinationDeg, inclinationSource: opts.inclinationSource ?? 'explicit',
    branch, recovery, inertialAzimuthDeg: inertialAz, azimuthDeg, timeline: tl, rows, events, phases, booster: boosterTrack,
    assumptions: [
      vehicle.assumption,
      `Launch azimuth derived from inclination ${opts.inclinationDeg.toFixed(1)} deg at pad latitude ${opts.padLatDeg.toFixed(2)} deg (${branch === 'south' ? 'southward' : 'northward'} branch).`,
      'Event times and the speed/altitude curves can be off by tens of seconds and a few percent.',
      'After SECO the state is held constant; the real orbit rises towards apogee.',
      ...(boosterTrack ? [`Booster return path is a kinematic reconstruction through the event times, landing ${boosterTrack.landingDownrangeKm.toFixed(0)} km downrange (${recovery === 'rtls' ? 'landing zone near the pad' : 'typical droneship distance'}), not a measured track.`] : []),
    ],
  };
  if (memo.size > 64) memo.clear();
  memo.set(key, out);
  return out;
}

/** Linear interpolation of a profile at `tSec`; clamps to the first/last row. */
export function sampleAscentRows<T extends { tSec: number }>(rows: T[], tSec: number): T | undefined {
  if (!rows.length) return undefined;
  if (tSec <= rows[0].tSec) return rows[0];
  const last = rows[rows.length - 1];
  if (tSec >= last.tSec) return last;
  let lo = 0, hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].tSec <= tSec) lo = mid;
    else hi = mid;
  }
  const a = rows[lo], b = rows[hi];
  const u = (tSec - a.tSec) / (b.tSec - a.tSec);
  const out = { ...a } as Record<string, number>;
  for (const k of Object.keys(a)) {
    const av = (a as Record<string, unknown>)[k], bv = (b as Record<string, unknown>)[k];
    if (typeof av === 'number' && typeof bv === 'number') out[k] = av + (bv - av) * u;
  }
  out.tSec = tSec;
  return out as unknown as T;
}

/** Phase span containing `tSec` (undefined before liftoff or after the last span). */
export function ascentPhaseAt(phases: AscentPhaseSpan[], tSec: number): AscentPhaseSpan | undefined {
  return phases.find((p) => tSec >= p.fromSec && tSec < p.toSec) ?? (tSec === phases[phases.length - 1]?.toSec ? phases[phases.length - 1] : undefined);
}

/** `EntityEvent`s (absolute ms) for the vehicle and booster events of an ascent. */
export function ascentEntityEvents(events: AscentEvent[], liftoffMs: number, tag = 'MODELED nominal'): EntityEvent[] {
  return events.map((e) => ({
    tMs: Math.round(liftoffMs + e.tSec * 1000),
    name: e.name,
    detail: [e.detail, e.track === 'booster' ? 'booster' : undefined, e.reported ? 'reported' : tag].filter(Boolean).join('; '),
  }));
}

// ---------------------------------------------------------------- wire type

/** Where the entity's trajectory comes from. */
export type TrajectorySource = 'modeled' | 'file' | 'live';

/** Measured rows posted to `POST /api/telemetry/:launchId`, kept with their reconstructed downrange. */
export interface LiveAscent {
  rows: AscentRow[];
  /** events reported with the rows (e.g. a MECO read from the webcast); they override modeled ones */
  events: AscentEvent[];
  updatedAt: number;
  source?: string;
  azimuthDeg?: number;
}

/** Response of `GET /api/telemetry/:launchId`: the plan (modeled or file) next to anything measured. */
export interface AscentSeries {
  launchId: string;
  entityId: string;
  /** NET, ms: T+0 of every series */
  liftoffMs: number;
  /** which series currently drives the launch entity's path (null: none, e.g. a non-Falcon 9 launch without a file) */
  source: TrajectorySource | null;
  modeled: ModeledAscent | null;
  file: { id: string; source?: string; rows: { tSec: number; altKm: number; downrangeKm: number }[] } | null;
  live: (LiveAscent & { lastTSec: number; extrapolatedFromSec: number | null }) | null;
}

// ---------------------------------------------------------------- launch mapping + provider segments

const DAY_MS = 86_400_000;

export interface AscentSegmentBoundary {
  /** label shown on the globe path where this segment starts */
  phase: string;
  fromSec: number;
  /** 0..1 trust of this segment's samples (extrapolated stretches use less than 1) */
  confidence?: number;
}

/**
 * Pad (geodetic, until liftoff) followed by one `sampled` EARTH:fixed segment per boundary. `rows`
 * need `downrangeKm`; the azimuth turns them into a ground track from the pad. Segments overlap by
 * exactly one sample so that every time between the first and last row is covered.
 */
export function ascentCompositeSegments(
  netMs: number,
  pad: { latDeg: number; lonDeg: number },
  azimuthDeg: number,
  rows: { tSec: number; altKm: number; downrangeKm: number }[],
  boundaries: AscentSegmentBoundary[],
  opts: { trailingPad?: boolean; trailingAt?: { latDeg: number; lonDeg: number; phase: string } } = {},
): CompositeSegment[] {
  const samples: Sample[] = profileToFixedSamples(EARTH, pad, azimuthDeg, netMs, rows);
  const padSpec = { type: 'geodetic', bodyId: 'EARTH', latDeg: pad.latDeg, lonDeg: pad.lonDeg, altKm: 0 } as const;
  const segments: CompositeSegment[] = [{ fromMs: netMs - 30 * DAY_MS, toMs: netMs - 1, phase: 'pad', spec: padSpec }];
  const lastMs = samples[samples.length - 1][0];
  boundaries.forEach((b, i) => {
    const fromMs = netMs + b.fromSec * 1000;
    const nextMs = i + 1 < boundaries.length ? netMs + boundaries[i + 1].fromSec * 1000 : lastMs;
    const slice = samples.filter((s) => s[0] >= fromMs && s[0] <= nextMs);
    if (slice.length < 2) return;
    segments.push({
      fromMs, toMs: i + 1 < boundaries.length ? nextMs - 1 : nextMs, phase: b.phase,
      spec: { type: 'sampled', frame: 'EARTH:fixed', samples: slice, ...(b.confidence !== undefined ? { confidence: b.confidence } : {}) },
    });
  });
  // After the modeled ascent the entity would vanish (launch board cards, search and fly-to need a position),
  // so it goes back to the pad marker, as launch entities without any trajectory always were.
  if (opts.trailingPad) segments.push({ fromMs: lastMs + 1, toMs: netMs + 30 * DAY_MS, phase: 'pad (launch complete)', spec: padSpec });
  else if (opts.trailingAt) {
    const { latDeg, lonDeg, phase } = opts.trailingAt;
    segments.push({ fromMs: lastMs + 1, toMs: netMs + 30 * DAY_MS, phase, spec: { type: 'geodetic', bodyId: 'EARTH', latDeg, lonDeg, altKm: 0 } });
  }
  return segments;
}

/** Segment boundaries (named for the globe path labels) of a modeled ascent. */
export function modeledSegmentBoundaries(m: ModeledAscent): AscentSegmentBoundary[] {
  const names: Record<AscentPhaseSpan['id'], string> = {
    'first-stage': 'stage 1 ascent', staging: 'staging', 'second-stage': 'stage 2 burn', 'orbit-coast': 'orbit (held)',
  };
  return m.phases.map((p) => ({ phase: names[p.id], fromSec: p.fromSec }));
}

export function modeledAscentSegments(netMs: number, pad: { latDeg: number; lonDeg: number }, m: ModeledAscent): CompositeSegment[] {
  return ascentCompositeSegments(netMs, pad, m.azimuthDeg, m.rows, modeledSegmentBoundaries(m), { trailingPad: true });
}

/** Ground point where the modeled booster touches down (along the launch azimuth from the pad). */
export function boosterLandingPoint(pad: { latDeg: number; lonDeg: number }, m: ModeledAscent): { latDeg: number; lonDeg: number } | null {
  return m.booster ? destinationPoint(pad.latDeg, pad.lonDeg, m.azimuthDeg, m.booster.landingDownrangeKm, EARTH.radiusKm) : null;
}

/**
 * Pad, the vehicle's ascent up to stage separation, the booster's return (coast, boostback or trim, entry burn, landing
 * burn) and then parked at the landing point. Null when the first stage is expended.
 */
export function modeledBoosterSegments(netMs: number, pad: { latDeg: number; lonDeg: number }, m: ModeledAscent): CompositeSegment[] | null {
  const b = m.booster;
  const land = boosterLandingPoint(pad, m);
  if (!b || !land) return null;
  const sep = b.rows[0].tSec;
  const rows = [...m.rows.filter((r) => r.tSec < sep), ...b.rows];
  const names = { coast: 'coast', boostback: 'boostback burn', trim: 'trim burn', entry: 'entry burn', 'landing-burn': 'landing burn' } as const;
  const boundaries: AscentSegmentBoundary[] = [{ phase: 'stage 1 ascent', fromSec: 0 }, ...b.phases.map((p) => ({ phase: names[p.id], fromSec: p.fromSec }))];
  return ascentCompositeSegments(netMs, pad, m.azimuthDeg, rows, boundaries, { trailingAt: { ...land, phase: 'landed' } });
}

const landingOf = (launch: Launch): Recovery => {
  const l = launch.landing;
  if (!l) return 'droneship';
  if (!l.attempt) return 'none';
  if (/rtls/i.test(l.type ?? '') || /^lz/i.test(l.location ?? '')) return 'rtls';
  return 'droneship';
};

/** True for Falcon 9 launches (not Falcon Heavy) the model applies to. */
export function isFalcon9(launch: Pick<Launch, 'vehicle' | 'name'>): boolean {
  const text = `${launch.vehicle ?? ''} ${launch.name}`;
  return /falcon\s*9/i.test(text) && !/heavy/i.test(text);
}

/** Nominal ascent for a launch of a vehicle with a profile (Falcon 9, Electron) and a known pad, else null. Inclination comes from `defaultInclination`. */
export function modeledAscentForLaunch(launch: Launch): ModeledAscent | null {
  const vehicle = vehicleProfileFor(launch);
  if (!launch.pad || !vehicle) return null;
  const inc = defaultInclination({
    name: launch.name, missionName: launch.mission?.name, orbit: launch.mission?.orbit,
    description: launch.mission?.description, padLatDeg: launch.pad.latitude, padLonDeg: launch.pad.longitude,
  });
  return modelAscent(vehicle, {
    padLatDeg: launch.pad.latitude, padLonDeg: launch.pad.longitude,
    inclinationDeg: inc.deg, inclinationSource: inc.source,
    recovery: landingOf(launch),
    profile: vehicle === VEHICLES.falcon9 && /starlink/i.test(`${launch.mission?.name ?? ''} ${launch.name}`) ? 'starlink' : 'generic',
  });
}
