import { BodyRegistry, defaultBodies } from '../bodies';
import { bodyStateEci } from '../frames';
import type { ProviderSpec, StateProvider, StateVector } from '../types';

/** A celestial body of the registry as an entity position: state in `EARTH:inertial` from `bodyStateEci` (always valid). */
export class BodyProvider implements StateProvider {
  readonly type = 'body';

  constructor(
    private bodyId: string,
    private bodies: BodyRegistry = defaultBodies,
  ) {}

  stateAt(t: number): StateVector {
    return { ...bodyStateEci(this.bodyId, t, this.bodies), confidence: 1 };
  }

  toSpec(): ProviderSpec {
    return { type: 'body', bodyId: this.bodyId };
  }
}
