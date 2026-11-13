import { useState } from 'react';
import type { StreamLink } from '@eio/core';
import { MAX_FLOATS } from '../../lib/floating';
import { embedFor } from '../../lib/stream-url';
import { pageOrigin } from '../../lib/youtube';
import { useStore } from '../../state/store';
import { StreamFrame } from '../StreamFrame';

export function StreamTab({ streams }: { streams: StreamLink[] }) {
  const [index, setIndex] = useState(0);
  const floats = useStore((s) => s.floats);
  const openFloat = useStore((s) => s.openFloat);
  const closeFloat = useStore((s) => s.closeFloat);
  const link = streams[Math.min(index, streams.length - 1)];
  if (!link) return <div className="empty">No streams for this entity.</div>;
  // the same resolver as the "Watch a livestream" field: YouTube, Twitch, Vimeo and direct video links embed
  const embed = link.kind === 'youtube' || link.kind === 'web' ? embedFor(link.url, pageOrigin()) : null;
  const embedUrl = embed?.embedUrl ?? null;
  const href = link.url;
  // a stream lives in one place: while it floats, the tab shows a placeholder instead of a second player
  const popped = !!embedUrl && floats.some((f) => f.url === embedUrl);
  const full = floats.length >= MAX_FLOATS;

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
      {embedUrl && popped ? (
        <div className="stream-fallback">
          <div className="dim">{link.title} is playing in a pop-out window.</div>
          <button className="btn active" onClick={() => closeFloat(embedUrl)}>Dock back</button>
        </div>
      ) : embedUrl ? (
        <StreamFrame key={embedUrl} url={embedUrl} autoplay={false} />
      ) : (
        <div className="stream-fallback">
          <div className="dim">{link.title} cannot be embedded (the provider blocks framing).</div>
          <a className="btn active" href={href} target="_blank" rel="noopener noreferrer">Open {link.kind === 'nasa-tv' ? 'NASA TV' : 'stream'}</a>
        </div>
      )}
      <div className="stream-meta">
        <span className="mono dim">{link.kind === 'nasa-tv' ? 'NASA TV' : 'Stream'}{link.live ? ', live' : ''}</span>
        <span className="stream-actions">
          {embedUrl && !popped && (
            <button
              className="btn"
              onClick={() => openFloat(embedUrl, link.title)}
              disabled={full}
              title={full ? `At most ${MAX_FLOATS} pop-out windows: close or dock one first` : 'Open this stream in a floating window'}
            >
              Pop out
            </button>
          )}
          <a href={href} target="_blank" rel="noopener noreferrer">Open in new tab</a>
        </span>
      </div>
    </div>
  );
}
