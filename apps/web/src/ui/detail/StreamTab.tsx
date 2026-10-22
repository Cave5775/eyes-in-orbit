import { memo, useState } from 'react';
import type { StreamLink } from '@eio/core';
import { resolveStream } from '../../lib/youtube';

/**
 * The only element that holds the live video. Memoised on the URL alone so scene, clock and
 * store updates never re-render (and therefore never reload) the iframe.
 */
export const StreamFrame = memo(function StreamFrame({ url }: { url: string }) {
  return (
    <iframe
      className="stream-frame"
      src={url}
      title="Live stream"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
});

export function StreamTab({ streams }: { streams: StreamLink[] }) {
  const [index, setIndex] = useState(0);
  const link = streams[Math.min(index, streams.length - 1)];
  if (!link) return <div className="empty">No streams for this entity.</div>;
  const { embedUrl, href } = resolveStream(link);

  return (
    <div className="stream-tab">
      {streams.length > 1 && (
        <div className="chips">
          {streams.map((s, i) => (
            <button key={s.url} className={i === index ? 'chip on' : 'chip'} onClick={() => setIndex(i)}>
              {s.live && <i className="dot ok" />}{s.title}
            </button>
          ))}
        </div>
      )}
      {embedUrl ? (
        <StreamFrame url={embedUrl} />
      ) : (
        <div className="stream-fallback">
          <div className="dim">{link.title} cannot be embedded (the provider blocks framing).</div>
          <a className="btn active" href={href} target="_blank" rel="noopener noreferrer">OPEN {link.kind === 'nasa-tv' ? 'NASA TV' : 'STREAM'}</a>
        </div>
      )}
      <div className="stream-meta">
        <span className="mono dim">{link.kind.toUpperCase()}{link.live ? ' / LIVE' : ''}</span>
        <a href={href} target="_blank" rel="noopener noreferrer">Open in new tab</a>
      </div>
    </div>
  );
}
