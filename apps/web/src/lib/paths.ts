import { EARTH, convert, defaultBodies, type CompositeSegment, type FrameId, type ProviderSpec, type StateVector, type Vec3 } from '@eio/core';
import { framePathPoint, type FrameSampler } from './frame';

/**
 * Path sampling for entities that are not SGP4: pure, no three.js. A path is `provider.stateAt` evaluated
 * over a time window around "now" (past trail + future prediction), converted for display.
 *
 * Display frame: the scene is Earth-inertial and the Earth mesh rotates by GMST. A provider defined in
 * `EARTH:fixed` (launch ascents and landing boosters, a landing burn relative to a pad) describes motion
 * relative to the ground. Drawn in the inertial frame a booster standing on its landing pad would leave a
 * 460 m/s eastward streak, and an ascent would be sheared by the Earth's rotation. So when every sample is
 * native `EARTH:fixed` and the window is short (<= 45 min, <= 11 degrees of rotation) the path is returned
 * in the body-fixed frame and the scene attaches it to the rotating Earth group; the marker (evaluated at
 * "now") sits exactly on it. A whole planned launch flight (anchored plan) is also drawn body-fixed when its tail is a
 * Keplerian orbit continuation: the inertial tail is converted to EARTH:fixed sample by sample, so the line stays one
 * continuous ground-glued polyline from the pad through SECO into the first part of the orbit. Everything else (probes, Keplerian, sampled inertial) is converted to
 * `EARTH:inertial`, like the rest of the scene.
 */

/** Soft cap on points per path (plus a few extra exactly on composite phase boundaries). */
export const PATH_MAX_POINTS = 480;
export const PATH_MAX_PHASES = 10;
export const PATH_BUFFER_CAPACITY = PATH_MAX_POINTS + 2 * PATH_MAX_PHASES + 8;
/** Longest window for which a body-fixed provider is still drawn in the body-fixed frame. */
export const FIXED_FRAME_MAX_WINDOW_MS = 45 * 60_000;
/**
 * Markers and lines at ground level are nudged this far off the surface (a few metres: the Earth mesh is inscribed in the
 * ellipsoid, so it never pokes above the true surface; this only covers float32 noise in the mesh vertices). Markers
 * are drawn without depth testing and hidden analytically by the Earth, so they need no lift of their own.
 */
export const GROUND_LIFT_KM = 0.005;
/** A path whose extent stays under this (km) is treated as stationary and not drawn. */
export const MIN_PATH_EXTENT_KM = 0.02;

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

export interface PathPlan {
  t0: number;
  t1: number;
  /** a whole planned trajectory, fixed in time: it does not slide with the clock, so it is never rebuilt for that */
  anchored?: boolean;
}

export interface PathHints {
  validRange?: [number, number];
  /** `render.trailSeconds`: how much past to show for short-scale paths. */
  trailSeconds?: number;
  /**
   * The path is drawn relative to a frame centre that moves (not the Earth): an object standing on the ground (geodetic) then
   * moves in that frame, so it gets a window of its own: its window is three hours each way.
   */
  framed?: boolean;
}

function specRange(spec: ProviderSpec): [number, number] | undefined {
  if (spec.type === 'sampled' && spec.samples.length) {
    let lo = Infinity, hi = -Infinity;
    for (const s of spec.samples) {
      if (s[0] < lo) lo = s[0];
      if (s[0] > hi) hi = s[0];
    }
    return [lo, hi];
  }
  if (spec.type === 'composite' && spec.segments.length) {
    return [Math.min(...spec.segments.map((s) => s.fromMs)), Math.max(...spec.segments.map((s) => s.toMs))];
  }
  return undefined;
}

function clip(t0: number, t1: number, range?: [number, number]): PathPlan | null {
  if (range) {
    t0 = Math.max(t0, range[0]);
    t1 = Math.min(t1, range[1]);
  }
  return t1 > t0 ? { t0, t1 } : null;
}

/**
 * The planned flight of a composite made only of geodetic holds, sampled trajectories and (after the ascent) a keplerian
 * continuation: a launch ascent that goes on in the modeled orbit (`on orbit (modeled)`, 12 h) or a booster return between
 * its pad and its landing point. It is the run of abutting sampled / keplerian segments nearest to `nowMs` (the one in
 * progress, else the next to fly, else the last flown) that holds at least one sampled segment (a payload's keplerian-only
 * composite is no planned flight: it has its orbit line). Null for any other composite, and for a sampled flight too long to
 * be drawn on the rotating ground (see FIXED_FRAME_MAX_WINDOW_MS).
 *
 * The orbit tail is drawn only as far as the same limit reaches, counted from the start of the run: the whole planned path
 * is one body-fixed polyline (the ascent stays glued to the ground), and a 12 h ribbon would be neither readable nor
 * correct in that frame. For Falcon 9 that is the 18.5 minute ascent plus about 26 minutes (a third of an orbit) of the
 * orbit, so the line visibly carries on past SECO; the full orbit is the orbit line (`EntityOverlay`) of the vehicle and of
 * its payload.
 */
function plannedFlight(spec: ProviderSpec, nowMs: number): PathPlan | null {
  const segs = compositePhases(spec);
  if (!segs.length || !segs.every((s) => s.spec.type === 'geodetic' || s.spec.type === 'sampled' || s.spec.type === 'keplerian')) return null;
  // from, to: the abutting run; sampledTo: where its last sampled segment ends (the flight proper, before any orbit tail)
  const runs: { from: number; to: number; sampledTo: number }[] = [];
  for (const s of segs) {
    if (s.spec.type === 'geodetic') continue;
    const sampled = s.spec.type === 'sampled';
    const last = runs[runs.length - 1];
    if (last && s.fromMs - last.to <= 1000) {
      last.to = Math.max(last.to, s.toMs);
      if (sampled) last.sampledTo = Math.max(last.sampledTo, s.toMs);
    } else runs.push({ from: s.fromMs, to: s.toMs, sampledTo: sampled ? s.toMs : s.fromMs });
  }
  const flights = runs.filter((r) => r.sampledTo > r.from);
  const run = flights.find((r) => nowMs >= r.from && nowMs <= r.to) ?? flights.find((r) => r.from > nowMs) ?? flights[flights.length - 1];
  if (!run || run.sampledTo - run.from > FIXED_FRAME_MAX_WINDOW_MS) return null;
  return { t0: run.from, t1: Math.min(run.to, run.from + FIXED_FRAME_MAX_WINDOW_MS) };
}

/**
 * Time window to draw for a provider, or null when no path applies (SGP4 has its orbit line, geodetic points do not move
 * unless the frame centre does: `hints.framed`, -3 h .. +3 h).
 *  - sampled, long (>= 6 h, e.g. Horizons ephemerides): the whole valid range within -1 d .. +2 d;
 *  - composite of pad holds and sampled flight (launch ascent, booster return): the whole planned flight, whenever it is,
 *    plus the first part of a keplerian orbit continuation (see `plannedFlight`);
 *  - sampled, short (landing arcs, trajectory samples) and other composites: -max(trail, 5 min) .. +10 min;
 *  - relative (drone near a rover): -max(trail, 3 min) .. +3 min;
 *  - keplerian: -1/4 .. +1 period.
 */
export function planPathWindow(spec: ProviderSpec | undefined, nowMs: number, hints: PathHints = {}): PathPlan | null {
  if (!spec || spec.type === 'sgp4') return null;
  if (spec.type === 'geodetic') return hints.framed ? { t0: nowMs - 3 * HOUR, t1: nowMs + 3 * HOUR } : null;
  const range = hints.validRange ?? specRange(spec);
  const trail = (hints.trailSeconds ?? 0) * 1000;
  switch (spec.type) {
    case 'sampled': {
      if (range && range[1] - range[0] >= 6 * HOUR) return clip(nowMs - DAY, nowMs + 2 * DAY, range);
      return clip(nowMs - Math.max(trail, 5 * MIN), nowMs + 10 * MIN, range);
    }
    case 'composite': {
      // a window around now would hold only the standing pad for the days before liftoff
      const flight = plannedFlight(spec, nowMs);
      if (flight) {
        const c = clip(flight.t0, flight.t1, range);
        return c && { ...c, anchored: true };
      }
      return clip(nowMs - Math.max(trail, 5 * MIN), nowMs + 10 * MIN, range);
    }
    case 'relative':
      return clip(nowMs - Math.max(trail, 3 * MIN), nowMs + 3 * MIN, range);
    case 'keplerian': {
      let period = HOUR;
      try {
        const gm = defaultBodies.get(spec.bodyId).gm;
        period = 2 * Math.PI * Math.sqrt(spec.elements.a ** 3 / gm) * 1000;
      } catch {
        // unknown body: fall through with a generic hour
      }
      period = Math.min(Math.max(period, 10 * MIN), 30 * DAY);
      return clip(nowMs - period * 0.25, nowMs + period, range);
    }
    default:
      return clip(nowMs - HOUR, nowMs + HOUR, range);
  }
}

/** True when the plan should be rebuilt: the window has slid by more than a tenth of its length. */
export function pathStale(builtAtMs: number, nowMs: number, plan: PathPlan | null): boolean {
  if (!plan || plan.anchored) return false;
  return Math.abs(nowMs - builtAtMs) > Math.max(1000, (plan.t1 - plan.t0) * 0.1);
}

export interface PathBuffers {
  /** xyz per point, display space (km), float64: the scene re-bases it on the camera every frame */
  pos: Float64Array;
  /** sample time per point (ms), ascending */
  times: Float64Array;
}

export const makePathBuffers = (): PathBuffers => ({
  pos: new Float64Array(PATH_BUFFER_CAPACITY * 3),
  times: new Float64Array(PATH_BUFFER_CAPACITY),
});

export interface PathPhase {
  name: string;
  tMs: number;
  /** index into the buffers of the point at `tMs` */
  index: number;
}

export interface PathResult {
  count: number;
  /** `fixed`: attach to the rotating Earth; `inertial`: world frame */
  frame: 'fixed' | 'inertial';
  /** extent exceeds MIN_PATH_EXTENT_KM (a path of a stationary object is not worth drawing) */
  moving: boolean;
  plan: PathPlan;
  phases: PathPhase[];
  /**
   * The centre's Earth-inertial position the points were drawn around (null: Earth centre or no frame). The scene shifts
   * the buffer by c(now) - centreRef every frame so the path follows its centre between rebuilds.
   */
  centreRef: Vec3 | null;
}

export interface PathSource {
  stateOf(id: string, tMs: number): StateVector | null;
}

/** Lift a near-surface position off the sphere (identical to the scene's marker nudge so markers lie on paths). */
export function liftNearSurface(r: Vec3, liftKm = GROUND_LIFT_KM): Vec3 {
  const n = Math.hypot(r[0], r[1], r[2]);
  if (n === 0) return r;
  const s = r[2] / n;
  const alt = n - EARTH.radiusKm * (1 - EARTH.flattening * s * s);
  if (alt >= liftKm * 2) return r;
  const k = (n + liftKm * (1 - Math.max(0, alt) / (liftKm * 2))) / n;
  return [r[0] * k, r[1] * k, r[2] * k];
}

/** Phase labels of a composite spec, in order. */
function compositePhases(spec: ProviderSpec | undefined): CompositeSegment[] {
  return spec?.type === 'composite' ? [...spec.segments].sort((a, b) => a.fromMs - b.fromMs) : [];
}

/** Largest index i with times[i] <= t, or -1 when t precedes the first sample. */
export function nowIndex(times: ArrayLike<number>, count: number, t: number): number {
  let lo = 0, hi = count - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** The ascending sample times for a plan: a uniform grid plus exact composite phase boundaries (deduplicated, capped). */
export function sampleTimes(plan: PathPlan, spec: ProviderSpec | undefined, maxPoints = PATH_MAX_POINTS): number[] {
  const n = Math.max(2, maxPoints);
  const times: number[] = [];
  for (let i = 0; i < n; i++) times.push(plan.t0 + ((plan.t1 - plan.t0) * i) / (n - 1));
  const extra: number[] = [];
  for (const seg of compositePhases(spec)) {
    for (const t of [seg.fromMs, seg.toMs]) if (t > plan.t0 && t < plan.t1) extra.push(t);
  }
  if (extra.length > 2 * PATH_MAX_PHASES) extra.length = 2 * PATH_MAX_PHASES;
  const all = times.concat(extra).sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of all) if (!out.length || t - out[out.length - 1] > 0.5) out.push(t);
  return out;
}

/**
 * Evaluate the entity over `plan` into `buf`. Samples with no state are skipped. See the module comment for
 * the display frame; inertial points are drawn at their true position (with the ground lift), like the marker.
 */
export function samplePath(
  src: PathSource, id: string, plan: PathPlan, spec: ProviderSpec | undefined, buf: PathBuffers,
  inFrame?: FrameSampler,
): PathResult {
  // in a frame centred away from the Earth a sample is r(t_i) - c(t_i) + c(ref): inertial only (the Earth-fixed
  // shortcut below is for the Earth centre), and nothing can be drawn while the centre has no position at `ref`
  if (inFrame && !inFrame.ref) return { count: 0, frame: 'inertial', moving: false, plan, phases: [], centreRef: null };
  const wanted = sampleTimes(plan, spec, Math.min(PATH_MAX_POINTS, buf.times.length - 2 * PATH_MAX_PHASES));
  const states: { t: number; s: StateVector }[] = [];
  for (const t of wanted) {
    const s = src.stateOf(id, t);
    if (s) states.push({ t, s });
  }

  const allFixed = !inFrame && states.length > 0 && states.every((x) => x.s.frame === 'EARTH:fixed');
  // a planned flight (anchored) is body-fixed as a whole even where its orbit tail is natively inertial: the tail is converted
  // sample by sample, so the line is continuous at SECO and glued to the ground like its ascent
  const planned = !inFrame && !!plan.anchored && states.length > 0;
  const frame: 'fixed' | 'inertial' = (allFixed || planned) && plan.t1 - plan.t0 <= FIXED_FRAME_MAX_WINDOW_MS ? 'fixed' : 'inertial';

  let n = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let moving = false;
  for (const { t, s } of states) {
    let r: Vec3;
    let fixedR = s.r;
    if (frame === 'fixed') {
      if (s.frame !== 'EARTH:fixed') {
        try {
          fixedR = convert(s, 'EARTH:fixed' as FrameId, t).r;
        } catch {
          continue;
        }
      }
      r = liftNearSurface(fixedR);
    } else {
      let inertial = s;
      try {
        inertial = convert(s, 'EARTH:inertial' as FrameId, t);
      } catch {
        continue;
      }
      let p = inertial.r;
      if (inFrame) {
        const c = inFrame.centreAt(t);
        if (!c) continue;
        p = framePathPoint(p, c, inFrame.ref!);
      }
      r = liftNearSurface(p);
    }
    if (!(Number.isFinite(r[0]) && Number.isFinite(r[1]) && Number.isFinite(r[2]))) continue;
    buf.pos[n * 3] = r[0];
    buf.pos[n * 3 + 1] = r[1];
    buf.pos[n * 3 + 2] = r[2];
    buf.times[n] = t;
    n++;
    // extent: in the native fixed frame when every sample is fixed (a landed booster is stationary there)
    const e = allFixed || frame === 'fixed' ? fixedR : r;
    minX = Math.min(minX, e[0]); maxX = Math.max(maxX, e[0]);
    minY = Math.min(minY, e[1]); maxY = Math.max(maxY, e[1]);
    minZ = Math.min(minZ, e[2]); maxZ = Math.max(maxZ, e[2]);
  }
  if (n > 1) moving = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) > MIN_PATH_EXTENT_KM;

  const phases: PathPhase[] = [];
  if (n > 1) {
    for (const seg of compositePhases(spec)) {
      if (!seg.phase || seg.fromMs <= plan.t0 || seg.fromMs >= plan.t1) continue;
      const i = nowIndex(buf.times, n, seg.fromMs - 0.5) + 1; // epoch-ms doubles have ~0.2 ms resolution: stay above it
      if (i < n && Math.abs(buf.times[i] - seg.fromMs) < 0.5) phases.push({ name: seg.phase, tMs: seg.fromMs, index: i });
      if (phases.length >= PATH_MAX_PHASES) break;
    }
  }
  return { count: n, frame, moving, plan, phases, centreRef: inFrame?.ref ?? null };
}
