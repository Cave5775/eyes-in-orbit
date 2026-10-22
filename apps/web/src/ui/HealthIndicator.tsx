import { useState } from 'react';
import { fmtAgo } from '../lib/format';
import { useStore, type ConnState } from '../state/store';
import { useWallNow } from './hooks';

const CONN_LABEL: Record<ConnState, [string, string]> = {
  connecting: ['CONNECTING', 'warn'],
  live: ['LINK UP', 'ok'],
  reconnecting: ['RECONNECTING', 'warn'],
  offline: ['OFFLINE', 'bad'],
  mock: ['MOCK DATA', 'accent'],
};

const STATUS_TONE: Record<string, string> = { ok: 'ok', error: 'bad', idle: 'dim', disabled: 'dim', stub: 'warn' };

/** Connection state plus per-connector freshness from `/api/health`. */
export function HealthIndicator() {
  const conn = useStore((s) => s.conn);
  const health = useStore((s) => s.health);
  const [open, setOpen] = useState(false);
  const now = useWallNow(1000);
  const [label, tone] = CONN_LABEL[conn];
  const bad = health.filter((h) => h.status === 'error').length;

  return (
    <div className="health">
      <button className="btn health-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <i className={`dot ${tone}`} />
        <span>{label}</span>
        {bad > 0 && <span className="chip bad">{bad} ERR</span>}
      </button>
      {open && (
        <div className="popover health-pop">
          <div className="pop-title">DATA CONNECTORS</div>
          {health.length === 0 && <div className="dim">No health data yet.</div>}
          {health.map((h) => (
            <div key={h.id} className="health-row">
              <i className={`dot ${STATUS_TONE[h.status] ?? 'dim'}`} />
              <span className="health-id">{h.id}</span>
              <span className="mono dim">{h.status === 'ok' ? fmtAgo(h.lastOkAt, now) : h.status}</span>
              {(h.lastError || h.note || h.fromCache) && (
                <span className="health-note dim" title={h.lastError ?? h.note}>
                  {h.fromCache ? 'cached ' : ''}{h.status === 'error' ? h.lastError : h.note}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
