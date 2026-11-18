import type { DevOptionDef, DevValues } from './dev-options';

/**
 * Camera motion smoothing (pure maths, no three.js). Pointer and wheel input is not applied to the camera at once: it is added
 * to a `Damper`, and every frame a fraction `1 - exp(-dt / tau)` of what is still pending is applied. That makes the motion
 * eased and, because the pending amount keeps draining after the pointer is released, gives it inertia. The decay is exponential in
 * real time, so the remaining amount after T seconds is `pending * exp(-T / tau)` whatever the frame rate (30 or 144 fps).
 */

export interface SmoothParams {
  /** damping time constants, seconds: after one `tau` about 63% of the pending motion has been applied */
  orbitTau: number;
  zoomTau: number;
  panTau: number;
  /** keep gliding after the pointer is released; off: what is pending is applied at once on release */
  inertia: boolean;
  /** pending motion slower than this (pixels per second; the wheel's units for zoom) is applied at once, so it never creeps forever */
  cutoff: number;
}

export const SMOOTH_DEFAULTS: SmoothParams = { orbitTau: 0.12, zoomTau: 0.15, panTau: 0.12, inertia: true, cutoff: 6 };

/** Developer options of the smoothing (registered in `DEV_OPTIONS`); the ids are read back by `smoothParams`. */
export const SMOOTH_OPTIONS: readonly DevOptionDef[] = [
  { id: 'smooth.orbitTau', label: 'Orbit damping', hint: 'Time constant of the orbit easing. Larger: heavier, longer glide', type: 'number', min: 0.02, max: 1, step: 0.01, unit: 's', default: SMOOTH_DEFAULTS.orbitTau },
  { id: 'smooth.zoomTau', label: 'Zoom damping', hint: 'Time constant of the wheel and pinch easing', type: 'number', min: 0.02, max: 1, step: 0.01, unit: 's', default: SMOOTH_DEFAULTS.zoomTau },
  { id: 'smooth.panTau', label: 'Pan damping', hint: 'Time constant of the pan easing', type: 'number', min: 0.02, max: 1, step: 0.01, unit: 's', default: SMOOTH_DEFAULTS.panTau },
  { id: 'smooth.inertia', label: 'Inertia', hint: 'Keep gliding after the drag is released. Off: the view stops where the pointer stopped. Always off with reduced motion', type: 'toggle', default: SMOOTH_DEFAULTS.inertia },
  { id: 'smooth.cutoff', label: 'Velocity cutoff', hint: 'A glide slower than this stops (pixels per second). 0: never cut off', type: 'number', min: 0, max: 100, step: 1, unit: 'px/s', default: SMOOTH_DEFAULTS.cutoff },
];

/** The smoothing parameters from the developer option values; reduced motion turns inertia off. */
export function smoothParams(values: DevValues, reducedMotion: boolean): SmoothParams {
  const n = (id: string, d: number) => (typeof values[id] === 'number' ? (values[id] as number) : d);
  return {
    orbitTau: n('smooth.orbitTau', SMOOTH_DEFAULTS.orbitTau),
    zoomTau: n('smooth.zoomTau', SMOOTH_DEFAULTS.zoomTau),
    panTau: n('smooth.panTau', SMOOTH_DEFAULTS.panTau),
    inertia: !reducedMotion && (typeof values['smooth.inertia'] === 'boolean' ? (values['smooth.inertia'] as boolean) : SMOOTH_DEFAULTS.inertia),
    cutoff: n('smooth.cutoff', SMOOTH_DEFAULTS.cutoff),
  };
}

/** Longest step the damping integrates in one go (a stalled tab must not apply everything in one jump of a huge dt). */
export const MAX_DT_S = 0.1;

/** Fraction of the pending amount applied in `dt` seconds with time constant `tau`; 1 for a zero or negative `tau`. */
export function decayFraction(dtS: number, tau: number): number {
  if (!(dtS > 0)) return 0;
  if (!(tau > 0)) return 1;
  return 1 - Math.exp(-dtS / tau);
}

/** Frame time in seconds from two timestamps in ms, limited to [0, MAX_DT_S]. */
export const frameDt = (nowMs: number, lastMs: number): number => Math.min(MAX_DT_S, Math.max(0, (nowMs - lastMs) / 1000));

/** A vector of pending motion (e.g. [dx, dy] pixels) that drains exponentially. */
export class Damper {
  readonly pending: number[];

  constructor(size: number) {
    this.pending = new Array<number>(size).fill(0);
  }

  get active(): boolean {
    return this.pending.some((v) => v !== 0);
  }

  add(...delta: number[]): void {
    for (let i = 0; i < this.pending.length; i++) this.pending[i] += delta[i] ?? 0;
  }

  /**
   * Apply `dtS` of damping and return what to apply to the camera now. When the remaining speed (`|pending| / tau`) is below
   * `cutoffSpeed` (units per second), everything left is returned, ending the glide.
   */
  step(dtS: number, tau: number, cutoffSpeed: number): number[] {
    const out = this.pending.map(() => 0);
    if (!this.active) return out;
    const speed = Math.hypot(...this.pending) / Math.max(tau, 1e-6);
    const f = speed < Math.max(cutoffSpeed, 1e-6) ? 1 : decayFraction(dtS, tau);
    for (let i = 0; i < out.length; i++) {
      out[i] = this.pending[i] * f;
      this.pending[i] -= out[i];
    }
    return out;
  }

  /** Everything still pending, which is cleared. */
  flush(): number[] {
    const out = this.pending.slice();
    this.pending.fill(0);
    return out;
  }

  clear(): void {
    this.pending.fill(0);
  }
}
