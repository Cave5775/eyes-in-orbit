import { ISS_CHANNELS, type IssArrays, type IssChannel } from '@eio/core';
import { lvlhBasis, rotateByQuaternion, toBody, type Basis } from './attitude';
import type { V3 } from './camera';

/**
 * ISS solar array pose: where the SARJ (solar alpha rotary joints, one per side, one turn per orbit) and the BGAs (beta
 * gimbal assemblies, one per wing, eight wings) point, either from the live ISSLIVE telemetry or computed so the arrays face the
 * Sun. Pure maths, radians internally, degrees at the edges. Body frame: +X forward, +Y starboard, +Z nadir (see attitude.ts).
 *
 * Model convention (matches `scene/models/iss.ts`):
 *  - SARJ angle alpha turns an outboard truss about +Y. At alpha = 0 the arrays' long axes point along +Z and the cell
 *    side faces +X (forward); the cell-side normal is n(alpha) = (cos a, 0, -sin a), the long axis u(alpha) = (sin a, 0, cos a).
 *  - BGA angle gamma turns one wing about its long axis (+Z at alpha = 0); the cell-side normal becomes
 *    cos(g) n(alpha) + sin(g) (0, 1, 0).
 * Sun tracking: n(alpha) along the Sun's projection on the XZ plane, gamma = asin(sun.y).
 */

/** Radians of the SARJ and BGA joints of the model, plus where each came from. */
export type ArraySource = 'LIVE' | 'COMPUTED' | 'STATIC';

const DEG = Math.PI / 180;
export const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;
/** Signed difference a - b wrapped into [-180, 180). */
export const angleDiffDeg = (a: number, b: number): number => ((((a - b) % 360) + 540) % 360) - 180;

/** Sun-tracking joint angles (radians) for a unit sun vector in the body frame. */
export function sunTrackingAngles(sunBody: V3): { alpha: number; gamma: number } {
  const alpha = Math.atan2(-sunBody[2], sunBody[0]);
  const gamma = Math.asin(Math.max(-1, Math.min(1, sunBody[1])));
  return { alpha, gamma };
}

/**
 * Model SARJ angle (degrees, 0..360) for a live SARJ reading. VERIFIED against live data (docs/reference.md): the starboard reading
 * is the computed sun-tracking angle minus 90 degrees, the port reading is 90 degrees minus it (mirrored convention).
 */
export function sarjLiveToAlphaDeg(side: 'port' | 'starboard', liveDeg: number): number {
  return wrap360(side === 'starboard' ? liveDeg + 90 : 90 - liveDeg);
}

/** Inverse of `sarjLiveToAlphaDeg`: the feed's SARJ reading for a model angle. */
export function alphaToSarjLiveDeg(side: 'port' | 'starboard', alphaDeg: number): number {
  return wrap360(side === 'starboard' ? alphaDeg - 90 : 90 - alphaDeg);
}

/** Wing sides: which array pair (site) and side each power channel sits on (`scene/models/iss.ts` places them). */
export const CHANNEL_SITE: Readonly<Record<IssChannel, { site: 'P4' | 'P6' | 'S4' | 'S6'; side: 'port' | 'starboard' }>> = {
  '1A': { site: 'S4', side: 'starboard' }, '3A': { site: 'S4', side: 'starboard' },
  '1B': { site: 'S6', side: 'starboard' }, '3B': { site: 'S6', side: 'starboard' },
  '2A': { site: 'P4', side: 'port' }, '4A': { site: 'P4', side: 'port' },
  '2B': { site: 'P6', side: 'port' }, '4B': { site: 'P6', side: 'port' },
};

export interface ArrayContext {
  /** the simulation clock follows real time (live mode); scrubbed or paused time must not show live joints */
  liveClock: boolean;
  /** wall-clock now, ms */
  nowMs: number;
  /** the ISS has a state (attitude and sun direction can be computed) */
  haveState: boolean;
}

/** Newest-sample age beyond which the feed counts as down, ms. The SARJ items update about once a second. */
export const LIVE_MAX_AGE_MS = 30_000;

export interface ArraySources {
  sarj: ArraySource;
  bga: ArraySource;
  /** the live attitude quaternion applies */
  attitude: boolean;
}

/** Which source drives each part: LIVE only for fresh, verified feed values at live clock time, else COMPUTED, else STATIC. */
export function arraySources(arrays: IssArrays | undefined, ctx: ArrayContext): ArraySources {
  const fresh = !!arrays && ctx.liveClock && ctx.nowMs - arrays.t < LIVE_MAX_AGE_MS;
  const sarjLive = fresh && arrays!.verified.sarj && (arrays!.sarj.port !== undefined || arrays!.sarj.starboard !== undefined);
  const bgaLive = fresh && arrays!.verified.bga && ISS_CHANNELS.some((c) => arrays!.bga[c] !== undefined);
  const fallback: ArraySource = ctx.haveState ? 'COMPUTED' : 'STATIC';
  return {
    sarj: sarjLive ? 'LIVE' : fallback,
    bga: bgaLive ? 'LIVE' : fallback,
    attitude: fresh && arrays!.verified.attitude && !!arrays!.attitude && ctx.haveState,
  };
}

/** Headline for the UI: one word when both agree, else `SARJ x / BGA y`. */
export function sourceLabel(s: ArraySources): string {
  return s.sarj === s.bga ? s.sarj : `SARJ ${s.sarj} / BGA ${s.bga}`;
}

/** Joint name -> radians for the ISS model. */
export type IssJoints = Record<string, number>;

export interface IssPoseInput {
  sunBody: V3 | null;
  /** live SARJ readings (degrees) already smoothed to now, used when `sources.sarj` is LIVE */
  sarjLive?: { port?: number; starboard?: number };
  sources: ArraySources;
}

/** All ten joint angles of the ISS model (STATIC leaves every joint at zero). */
export function issJoints({ sunBody, sarjLive, sources }: IssPoseInput): IssJoints {
  const j: IssJoints = { 'sarj.port': 0, 'sarj.stbd': 0 };
  for (const c of ISS_CHANNELS) j[`bga.${c}`] = 0;
  if (!sunBody) return j;
  const t = sunTrackingAngles(sunBody);
  const alphaPort = sources.sarj === 'LIVE' && sarjLive?.port !== undefined ? sarjLiveToAlphaDeg('port', sarjLive.port) * DEG : t.alpha;
  const alphaStbd = sources.sarj === 'LIVE' && sarjLive?.starboard !== undefined ? sarjLiveToAlphaDeg('starboard', sarjLive.starboard) * DEG : t.alpha;
  j['sarj.port'] = alphaPort;
  j['sarj.stbd'] = alphaStbd;
  // BGA live values are not verified (docs/reference.md), so every wing takes the computed beta tilt
  for (const c of ISS_CHANNELS) j[`bga.${c}`] = t.gamma;
  return j;
}

/** The Sun in the body frame: LVLH basis, then the live attitude quaternion (body to LVLH, [w, x, y, z]) if it applies. */
export function sunInBody(lvlh: Basis, sunDir: V3, attitudeWxyz?: readonly number[]): V3 {
  const s = toBody(lvlh, sunDir);
  if (!attitudeWxyz) return s;
  const [w, x, y, z] = attitudeWxyz;
  return rotateByQuaternion([-x, -y, -z, w], s); // inverse rotation: LVLH -> body
}

/** Sun in the body frame from an inertial state (flight attitude, or with the live quaternion). */
export function sunInBodyFromState(r: V3, v: V3, sunDir: V3, attitudeWxyz?: readonly number[]): V3 | null {
  const b = lvlhBasis(r, v);
  return b ? sunInBody(b, sunDir, attitudeWxyz) : null;
}

/** What the readout shows: SARJ in the feed's convention, BGA as a tilt (computed) or the raw feed value. */
export interface ArrayReadout {
  sources: ArraySources;
  sarj: { port?: number; starboard?: number };
  /** per channel, degrees: the feed's raw value when present, else the computed tilt; `computed` says which */
  bga: Partial<Record<IssChannel, { deg: number; computed: boolean }>>;
}

export function arrayReadout(arrays: IssArrays | undefined, sunBody: V3 | null, sources: ArraySources, sarjLive?: { port?: number; starboard?: number }): ArrayReadout {
  const out: ArrayReadout = { sources, sarj: {}, bga: {} };
  const t = sunBody ? sunTrackingAngles(sunBody) : null;
  if (sources.sarj === 'LIVE') out.sarj = { port: sarjLive?.port ?? arrays?.sarj.port, starboard: sarjLive?.starboard ?? arrays?.sarj.starboard };
  else if (t) out.sarj = { port: alphaToSarjLiveDeg('port', t.alpha / DEG), starboard: alphaToSarjLiveDeg('starboard', t.alpha / DEG) };
  for (const c of ISS_CHANNELS) {
    const raw = arrays?.bga[c];
    if (raw !== undefined) out.bga[c] = { deg: raw, computed: false };
    else if (t) out.bga[c] = { deg: t.gamma / DEG, computed: true };
  }
  return out;
}

/**
 * Smooths the feed's samples (SARJ values arrive about once a second) into a continuous angle: between samples the
 * joint is extrapolated at the rate seen over the last two samples (item timestamps give the rate, the client's receipt time
 * gives how long ago the last sample was), capped so a missed update cannot run away.
 */
export class IssArrayTracker {
  private last: { arrays: IssArrays; wall: number } | null = null;
  private prev: IssArrays | null = null;
  /** deg/s, SARJ rate cap (orbital rate is 0.065) */
  static readonly MAX_RATE = 0.3;
  /** seconds of extrapolation after the last sample */
  static readonly MAX_EXTRAP_S = 3;

  /** Feed a message; messages with the same sample time are ignored. */
  push(arrays: IssArrays | undefined, wallMs: number): void {
    if (!arrays) {
      this.last = this.prev = null;
      return;
    }
    if (this.last && arrays.t === this.last.arrays.t) {
      this.last = { arrays, wall: this.last.wall };
      return;
    }
    this.prev = this.last?.arrays ?? null;
    this.last = { arrays, wall: wallMs };
  }

  get arrays(): IssArrays | undefined {
    return this.last?.arrays;
  }

  sarjDeg(side: 'port' | 'starboard', wallMs: number): number | undefined {
    const cur = this.last?.arrays.sarj[side];
    if (cur === undefined || !this.last) return undefined;
    const before = this.prev?.sarj[side];
    const dtItem = this.prev ? (this.last.arrays.t - this.prev.t) / 1000 : 0;
    if (before === undefined || !(dtItem > 0.05) || dtItem > 10) return cur;
    const rate = Math.max(-IssArrayTracker.MAX_RATE, Math.min(IssArrayTracker.MAX_RATE, angleDiffDeg(cur, before) / dtItem));
    const ahead = Math.max(0, Math.min(IssArrayTracker.MAX_EXTRAP_S, (wallMs - this.last.wall) / 1000));
    return wrap360(cur + rate * ahead);
  }

  sarj(wallMs: number): { port?: number; starboard?: number } {
    return { port: this.sarjDeg('port', wallMs), starboard: this.sarjDeg('starboard', wallMs) };
  }
}
