import { memo, useEffect, useRef, useState } from 'react';
import { providerOfEmbed } from '../lib/stream-url';
import { YT_ORIGIN, parseWidgetMessage, widgetCommand, widgetListen, type WidgetCommand, type WidgetInfo } from '../lib/youtube';

/**
 * The only element that holds the live video, used by the docked Stream tab and by pop-out windows. Memoised on
 * the URL alone so scene, clock, store and selection updates never re-render (and never reload) the iframe.
 * Play and mute state comes back from the player by postMessage into this component's own state.
 * The strip is shown on hover (or always, on touch screens) and sits over the bottom edge of the frame.
 * Only YouTube takes our strip (its player is driven by postMessage). Twitch and Vimeo embeds keep their own controls,
 * and a direct video file is a <video controls> element (an HLS .m3u8 only where the browser plays it natively).
 */
export const StreamFrame = memo(function StreamFrame({ url, className = '' }: { url: string; className?: string }) {
  const provider = providerOfEmbed(url);
  if (provider === 'video') return <VideoPlayer url={url} className={className} />;
  if (provider === 'twitch' || provider === 'vimeo') {
    return (
      <div className={`stream-player ${className}`.trim()}>
        <iframe
          className="stream-frame" src={url} title="Live stream" allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
      </div>
    );
  }
  return <YouTubeFrame url={url} className={className} />;
});

/** Whether this browser plays HLS itself (Safari, iOS); other browsers would need a library, which the app does not bundle. */
function hlsNative(): boolean {
  try {
    return document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
  } catch {
    return false;
  }
}

function VideoPlayer({ url, className }: { url: string; className: string }) {
  const hls = /.m3u8$/i.test(new URL(url).pathname);
  if (hls && !hlsNative()) {
    return (
      <div className={`stream-player stream-fallback ${className}`.trim()}>
        <div className="dim">This browser cannot play HLS (.m3u8) streams directly.</div>
        <a className="btn active" href={url} target="_blank" rel="noopener noreferrer">Open stream</a>
      </div>
    );
  }
  return (
    <div className={`stream-player ${className}`.trim()}>
      <video className="stream-frame" src={url} controls autoPlay muted playsInline preload="metadata" />
    </div>
  );
}

function YouTubeFrame({ url, className }: { url: string; className: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // the embed starts muted (mute=1), so that is the state until the player says otherwise
  const [info, setInfo] = useState<WidgetInfo>({ muted: true });
  // The pointer over a cross-origin iframe is delivered to the frame, not the page: the transparent cover below
  // takes the pointer instead, so hover and click reach the page and can reveal the strip.
  const [hot, setHot] = useState(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== YT_ORIGIN || !frame.current || e.source !== frame.current.contentWindow) return;
      const next = parseWidgetMessage(e.data);
      if (next) setInfo((prev) => ({ ...prev, ...next }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const send = (func: WidgetCommand) => frame.current?.contentWindow?.postMessage(widgetCommand(func), YT_ORIGIN);
  const onLoad = () => frame.current?.contentWindow?.postMessage(widgetListen(), YT_ORIGIN);
  const playing = info.playerState === 1 || info.playerState === 3;
  const muted = info.muted ?? true;

  const togglePlay = () => {
    send(playing ? 'pauseVideo' : 'playVideo');
    setInfo((p) => ({ ...p, playerState: playing ? 2 : 1 }));
  };
  const toggleMute = () => {
    send(muted ? 'unMute' : 'mute');
    setInfo((p) => ({ ...p, muted: !muted }));
  };

  return (
    <div
      className={`stream-player ${hot ? 'hot' : ''} ${className}`.trim()}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
    >
      <iframe
        ref={frame}
        className="stream-frame"
        src={url}
        title="Live stream"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={onLoad}
      />
      {/* transparent: the picture stays unobstructed; a click on it reveals the strip */}
      <div className="stream-cover" onMouseEnter={() => setHot(true)} onClick={() => setHot(true)} />
      <div className="stream-strip">
        <button className="btn" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>{playing ? 'Pause' : 'Play'}</button>
        <button className="btn" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>{muted ? 'Unmute' : 'Mute'}</button>
      </div>
    </div>
  );
}
