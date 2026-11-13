import type { StreamLink } from '@eio/core';

const ID_RE = /^[\w-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

/** Extract a video id from any common YouTube URL shape, or null. */
export function youtubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.hostname === 'youtu.be') return ID_RE.test(parts[0] ?? '') ? parts[0] : null;
  if (!YT_HOSTS.has(u.hostname)) return null;
  const v = u.searchParams.get('v');
  if (parts[0] === 'watch') return v && ID_RE.test(v) ? v : null;
  if (['embed', 'live', 'shorts', 'v'].includes(parts[0]) && ID_RE.test(parts[1] ?? '')) return parts[1];
  return null;
}

/** `youtube.com/channel/<id>/live` style links resolve to the channel's current live stream. */
function youtubeLiveChannel(url: string): string | null {
  try {
    const u = new URL(url);
    if (!YT_HOSTS.has(u.hostname)) return null;
    const m = /^\/channel\/([\w-]+)\/live\/?$/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Origin of YouTube's player. The custom controls send commands to it and accept messages only from it. */
export const YT_ORIGIN = 'https://www.youtube.com';

/**
 * Embed parameters, all from YouTube's embed parameter reference. What each one does, and what it cannot do:
 * - `controls=0`: no control bar. Our own strip (play, pause, mute) replaces it, shown on hover.
 * - `modestbranding=1`: asks for a smaller YouTube logo. YouTube draws little or no logo now, so this is minor.
 * - `rel=0`: related videos are limited to the same channel. It does not remove them.
 * - `iv_load_policy=3`: no annotations (the in-video cards and overlays).
 * - `disablekb=1`: the player ignores keyboard shortcuts while it has focus.
 * - `fs=1`: keeps fullscreen available. The button sits in the control bar, so it shows only with `controls=1`.
 * - `playsinline=1`: plays inside the page on iOS instead of forcing fullscreen.
 * - `enablejsapi=1` with `origin`: lets the page drive the player with postMessage.
 * - `autoplay=1` with `mute=1`: browsers only allow muted autoplay. A user who opened a stream gets it playing,
 *   muted; the strip unmutes it.
 */
function embedParams(origin?: string): URLSearchParams {
  const p = new URLSearchParams({
    autoplay: '1',
    mute: '1',
    controls: '0',
    modestbranding: '1',
    rel: '0',
    iv_load_policy: '3',
    disablekb: '1',
    fs: '1',
    playsinline: '1',
    enablejsapi: '1',
  });
  if (origin && /^https?:\/\//.test(origin)) p.set('origin', origin);
  return p;
}

/**
 * The same YouTube embed with YouTube's own control bar on (`controls=1`, keyboard shortcuts back on) or off (the
 * defaults of `embedParams`). Everything else, including `enablejsapi`, stays, so our strip keeps working either way.
 * Changing the iframe src reloads the player, so callers switch it only on a user's click. Non-YouTube URLs pass through.
 */
export function withNativeControls(embedUrl: string, on: boolean): string {
  let u: URL;
  try {
    u = new URL(embedUrl);
  } catch {
    return embedUrl;
  }
  if (u.origin !== YT_ORIGIN || !u.pathname.startsWith('/embed/')) return embedUrl;
  u.searchParams.set('controls', on ? '1' : '0');
  u.searchParams.set('disablekb', on ? '0' : '1');
  return u.toString();
}

/** Convert a YouTube watch/live/short URL to an embeddable iframe URL, or null if it is not YouTube. */
export function toEmbedUrl(url: string, origin?: string): string | null {
  const id = youtubeVideoId(url);
  if (id) return `https://www.youtube.com/embed/${id}?${embedParams(origin).toString()}`;
  const channel = youtubeLiveChannel(url);
  if (!channel) return null;
  const p = embedParams(origin);
  p.set('channel', channel);
  return `https://www.youtube.com/embed/live_stream?${p.toString()}`;
}

/** The page's own origin, for the embed `origin` parameter. Undefined outside a browser or for file:// pages. */
export function pageOrigin(): string | undefined {
  try {
    const o = window.location.origin;
    return /^https?:\/\//.test(o) ? o : undefined;
  } catch {
    return undefined;
  }
}

/** Only YouTube is reliably frameable; NASA TV, X and generic pages link out. */
export function resolveStream(link: StreamLink, origin?: string): { embedUrl: string | null; href: string } {
  return { embedUrl: link.kind === 'youtube' || link.kind === 'web' ? toEmbedUrl(link.url, origin) : null, href: link.url };
}

export type WidgetCommand = 'playVideo' | 'pauseVideo' | 'mute' | 'unMute' | 'setVolume';

/** A player command as the IFrame API's postMessage form expects it. */
export function widgetCommand(func: WidgetCommand, args: unknown[] = []): string {
  return JSON.stringify({ event: 'command', func, args });
}

/** Sent once the iframe has loaded so the player starts posting its state (`infoDelivery`) to the page. */
export function widgetListen(): string {
  return JSON.stringify({ event: 'listening', id: 1, channel: 'widget' });
}

export interface WidgetInfo {
  /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued */
  playerState?: number;
  muted?: boolean;
  /** 0-100 */
  volume?: number;
}

/** Read the state fields out of a player message; null for anything else. */
export function parseWidgetMessage(data: unknown): WidgetInfo | null {
  let msg: unknown = data;
  if (typeof msg === 'string') {
    try {
      msg = JSON.parse(msg);
    } catch {
      return null;
    }
  }
  if (!msg || typeof msg !== 'object') return null;
  const { event, info } = msg as { event?: unknown; info?: unknown };
  if (event !== 'infoDelivery' || !info || typeof info !== 'object') return null;
  const { playerState, muted, volume } = info as { playerState?: unknown; muted?: unknown; volume?: unknown };
  const out: WidgetInfo = {};
  if (typeof playerState === 'number' && Number.isFinite(playerState)) out.playerState = playerState;
  if (typeof muted === 'boolean') out.muted = muted;
  if (typeof volume === 'number' && Number.isFinite(volume)) out.volume = volume;
  return out;
}
