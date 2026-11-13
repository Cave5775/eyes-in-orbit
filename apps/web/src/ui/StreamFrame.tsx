import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { providerOfEmbed, safeHref } from '../lib/stream-url';
import { YT_ORIGIN, isLiveChannelEmbed, parseWidgetMessage, widgetCommand, widgetListen, withNativeControls, withStart, type WidgetCommand, type WidgetInfo } from '../lib/youtube';
import { LIVE_SEEK_SECONDS, liveStatus } from '../lib/live';
import { usePlayerPrefs } from '../state/player';
import { barHeights, barsLit, toggleMute as toggledMute, wheelVolume, type VolumeState } from '../lib/volume';

/**
 * The only element that holds the live video, used by the docked Stream tab and by pop-out windows. Memoised on
 * the URL alone so scene, clock, store and selection updates never re-render (and never reload) the iframe.
 * Play and mute state comes back from the player by postMessage into this component's own state.
 * The strip is shown on hover (or always, on touch screens) and sits over the bottom edge of the frame.
 * Only YouTube takes our strip (its player is driven by postMessage). Twitch and Vimeo embeds keep their own controls,
 * and a direct video file is a <video controls> element (an HLS .m3u8 only where the browser plays it natively).
 * The strip's CONTROLS button switches every YouTube player to YouTube's own control bar (one shared choice,
 * `state/player.ts`); the players reload once (the `controls` embed parameter is read only at load; the IFrame API has no
 * setter for it), each resuming at its last position through `start=` unless it is live, and a HIDE CONTROLS button in
 * the corner switches back. The LIVE button (live streams only) shows whether the player is at the live head and jumps there.
 * Only the controls choice changes the iframe src; the src is held in a ref so no other render can reload the frame.
 */
export const StreamFrame = memo(function StreamFrame({ url, className = '', autoplay = true }: { url: string; className?: string; /** direct video only: false = wait for a click (the docked tab) */ autoplay?: boolean }) {
  const provider = providerOfEmbed(url);
  if (provider === null) {
    const href = safeHref(url);
    return (
      <div className={`stream-player stream-fallback ${className}`.trim()}>
        <div className="dim">This link cannot be shown here.</div>
        {href && <a className="btn active" href={href} target="_blank" rel="noopener noreferrer">Open in new tab</a>}
      </div>
    );
  }
  if (provider === 'video') return <VideoPlayer url={url} className={className} autoplay={autoplay} />;
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

function VideoPlayer({ url, className, autoplay }: { url: string; className: string; autoplay: boolean }) {
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
      <video className="stream-frame" src={url} controls autoPlay={autoplay && url.startsWith('https:')} muted playsInline preload="metadata" />
    </div>
  );
}

function YouTubeFrame({ url, className }: { url: string; className: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // the embed starts muted (mute=1), so that is the state until the player says otherwise
  const [info, setInfo] = useState<WidgetInfo>({ muted: true });
  // the level the wheel sets; YouTube reports its own in infoDelivery, which overrides this
  const [volume, setVolume] = useState(100);
  const muteBtn = useRef<HTMLButtonElement>(null);
  // The pointer over a cross-origin iframe is delivered to the frame, not the page: the transparent cover below
  // takes the pointer instead, so hover and click reach the page and can reveal the strip.
  const [hot, setHot] = useState(false);
  const native = usePlayerPrefs((s) => s.nativeControls);
  const setNative = usePlayerPrefs((s) => s.setNativeControls);
  const live = liveStatus(info, isLiveChannelEmbed(url));
  // The src changes only when the controls choice (or the link) does; the reload resumes where this player was.
  const srcRef = useRef<{ url: string; native: boolean; src: string }>();
  if (!srcRef.current || srcRef.current.url !== url || srcRef.current.native !== native) {
    const resume = srcRef.current && srcRef.current.url === url && live === 'hidden' ? info.currentTime : undefined;
    srcRef.current = { url, native, src: withStart(withNativeControls(url, native), resume) };
  }
  const src = srcRef.current.src;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== YT_ORIGIN || !frame.current || e.source !== frame.current.contentWindow) return;
      const next = parseWidgetMessage(e.data);
      if (next) {
        setInfo((prev) => ({ ...prev, ...next }));
        if (next.volume !== undefined) setVolume(next.volume);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const send = (func: WidgetCommand, args: unknown[] = []) => frame.current?.contentWindow?.postMessage(widgetCommand(func, args), YT_ORIGIN);
  const onLoad = () => frame.current?.contentWindow?.postMessage(widgetListen(), YT_ORIGIN);
  const playing = info.playerState === 1 || info.playerState === 3;
  const muted = info.muted ?? true;
  const lit = barsLit({ volume, muted });

  const goLive = () => {
    send('seekTo', [LIVE_SEEK_SECONDS, true]);
    send('playVideo');
  };
  const togglePlay = () => {
    send(playing ? 'pauseVideo' : 'playVideo');
    setInfo((p) => ({ ...p, playerState: playing ? 2 : 1 }));
  };
  // the latest state, also between renders: several wheel events can arrive before React redraws, each must start from the last
  const stateRef = useRef<VolumeState>({ volume, muted });
  stateRef.current = { volume, muted };
  const apply = (from: VolumeState, to: VolumeState) => {
    stateRef.current = to;
    if (to.volume !== from.volume) send('setVolume', [to.volume]);
    if (to.muted !== from.muted) send(to.muted ? 'mute' : 'unMute');
    setVolume(to.volume);
    setInfo((p) => ({ ...p, muted: to.muted }));
  };
  const toggleMute = () => {
    const from = { volume, muted };
    apply(from, toggledMute(from));
  };
  // arrow keys on the focused button change the level like the wheel (up/right louder), so it is not mouse-only
  const onVolumeKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const from = stateRef.current;
    apply(from, wheelVolume(from, dir));
  };
  // non-passive, so preventDefault keeps the page from scrolling and the globe from zooming
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const el = muteBtn.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const from = stateRef.current;
      applyRef.current(from, wheelVolume(from, e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [native]);

  return (
    <div
      className={`stream-player ${hot ? 'hot' : ''} ${className}`.trim()}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
    >
      <iframe
        ref={frame}
        className="stream-frame"
        src={src}
        title="Live stream"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={onLoad}
      />
      {native ? (
        // YouTube's own bar takes the clicks, so no cover; only a small corner button to switch back
        <button className="btn stream-ctl-toggle" onClick={() => setNative(false)} title="Hide the player's own controls on all video players">Hide controls</button>
      ) : (
        <>
          {/* transparent: the picture stays unobstructed; a click on it reveals the strip */}
          <div className="stream-cover" onMouseEnter={() => setHot(true)} onClick={() => setHot(true)} />
          <div className="stream-strip">
            <button className="btn" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>{playing ? 'Pause' : 'Play'}</button>
            <button ref={muteBtn} className="btn vol-btn" onClick={toggleMute} onKeyDown={onVolumeKey} title={`${muted ? 'Unmute' : 'Mute'}; scroll the wheel to change the volume (${muted ? 0 : volume}%)`} aria-label={muted ? 'Unmute' : 'Mute'}>
              <span className="vol-bars" aria-hidden="true">
                {barHeights().map((h, i) => <span key={i} className={i < lit ? 'on' : ''} style={{ height: `${h * 100}%` }} />)}
              </span>
            </button>
            {live !== 'hidden' && (
              <button className={`btn live-btn ${live}`} onClick={goLive} title={live === 'live' ? 'Playing at the live edge' : 'Behind live or paused: jump to the live edge'}>
                <span className="live-dot" aria-hidden="true" />Live
              </button>
            )}
            <button className="btn" onClick={() => setNative(true)} title="Show the player's own controls (seek bar, quality, captions, fullscreen) on all video players">Controls</button>
          </div>
        </>
      )}
    </div>
  );
}
