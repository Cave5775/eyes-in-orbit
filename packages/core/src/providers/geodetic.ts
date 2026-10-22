import { BodyRegistry, defaultBodies } from '../bodies';
import { geodeticToFixed } from '../frames';
import { DEG } from '../math';
import type { ProviderSpec, StateProvider, StateVector } from '../types';

/** Fixed point on a body's surface (pads, ground stations, landed rovers/landers). */
export class GeodeticProvider implements StateProvider {
  readonly type = 'geodetic';

  constructor(
    private bodyId: string,
    private latDeg: number,
    private lonDeg: number,
    private altKm = 0,
    private bodies: BodyRegistry = defaultBodies,
  ) {}

  stateAt(): StateVector {
    const r = geodeticToFixed(
      { lat: this.latDeg * DEG, lon: this.lonDeg * DEG, alt: this.altKm },
      this.bodies.get(this.bodyId),
    );
    return { frame: `${this.bodyId}:fixed`, r, v: [0, 0, 0] };
  }

  toSpec(): ProviderSpec {
    return { type: 'geodetic', bodyId: this.bodyId, latDeg: this.latDeg, lonDeg: this.lonDeg, altKm: this.altKm };
  }
}
