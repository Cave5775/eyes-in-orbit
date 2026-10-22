import type { FrameId, ProviderSpec, Sample, StateProvider, StateVector } from '../types';

/**
 * Time-tagged samples interpolated with cubic Hermite when velocities are present
 * (km, km/s), linear otherwise. Used for ascent trajectories, live fixes, landing burns.
 */
export class SampledProvider implements StateProvider {
  readonly type = 'sampled';
  readonly validRange?: [number, number];
  private samples: Sample[];

  constructor(
    private frame: FrameId,
    samples: Sample[],
    private holdEnds = false,
    private confidence = 1,
  ) {
    this.samples = [...samples].sort((a, b) => a[0] - b[0]);
    if (this.samples.length) {
      this.validRange = [this.samples[0][0], this.samples[this.samples.length - 1][0]];
    }
  }

  get length(): number {
    return this.samples.length;
  }

  /** Append a new sample (live feeds); keeps ordering and replaces equal timestamps. */
  push(sample: Sample, maxKeep = 3600): void {
    const last = this.samples[this.samples.length - 1];
    if (last && sample[0] <= last[0]) {
      if (sample[0] === last[0]) this.samples[this.samples.length - 1] = sample;
      else {
        this.samples.push(sample);
        this.samples.sort((a, b) => a[0] - b[0]);
      }
    } else this.samples.push(sample);
    if (this.samples.length > maxKeep) this.samples.splice(0, this.samples.length - maxKeep);
    (this as { validRange?: [number, number] }).validRange = [this.samples[0][0], this.samples[this.samples.length - 1][0]];
  }

  stateAt(t: number): StateVector | null {
    const s = this.samples;
    if (!s.length) return null;
    if (t <= s[0][0]) return t === s[0][0] || this.holdEnds ? this.make(s[0], s[0], 0, 1) : null;
    const last = s[s.length - 1];
    if (t >= last[0]) return t === last[0] || this.holdEnds ? this.make(last, last, 0, 1) : null;

    // binary search for bracketing pair
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid][0] <= t) lo = mid;
      else hi = mid;
    }
    const a = s[lo], b = s[hi];
    return this.make(a, b, (t - a[0]) / (b[0] - a[0]), (b[0] - a[0]) / 1000);
  }

  private make(a: Sample, b: Sample, u: number, dtSec: number): StateVector {
    const hasV = a.length >= 7 && b.length >= 7;
    const r: [number, number, number] = [0, 0, 0];
    let v: [number, number, number] | undefined;
    if (hasV && dtSec > 0) {
      v = [0, 0, 0];
      const u2 = u * u, u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
      const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
      for (let k = 0; k < 3; k++) {
        r[k] = h00 * a[1 + k] + h10 * dtSec * a[4 + k] + h01 * b[1 + k] + h11 * dtSec * b[4 + k];
        v[k] = (d00 * a[1 + k] + d10 * dtSec * a[4 + k] + d01 * b[1 + k] + d11 * dtSec * b[4 + k]) / dtSec;
      }
    } else {
      for (let k = 0; k < 3; k++) r[k] = a[1 + k] + (b[1 + k] - a[1 + k]) * u;
      if (dtSec > 0) {
        v = [0, 0, 0];
        for (let k = 0; k < 3; k++) v[k] = (b[1 + k] - a[1 + k]) / dtSec;
      }
    }
    return { frame: this.frame, r, v, confidence: this.confidence };
  }

  toSpec(): ProviderSpec {
    return { type: 'sampled', frame: this.frame, samples: this.samples, holdEnds: this.holdEnds, confidence: this.confidence };
  }
}
