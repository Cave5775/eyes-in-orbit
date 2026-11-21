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

const DEFAULT_LL2_BASE = 'https://ll.thespacedevs.com/2.3.0';
const DEFAULT_DSN_URLS = ['https://eyes.nasa.gov/dsn/data/dsn.xml', 'https://eyes.nasa.gov/dsn/dsn.xml'];

/** Defaults filled in; `ll2Base` loses trailing slashes and an empty `ll2Base` or `dsnUrls` falls back to the default (as the server's config did). */
export const engineConfig = (over: Partial<EngineConfig> = {}): EngineConfig => {
  const cfg: EngineConfig = { offline: false, disabledConnectors: [], ll2Base: DEFAULT_LL2_BASE, dsnUrls: [...DEFAULT_DSN_URLS], ...over };
  cfg.ll2Base = cfg.ll2Base.trim().replace(/\/+$/, '') || DEFAULT_LL2_BASE;
  if (!cfg.dsnUrls?.length) cfg.dsnUrls = [...DEFAULT_DSN_URLS];
  return cfg;
};
