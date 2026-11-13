import type { CredentialInfo, CredentialKey } from '@eio/core';
import { clearBackoff } from './backoff';
import { limiterFor } from './net/limiter';
import type { Config } from './config';
import type { Store } from './store';

interface CredentialField {
  key: CredentialKey;
  label: string;
  /** connector that reads this value */
  connector: string;
  secret: boolean;
  /** environment variable used when nothing was entered in the UI */
  env: string;
  /**
   * cache, backoff and limiter-block entries to drop when the value changes, so the new value can be tried. Only the failure
   * block of a limiter source is lifted (`limiter`): its spacing and caps stay, so a saved credential never causes a request
   * the limits do not allow.
   */
  reset?: { cache?: string[]; backoff?: string[]; limiter?: string[] };
}

/** Every key the UI may set. Only values some connector actually reads belong here (the stub connectors are left out). */
export const CREDENTIAL_FIELDS: readonly CredentialField[] = [
  {
    key: 'spacetrackUser', label: 'Space-Track username (e-mail)', connector: 'spacetrack', secret: false, env: 'SPACETRACK_USER',
    reset: { backoff: ['spacetrack'], limiter: ['spacetrack:login', 'spacetrack:query'] },
  },
  {
    key: 'spacetrackPassword', label: 'Space-Track password', connector: 'spacetrack', secret: true, env: 'SPACETRACK_PASSWORD',
    reset: { backoff: ['spacetrack'], limiter: ['spacetrack:login', 'spacetrack:query'] },
  },
  { key: 'll2Token', label: 'Launch Library 2 token', connector: 'launchlibrary', secret: true, env: 'LL2_TOKEN' },
  { key: 'discosToken', label: 'ESA DISCOS API token', connector: 'discos', secret: true, env: 'DISCOS_TOKEN', reset: { backoff: ['describe:discos'], limiter: ['discos'] } },
];

const storeKey = (key: CredentialKey): string => `credential:${key}`;
const TTL_MS = 10 * 365 * 86_400_000; // effectively forever; Store.prune only drops rows long past their TTL
const MAX_LENGTH = 256;
/** A credential save lifts a failure block at most this often: repeated saves must not fire logins at a bad account. */
export const CLEAR_BLOCK_EVERY_MS = 3600_000;

export class CredentialError extends Error {}

/**
 * Credentials typed into the web UI. They are kept in the local SQLite cache (plain text, like `.env`; never leaves this
 * machine) and override the environment variables. The shared `Config` object is updated in place, so connectors pick the
 * new value up on their next run without a restart. Secret values are never returned by `describe()`.
 */
export class Credentials {
  private fromUi = new Set<CredentialKey>();
  private env: Partial<Record<CredentialKey, string>> = {};

  constructor(private config: Config, private store: Store) {
    for (const f of CREDENTIAL_FIELDS) {
      this.env[f.key] = config[f.key];
      const stored = store.get<string>(storeKey(f.key))?.value;
      if (stored) {
        config[f.key] = stored;
        this.fromUi.add(f.key);
      }
    }
  }

  describe(): CredentialInfo[] {
    return CREDENTIAL_FIELDS.map((f) => {
      const value = this.config[f.key];
      const info: CredentialInfo = {
        key: f.key, label: f.label, connector: f.connector, secret: f.secret,
        set: !!value, source: value ? (this.fromUi.has(f.key) ? 'ui' : 'env') : null,
      };
      if (value && !f.secret) info.value = value;
      return info;
    });
  }

  /**
   * Apply `patch`: a string sets the value, `null` or an empty string removes the UI value (falling back to the
   * environment variable). Validates everything first so a bad entry changes nothing. Returns what actually changed.
   */
  update(patch: unknown): { changed: CredentialKey[]; connectors: string[] } {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new CredentialError('expected an object of key: value');
    const entries = Object.entries(patch as Record<string, unknown>);
    const next: [CredentialField, string | null][] = [];
    for (const [key, raw] of entries) {
      const field = CREDENTIAL_FIELDS.find((f) => f.key === key);
      if (!field) throw new CredentialError(`unknown credential "${key}"`);
      if (raw !== null && typeof raw !== 'string') throw new CredentialError(`${key} must be a string or null`);
      const value = raw?.trim() || null;
      if (value && value.length > MAX_LENGTH) throw new CredentialError(`${key} is longer than ${MAX_LENGTH} characters`);
      if (value && /[\u0000-\u001f\u007f]/.test(value)) throw new CredentialError(`${key} contains control characters`);
      next.push([field, value]);
    }
    const changed: CredentialKey[] = [];
    const connectors = new Set<string>();
    for (const [field, value] of next) {
      const before = this.config[field.key];
      if (value) {
        this.store.set(storeKey(field.key), value, TTL_MS);
        this.config[field.key] = value;
        this.fromUi.add(field.key);
      } else {
        this.store.delete(storeKey(field.key));
        this.config[field.key] = this.env[field.key];
        this.fromUi.delete(field.key);
      }
      if (this.config[field.key] === before) continue;
      changed.push(field.key);
      connectors.add(field.connector);
      for (const k of field.reset?.cache ?? []) this.store.delete(k);
      for (const s of field.reset?.backoff ?? []) clearBackoff(this.store, s);
      for (const s of field.reset?.limiter ?? []) limiterFor(this.store).clearBlock(s, CLEAR_BLOCK_EVERY_MS);
    }
    return { changed, connectors: [...connectors] };
  }
}
