import { BodyRegistry, defaultBodies } from '../bodies';
import { keplerState } from '../kepler';
import type { KeplerElements, ProviderSpec, StateProvider, StateVector } from '../types';

/** Generic two-body orbit around any registered body (Moon/Mars orbiters, transfer arcs). */
export class KeplerianProvider implements StateProvider {
  readonly type = 'keplerian';

  constructor(
    private bodyId: string,
    private elements: KeplerElements,
    private bodies: BodyRegistry = defaultBodies,
  ) {}

  stateAt(t: number): StateVector | null {
    const { r, v } = keplerState(this.elements, this.bodies.get(this.bodyId).gm, t);
    return { frame: `${this.bodyId}:inertial`, r, v };
  }

  toSpec(): ProviderSpec {
    return { type: 'keplerian', bodyId: this.bodyId, elements: this.elements };
  }
}
