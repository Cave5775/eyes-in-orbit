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

const PARAMS = 'autoplay=1&mute=1&rel=0&modestbranding=1&playsinline=1';

/** Convert a YouTube watch/live/short URL to an embeddable iframe URL, or null if it is not YouTube. */
export function toEmbedUrl(url: string): string | null {
  const id = youtubeVideoId(url);
  if (id) return `https://www.youtube.com/embed/${id}?${PARAMS}`;
  const channel = youtubeLiveChannel(url);
  return channel ? `https://www.youtube.com/embed/live_stream?channel=${channel}&${PARAMS}` : null;
}

/** Only YouTube is reliably frameable; NASA TV, X and generic pages link out. */
export function resolveStream(link: StreamLink): { embedUrl: string | null; href: string } {
  return { embedUrl: link.kind === 'youtube' || link.kind === 'web' ? toEmbedUrl(link.url) : null, href: link.url };
}
