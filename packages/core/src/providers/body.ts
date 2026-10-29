import { BodyRegistry, defaultBodies } from '../bodies';
import { bodyStateEci, setBodyStream } from '../frames';
import type { ProviderSpec, StateProvider, StateVector } from '../types';

/**
 * A celestial body of the registry as an entity position: state in `EARTH:inertial` from `bodyStateEci` (always valid).
 * With an `ephemeris` (a Horizons sample stream relative to the parent) the constructor installs it in the registry
 * (`setBodyStream`), so the body, its moons and the frame hops through it use the data inside the sampled window and the
 * approximate Kepler orbit outside. An invalid stream (wrong frame, too few samples, unknown body) is ignored.
 */
export class BodyProvider implements StateProvider {
  readonly type = 'body';

  constructor(
    private bodyId: string,
    private bodies: BodyRegistry = defaultBodies,
    private ephemeris?: Extract<ProviderSpec, { type: 'body' }>['ephemeris'],
  ) {
    if (ephemeris && bodies.has(bodyId)) setBodyStream(bodyId, ephemeris, bodies);
  }

  stateAt(t: number): StateVector {
    return { ...bodyStateEci(this.bodyId, t, this.bodies), confidence: 1 };
  }

  toSpec(): ProviderSpec {
    return this.ephemeris ? { type: 'body', bodyId: this.bodyId, ephemeris: this.ephemeris } : { type: 'body', bodyId: this.bodyId };
  }
}
