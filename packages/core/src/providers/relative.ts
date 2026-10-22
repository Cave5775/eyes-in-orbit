import { BodyRegistry, defaultBodies } from '../bodies';
import { convert, enuBasis, fixedToGeodetic, parseFrame } from '../frames';
import { Vec3, add, scale } from '../math';
import type { ProviderContext, ProviderSpec, Sample, StateProvider, StateVector } from '../types';

/**
 * State defined relative to another entity: a drone near a rover, a stage separating from its
 * vehicle, a landing booster flying down to a pad. Resolves the parent through the context.
 */
export class RelativeProvider implements StateProvider {
  readonly type = 'relative';

  constructor(
    private parentId: string,
    private mode: 'enu' | 'offset',
    private offsetKm: Vec3 = [0, 0, 0],
    private samples?: Sample[],
    private bodies: BodyRegistry = defaultBodies,
  ) {}

  stateAt(t: number, ctx?: ProviderContext): StateVector | null {
    const parent = ctx?.stateOf?.(this.parentId, t);
    if (!parent) return null;
    const off = this.offsetAt(t);
    if (!off) return null;

    if (this.mode === 'offset') {
      return { ...parent, r: add(parent.r, off), q: undefined };
    }

    // ENU: work in the parent's body-fixed frame so "up" means away from the surface
    const { bodyId } = parseFrame(parent.frame);
    const fixed = convert(parent, `${bodyId}:fixed`, t, this.bodies);
    const g = fixedToGeodetic(fixed.r, this.bodies.get(bodyId));
    const { e, n, u } = enuBasis(g.lat, g.lon);
    const delta = add(add(scale(e, off[0]), scale(n, off[1])), scale(u, off[2]));
    return { frame: fixed.frame, r: add(fixed.r, delta), v: fixed.v, confidence: parent.confidence };
  }

  private offsetAt(t: number): Vec3 | null {
    const s = this.samples;
    if (!s?.length) return this.offsetKm;
    if (t <= s[0][0]) return [s[0][1], s[0][2], s[0][3]];
    const last = s[s.length - 1];
    if (t >= last[0]) return [last[1], last[2], last[3]];
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid][0] <= t) lo = mid;
      else hi = mid;
    }
    const a = s[lo], b = s[hi];
    const u = (t - a[0]) / (b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
  }

  toSpec(): ProviderSpec {
    return { type: 'relative', parentId: this.parentId, mode: this.mode, offsetKm: this.offsetKm, samples: this.samples };
  }
}
