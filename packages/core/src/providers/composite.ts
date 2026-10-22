import type { CompositeSegment, ProviderContext, ProviderSpec, StateProvider, StateVector } from '../types';
import { providerFromSpec } from './index';

/**
 * Time-sliced chain of providers: one entity across mission phases
 * (pad -> ascent samples -> SGP4 on orbit -> landing burn -> landed).
 */
export class CompositeProvider implements StateProvider {
  readonly type = 'composite';
  readonly validRange: [number, number];
  private built: { seg: CompositeSegment; provider: StateProvider }[];

  constructor(private segments: CompositeSegment[]) {
    const sorted = [...segments].sort((a, b) => a.fromMs - b.fromMs);
    this.built = sorted.map((seg) => ({ seg, provider: providerFromSpec(seg.spec) }));
    this.validRange = [sorted[0]?.fromMs ?? 0, sorted[sorted.length - 1]?.toMs ?? 0];
  }

  /** The segment (and phase label) active at time t. */
  segmentAt(t: number): CompositeSegment | null {
    // later segments win on overlap so hand-offs are exclusive on the end boundary
    for (let i = this.built.length - 1; i >= 0; i--) {
      const { seg } = this.built[i];
      if (t >= seg.fromMs && t <= seg.toMs) return seg;
    }
    return null;
  }

  stateAt(t: number, ctx?: ProviderContext): StateVector | null {
    for (let i = this.built.length - 1; i >= 0; i--) {
      const { seg, provider } = this.built[i];
      if (t >= seg.fromMs && t <= seg.toMs) return provider.stateAt(t, ctx);
    }
    return null;
  }

  toSpec(): ProviderSpec {
    return { type: 'composite', segments: this.segments };
  }
}
