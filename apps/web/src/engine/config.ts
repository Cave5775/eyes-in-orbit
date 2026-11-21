/**
 * Settings the engine reads. Later steps add the connector settings (tokens, URLs) here; every field has a default so a
 * caller (the data worker, a test) passes only what differs.
 */
export interface EngineConfig {
  /** skip all network access; connectors serve what the cache holds */
  offline: boolean;
  /** connector ids that are not started at all; unlike `offline` they leave the others' network access alone */
  disabledConnectors: string[];
  /** Launch Library 2 base URL (no trailing slash) */
  ll2Base: string;
  /** DSN Now XML candidates, tried in order until one parses */
  dsnUrls: string[];
  /** shown in the notes of the placeholder connectors */
  satnogsToken?: string;
  webcastUrl?: string;
}

export const engineConfig = (over: Partial<EngineConfig> = {}): EngineConfig => ({
  offline: false,
  disabledConnectors: [],
  ll2Base: 'https://ll.thespacedevs.com/2.3.0',
  dsnUrls: ['https://eyes.nasa.gov/dsn/data/dsn.xml', 'https://eyes.nasa.gov/dsn/dsn.xml'],
  ...over,
});
