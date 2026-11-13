import { useRef } from 'react';
import { DSN_FEEDS, feedInfo } from '../lib/feed-catalog';
import { feedView, sortFeeds } from '../lib/feed-health';
import { fmtAgo } from '../lib/format';
import { useDataStreams } from '../state/data-streams';
import { useStore } from '../state/store';
import { useDismiss, useWallNow } from './hooks';
import { DsnSection } from './DsnSection';
import { StreamUrlInput } from './StreamUrlInput';

const hhmmZ = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + 'Z';

/**
 * Top bar "Data streams" button and its popup: the left list is every data feed with its health (dot and badge from
 * lib/feed-health.ts), the right side says what the chosen feed provides, when it last worked, when it runs next, its
 * last error, and a feed-specific section (the DSN link table for the DSN feed). The footer is the "Watch a livestream" field.
 * Closes on an outside click and on Esc.
 */
export function DataStreams() {
  const open = useDataStreams((s) => s.open);
  const toggle = useDataStreams((s) => s.toggle);
  const close = useDataStreams((s) => s.close);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useDismiss(open, root, close);

  return (
    <div className="menu-anchor" ref={root}>
      <button
        ref={button} className={open ? 'key on' : 'key'} onClick={toggle}
        aria-expanded={open} aria-haspopup="dialog" title="What each data stream provides, and how it is doing">
        Data streams
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
    </>
  );
}
