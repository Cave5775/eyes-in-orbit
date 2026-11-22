import type { CredentialInfo, CredentialKey } from '@eio/core';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { fmtAgo } from '../lib/format';
import { useWallNow } from './hooks';
import { clearDescribeCache } from './detail/AboutTab';

/**
 * Login and key fields of one connector, inside that feed's pane of the Data streams popup. Values go to the data engine in
 * this page's worker, which keeps them unencrypted in this browser profile (IndexedDB) and uses them from its next run on.
 * Secrets are write-only: the field shows whether one is saved, never its value.
 */
export function CredentialsSection({ connector }: { connector: string }) {
  const [creds, setCreds] = useState<CredentialInfo[] | null>(null);
  const [draft, setDraft] = useState<Partial<Record<CredentialKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const now = useWallNow(1000);

  useEffect(() => {
    setError(null);
    setDraft({});
    setSavedAt(null);
    let live = true;
    api.credentials().then((c) => live && setCreds(c)).catch((e: Error) => live && setError(`Could not load: ${e.message}`));
    return () => { live = false; };
  }, [connector]);

  const save = async (values: Partial<Record<CredentialKey, string | null>>) => {
    setBusy(true);
    setError(null);
    try {
      setCreds(await api.saveCredentials(values));
      clearDescribeCache(); // an About answer cached before a DISCOS token was saved says "off"
      setDraft((d) => {
        const next = { ...d };
        for (const k of Object.keys(values) as CredentialKey[]) delete next[k];
        return next;
      });
      setSavedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    setBusy(true);
    setError(null);
    try {
      setCreds(await api.clearCredentials());
      clearDescribeCache();
      setDraft({});
      setSavedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mine = (creds ?? []).filter((c) => c.connector === connector);
  const edited = Object.entries(draft).filter(([k, v]) => v !== undefined && mine.some((c) => c.key === k)) as [CredentialKey, string][];

  return (
    <div className="keys-group">
      <div className="ds-sub">API keys and logins</div>
      <p className="dim keys-note" data-testid="keys-warning">
        Optional. Saved unencrypted in this browser profile, so extensions and scripts running on this site can read them. They are
        sent to the provider that needs them, or through this site&rsquo;s relay when the provider cannot be called from a browser.
        Secrets are write-only: never shown again.
      </p>
      {!creds && !error && <div className="dim">Loading&hellip;</div>}
      {mine.map((c) => {
        const value = draft[c.key] ?? (c.secret ? '' : c.value ?? '');
        return (
          <label key={c.key} className="keys-field">
            <span>{c.label}</span>
            <input
              type={c.secret ? 'password' : 'text'}
              autoComplete="off" spellCheck={false} value={value}
              placeholder={c.set && c.secret ? 'saved in this browser' : 'not set'}
              onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && edited.length && void save(Object.fromEntries(edited))}
            />
            {c.source === 'ui' && (
              <button className="chip clear" disabled={busy} onClick={() => void save({ [c.key]: null })}
                title="Remove the value saved here">
                clear
              </button>
            )}
          </label>
        );
      })}
      {error && <div className="keys-error">{error}</div>}
      <div className="keys-actions">
        <button className="btn active" disabled={busy || edited.length === 0} onClick={() => void save(Object.fromEntries(edited))}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {(creds ?? []).some((c) => c.set) && (
          <button className="btn" disabled={busy} onClick={() => void clearAll()} title="Remove every saved key and login of all feeds from this browser">
            Clear all
          </button>
        )}
        {savedAt && <span className="dim keys-saved">saved {fmtAgo(savedAt, now)}; the connector retries now</span>}
      </div>
    </div>
  );
}
