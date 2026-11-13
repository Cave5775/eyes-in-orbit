import { useRef } from 'react';
import { DSN_FEEDS, credentialConnector, feedInfo } from '../lib/feed-catalog';
import { CONN_LABEL, feedCounts, feedView, sortFeeds } from '../lib/feed-health';
import { fmtAgo, fmtUtc } from '../lib/format';
import { useDataStreams } from '../state/data-streams';
import { useStore } from '../state/store';
import { CredentialsSection } from './CredentialsSection';
import { useDismiss, useWallNow } from './hooks';
import { DsnSection } from './DsnSection';
import { StreamUrlInput } from './StreamUrlInput';

const hhmmZ = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + 'Z';

/**
 * The one data-connection control in the top bar. The button shows the link state (dot and label, CONN_LABEL) and the failing /
 * degraded counts; the popup replaces the old Link up, Watch and Keys menus: a status line on top, the left list is every data feed with its health (dot and badge from
 * lib/feed-health.ts), the right side says what the chosen feed provides, when it last worked, when it runs next, its
 * last error, and a feed-specific section (the DSN link table for the DSN feed). The footer is the "Watch a livestream" field.
 * Closes on an outside click and on Esc.
 */
export function DataStreams() {
  const open = useDataStreams((s) => s.open);
  const toggle = useDataStreams((s) => s.toggle);
  const close = useDataStreams((s) => s.close);
  const conn = useStore((s) => s.conn);
  const health = useStore((s) => s.health);
  const [label, tone] = CONN_LABEL[conn];
  const { red, orange } = feedCounts(health);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useDismiss(open, root, close, button);

  return (
    <div className="menu-anchor" ref={root}>
      <button
        ref={button} className={open ? 'key ds-btn on' : 'key ds-btn'} onClick={toggle}
        aria-expanded={open} aria-haspopup="dialog"
        title={`Data streams: ${label}. What each stream provides, how it is doing, keys and logins, watch a livestream`}>
        <i className={`dot ${tone}`} />
        <span className="ds-btn-label">Data streams</span>
        <span className="ds-btn-state">{label}</span>
        {red > 0 && <span className="chip bad" title={`${red} data connector${red === 1 ? '' : 's'} failing`}>{red} failing</span>}
        {orange > 0 && <span className="chip orange" title={`${orange} data connector${orange === 1 ? '' : 's'} degraded`}>{orange} degraded</span>}
      </button>
      {open && <Popup />}
    </div>
  );
}

function Popup() {
  const health = useStore((s) => s.health);
  const feedId = useDataStreams((s) => s.feedId);
  const chooseFeed = useDataStreams((s) => s.showFeed);
  const now = useWallNow(1000);
  const feeds = sortFeeds(health);
  const current = feeds.find((h) => h.id === feedId) ?? feeds[0];

  return (
    <div className="popover ds-pop" role="dialog" aria-label="Data streams">
      <StatusLine />
      <div className="ds-list" role="listbox" aria-label="Data feeds">
        {feeds.length === 0 && <div className="dim ds-empty">No health data yet.</div>}
        {feeds.map((h) => {
          const v = feedView(h);
          const on = h.id === current?.id;
          return (
            <button key={h.id} className={on ? 'ds-row on' : 'ds-row'} role="option" aria-selected={on} data-feed={h.id} data-level={v.level} title={v.title} onClick={() => chooseFeed(h.id)}>
              <i className={`dot ${v.tone}`} />
              <span className="ds-name">{feedInfo(h.id).name}</span>
              <span className={`mono health-badge ${v.tone}`}>{v.badge}</span>
            </button>
          );
        })}
      </div>
      <div className="ds-detail">
        {!current ? (
          <div className="dim">Nothing to show until the server reports its connectors.</div>
        ) : (
          <FeedDetail id={current.id} now={now} />
        )}
      </div>
      <div className="ds-foot"><StreamUrlInput /></div>
    </div>
  );
}

/** Header line: link state, how many entities are loaded and the server clock (from the last hello / health reply). */
function StatusLine() {
  const conn = useStore((s) => s.conn);
  const count = useStore((s) => s.entities.size);
  const serverTime = useStore((s) => s.serverTime);
  const [label, tone] = CONN_LABEL[conn];
  return (
    <div className="ds-status" data-conn={conn}>
      <i className={`dot ${tone}`} />
      <b>{label}</b>
      {count > 0 && <span className="mono dim">{count.toLocaleString('en-US')} objects</span>}
      {serverTime != null && <span className="mono dim">server {fmtUtc(serverTime)} UTC</span>}
    </div>
  );
}

function FeedDetail({ id, now }: { id: string; now: number }) {
  const h = useStore((s) => s.health.find((x) => x.id === id));
  if (!h) return null;
  const info = feedInfo(id);
  const v = feedView(h);
  return (
    <>
      <div className="pop-title">{info.name} <span className="mono dim ds-id">{id}</span></div>
      <p className="ds-provides">{info.provides}</p>
      <dl className="ds-kv">
        <dt>Status</dt>
        <dd><i className={`dot ${v.tone}`} /> <span className={`mono health-badge ${v.tone}`}>{v.badge}</span> {v.words}</dd>
        <dt>Last OK</dt>
        <dd className="mono">{h.lastOkAt ? `${fmtAgo(h.lastOkAt, now)} (${hhmmZ(h.lastOkAt)})` : 'never'}</dd>
        <dt>Next run</dt>
        <dd className="mono">{h.nextRunAt ? hhmmZ(h.nextRunAt) : '—'}</dd>
        {(h.lastError || v.note) && (
          <>
            <dt>{h.lastError ? 'Error' : 'Note'}</dt>
            <dd className="ds-err">{h.lastError ?? v.note}</dd>
          </>
        )}
        <dt>Source</dt>
        <dd>
          {info.link ? <a href={info.link} target="_blank" rel="noopener noreferrer">{info.source}</a> : info.source}
        </dd>
      </dl>
      {DSN_FEEDS.has(id) && <DsnSection />}
      {credentialConnector(id) && <CredentialsSection connector={credentialConnector(id)!} />}
    </>
  );
}
