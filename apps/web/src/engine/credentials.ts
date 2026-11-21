import type { CredentialInfo, CredentialKey } from '@eio/core';
import { clearBackoff } from './backoff';
import type { Limiter } from './net/limiter';
import type { KvStore } from './store';

/** What a service that needs a credential reads: the value, or `undefined` when none is set. */
export interface CredentialSource {
  get(key: string): Promise<string | undefined>;
}

interface CredentialField {
  key: CredentialKey;
  label: string;
  /** connector that reads this value */
  connector: string;
  secret: boolean;
  /**
   * backoff and limiter-block entries to drop when the value changes, so the new value can be tried. Only the failure block of
   * a limiter source is lifted (`limiter`): its spacing and caps stay, so a saved credential never causes a request the limits
   * do not allow.
   */
  reset?: { backoff?: string[]; limiter?: string[] };
}

/** Every key the UI may set. Only values some connector actually reads belong here (the stub connectors are left out). */
export const CREDENTIAL_FIELDS: readonly CredentialField[] = [
  {
    key: 'spacetrackUser', label: 'Space-Track username (e-mail)', connector: 'spacetrack', secret: false,
    reset: { backoff: ['spacetrack'], limiter: ['spacetrack:login', 'spacetrack:query'] },
  },
  {
    key: 'spacetrackPassword', label: 'Space-Track password', connector: 'spacetrack', secret: true,
    reset: { backoff: ['spacetrack'], limiter: ['spacetrack:login', 'spacetrack:query'] },
  },
  { key: 'll2Token', label: 'Launch Library 2 token', connector: 'launchlibrary', secret: true },
  { key: 'discosToken', label: 'ESA DISCOS API token', connector: 'discos', secret: true, reset: { backoff: ['describe:discos'], limiter: ['discos'] } },
];

/** The kv row of a credential. */
export const credentialKey = (key: CredentialKey): string => `credential:${key}`;
const TTL_MS = 10 * 365 * 86_400_000; // effectively forever; the startup prune only drops rows long past their TTL
const MAX_LENGTH = 256;
/** A credential save lifts a failure block at most this often: repeated saves must not fire logins at a bad account. */
export const CLEAR_BLOCK_EVERY_MS = 3600_000;

export class CredentialError extends Error {}

export interface UpdateResult {
  changed: CredentialKey[];
  connectors: string[];
  /** best-effort follow-ups that failed (a block that could not be lifted); the values themselves were all written */
  errors: string[];
}

export interface CredentialsDeps {
  store: KvStore;
  /** lifts the failure blocks of the sources a changed credential feeds */
  limiter: Limiter;
  /** called after a save that changed something (wiring calls `describe.syncHealth()` and refreshes the connectors here) */
  onChange?: (result: UpdateResult) => void;
}

/**
 * Credentials typed into the app, kept in the browser's kv store as plain text (`credential:<key>`): readable by anything
 * running in this origin and sent to the provider that needs them, so the UI says so and offers a Clear button. Secret values
 * are never part of `status()`; services read them through `get` (the `CredentialSource` shape).
 */
export class Credentials implements CredentialSource {
  constructor(private deps: CredentialsDeps) {}

  async get(key: string): Promise<string | undefined> {
    if (!CREDENTIAL_FIELDS.some((f) => f.key === key)) return undefined;
    const v = (await this.deps.store.get<string>(credentialKey(key as CredentialKey)))?.value;
    return typeof v === 'string' && v ? v : undefined;
  }

  /** Which credentials are set (the value only for non-secret fields, like the Space-Track user name). */
  async status(): Promise<CredentialInfo[]> {
    return Promise.all(CREDENTIAL_FIELDS.map(async (f) => {
      const value = await this.get(f.key);
      const info: CredentialInfo = { key: f.key, label: f.label, connector: f.connector, secret: f.secret, set: !!value, source: value ? 'ui' : null };
      if (value && !f.secret) info.value = value;
      return info;
    }));
  }

  set(key: CredentialKey, value: string): Promise<UpdateResult> {
    return this.update({ [key]: value });
  }

  clear(key: CredentialKey): Promise<UpdateResult> {
    return this.update({ [key]: null });
  }

  /**
   * Apply `patch`: a string sets the value, `null` or an empty string removes it. Validates everything first so a bad entry
   * changes nothing. Returns what actually changed.
   */
  async update(patch: unknown): Promise<UpdateResult> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new CredentialError('expected an object of key: value');
    const next: [CredentialField, string | null][] = [];
    for (const [key, raw] of Object.entries(patch as Record<string, unknown>)) {
      const field = CREDENTIAL_FIELDS.find((f) => f.key === key);
      if (!field) throw new CredentialError(`unknown credential "${key}"`);
      if (raw !== null && typeof raw !== 'string') throw new CredentialError(`${key} must be a string or null`);
      const value = raw?.trim() || null;
      if (value && value.length > MAX_LENGTH) throw new CredentialError(`${key} is longer than ${MAX_LENGTH} characters`);
      if (value && /[\u0000-\u001f\u007f]/.test(value)) throw new CredentialError(`${key} contains control characters`);
      next.push([field, value]);
    }
    const { store, limiter } = this.deps;
    const changed: CredentialKey[] = [];
    const connectors = new Set<string>();
    const errors: string[] = [];
    // 1. write every value first: a failing follow-up below must never leave a later key unwritten
    for (const [field, value] of next) {
      const before = await this.get(field.key);
      if (value) await store.put(credentialKey(field.key), value, TTL_MS);
      else await store.delete(credentialKey(field.key));
      if ((value ?? undefined) === before) continue;
      changed.push(field.key);
      connectors.add(field.connector);
    }
    // 2. then lift the gates and failure blocks of what changed, best effort
    for (const field of next.map(([f]) => f).filter((f) => changed.includes(f.key))) {
      for (const s of field.reset?.backoff ?? []) {
        try { await clearBackoff(store, s); } catch (e) { errors.push(`backoff ${s}: ${(e as Error).message}`); }
      }
      for (const s of field.reset?.limiter ?? []) {
        try { await limiter.clearBlock(s, CLEAR_BLOCK_EVERY_MS); } catch (e) { errors.push(`limiter ${s}: ${(e as Error).message}`); }
      }
    }
    const result: UpdateResult = { changed, connectors: [...connectors], errors };
    if (changed.length) this.deps.onChange?.(result);
    return result;
  }
}
