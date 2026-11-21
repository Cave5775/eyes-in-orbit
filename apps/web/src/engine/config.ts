/**
 * Settings the engine reads. Later steps add the connector settings (tokens, URLs) here; every field has a default so a
 * caller (the data worker, a test) passes only what differs.
 */
export interface EngineConfig {
  /** skip all network access; connectors serve what the cache holds */
  offline: boolean;
  /** connector ids that are not started at all; unlike `offline` they leave the others' network access alone */
  disabledConnectors: string[];
  /** base of the stateless CORS relay the no-CORS upstreams go through (Horizons, Space-Track, DISCOS, MAST); same origin by default */
  relayBase: string;
  /** route CelesTrak through the relay too (its CORS headers are unverified); default off = direct */
  celestrakViaRelay: boolean;
  /** let the minor-planets connector download MPCORB (about 70 MB) on its own; default off, `downloadMinorPlanets()` is the trigger */
  minorPlanetsAuto: boolean;
}

export const engineConfig = (over: Partial<EngineConfig> = {}): EngineConfig => ({
  offline: false, disabledConnectors: [], relayBase: '/relay', celestrakViaRelay: false, minorPlanetsAuto: false, ...over,
});
