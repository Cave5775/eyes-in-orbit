import type { CredentialInfo, CredentialKey } from '@eio/core';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { feedView } from '../lib/feed-health';
import { fmtAgo } from '../lib/format';
import { useStore } from '../state/store';
import { useWallNow } from './hooks';


/**
 * API keys and logins for connectors that need them (Space-Track, Launch Library 2). Values go to the local server only,
 * which keeps them in its SQLite cache and uses them from its next run on. Secrets are write-only: the field shows
 * whether one is saved, never its value.
 */
export function CredentialsPanel() {
  const [open, setOpen] = useState(false);
  const [creds, setCreds] = useState<CredentialInfo[] | null>(null);
  const [draft, setDraft] = useState<Partial<Record<CredentialKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const health = useStore((s) => s.health);
  const now = useWallNow(1000);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api.credentials().then(setCreds).catch((e: Error) => setError(`Could not load: ${e.message}`));
  }, [open]);

  const save = async (values: Partial<Record<CredentialKey, string | null>>) => {
    setBusy(true);
    setError(null);
    try {
      setCreds(await api.saveCredentials(values));
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

  const edited = Object.entries(draft).filter(([, v]) => v !== undefined) as [CredentialKey, string][];
  const connectors = [...new Set((creds ?? []).map((c) => c.connector))];

  return (
    <div className="health">
      <button className="btn health-btn keys-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="API keys and logins">
        Keys
      </button>
      {open && (
        <div className="popover keys-pop">
          <div className="pop-title">API keys and logins</div>
          <p className="dim keys-note">
            Optional. Saved on this machine only (the local server&rsquo;s cache) and used for its own requests; secrets are never
            shown again. They override the same values from <code>.env</code>.
          </p>
          {!creds && !error && <div className="dim">Loading&hellip;</div>}
          {connectors.map((id) => {
            const h = health.find((x) => x.id === id);
            return (
              <div key={id} className="keys-group">
                <div className="keys-head">
                  <span className="health-id">{id}</span>
                  {h && (
                    <span className="keys-status dim" title={h.lastError ?? h.note}>
                      <i className={`dot ${feedView(h).tone}`} />
                      {h.status === 'ok' ? `ok ${fmtAgo(h.lastOkAt, now)}` : h.status}
                      {h.status === 'error' && h.lastError ? `: ${h.lastError}` : h.note ? `: ${h.note}` : ''}
                    </span>
                  )}
                </div>
                {creds!.filter((c) => c.connector === id).map((c) => {
                  const value = draft[c.key] ?? (c.secret ? '' : c.value ?? '');
                  return (
                    <label key={c.key} className="keys-field">
                      <span>{c.label}</span>
                      <input
                        type={c.secret ? 'password' : 'text'}
                        autoComplete="off" spellCheck={false} value={value}
                        placeholder={c.set && c.secret ? `saved (${c.source === 'ui' ? 'this app' : '.env'})` : 'not set'}
                        onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && edited.length && void save(Object.fromEntries(edited))}
                      />
                      {c.source === 'ui' && (
                        <button className="chip clear" disabled={busy} onClick={() => void save({ [c.key]: null })}
                          title={'Remove the value saved here' + (c.secret ? '' : ' (falls back to .env)')}>
                          clear
                        </button>
                      )}
                    </label>
                  );
                })}
              </div>
            );
          })}
          {error && <div className="keys-error">{error}</div>}
          <div className="keys-actions">
            <button className="btn active" disabled={busy || edited.length === 0} onClick={() => void save(Object.fromEntries(edited))}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            {savedAt && <span className="dim keys-saved">saved {fmtAgo(savedAt, now)}; the connector retries now</span>}
          </div>
        </div>
      )}
    </div>
  );
}
