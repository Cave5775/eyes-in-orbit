/**
 * Settings the engine reads. Later steps add the connector settings (tokens, URLs) here; every field has a default so a
 * caller (the data worker, a test) passes only what differs.
 */
export interface EngineConfig {
  /** skip all network access; connectors serve what the cache holds */
  offline: boolean;
  /** connector ids that are not started at all; unlike `offline` they leave the others' network access alone */
  disabledConnectors: string[];
}

export const engineConfig = (over: Partial<EngineConfig> = {}): EngineConfig => ({ offline: false, disabledConnectors: [], ...over });
