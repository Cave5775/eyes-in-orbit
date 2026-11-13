import { useState } from 'react';
import { feedCounts, feedView, sortFeeds } from '../lib/feed-health';
import { fmtAgo } from '../lib/format';
import { useDataStreams } from '../state/data-streams';
import { useStore, type ConnState } from '../state/store';
import { useWallNow } from './hooks';

const CONN_LABEL: Record<ConnState, [string, string]> = {
  connecting: ['Connecting', 'warn'],
  live: ['Link up', 'ok'],
  reconnecting: ['Reconnecting', 'warn'],
  offline: ['Offline', 'bad'],
  mock: ['Mock data', 'accent'],
};

/** Connection state plus per-connector freshness from `/api/health` (a row opens the Data streams popup on that feed); the dot colour of each connector comes from `lib/feed-health.ts`. */
export function HealthIndicator() {
  const conn = useStore((s) => s.conn);
  const health = useStore((s) => s.health);
  const [open, setOpen] = useState(false);
  const openFeed = useDataStreams((s) => s.openOn);
  const now = useWallNow(1000);
  const [label, tone] = CONN_LABEL[conn];
  const { red, orange } = feedCounts(health);

  return (
    <div className="health">
      <button className="btn health-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <i className={`dot ${tone}`} />
        <span>{label}</span>
        {red > 0 && <span className="chip bad" title={`${red} data connector${red === 1 ? '' : 's'} failing`}>{red} failing</span>}
        {orange > 0 && <span className="chip orange" title={`${orange} data connector${orange === 1 ? '' : 's'} degraded`}>{orange} degraded</span>}
      </button>
      {open && (
        <div className="popover health-pop">
          <div className="pop-title">Data connectors</div>
          {health.length === 0 && <div className="dim">No health data yet.</div>}
          {sortFeeds(health).map((h) => {
            const v = feedView(h);
            return (
              <button key={h.id} className="health-row" title={`${v.title}\nClick for details`} data-level={v.level} onClick={() => { setOpen(false); openFeed(h.id); }}>
                <i className={`dot ${v.tone}`} />
                <span className="health-id">{h.id}</span>
                <span className={`mono health-badge ${v.tone}`}>{v.level === 'ok' ? `${v.badge} ${fmtAgo(h.lastOkAt, now)}` : v.badge}</span>
                <span className="health-note dim">
                  {v.level === 'ok' ? (v.note ?? '') : `${v.words}${v.retry ? ` (${v.retry})` : ''}${v.note ? `: ${v.note}` : ''}`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
