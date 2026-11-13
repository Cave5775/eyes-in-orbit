import { toEmbedUrl } from './youtube';

/**
 * Turns a pasted livestream URL into something the pop-out windows can show. Pure: no DOM, no network. Supported:
 * YouTube (watch, live, shorts, embed, youtu.be, channel live), Twitch (channel and video), Vimeo (video pages and
 * player links) and direct video files (.mp4, .webm, .m3u8). Anything else, and any scheme other than http(s),
 * is rejected so a pasted `javascript:` or `data:` URL can never reach an iframe or a video element.
 */

export type StreamProvider = 'youtube' | 'twitch' | 'vimeo' | 'video';

export interface StreamEmbed {
  /** what the iframe (or the video element, for 'video') loads; also the identity of a pop-out window */
  embedUrl: string;
  provider: StreamProvider;
  /** a short window title */
  title: string;
}

const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const VIDEO_EXT = /\.(mp4|webm|m3u8)$/i;
/** Twitch top-level paths that are not channels. */
const TWITCH_RESERVED = new Set([
  'videos', 'directory', 'downloads', 'jobs', 'turbo', 'settings', 'subscriptions', 'wallet', 'friends', 'messages', 'p', 'store', 'search', 'login', 'signup', 'embed',
]);

/** Parse an http(s) URL without credentials; a bare `host/path` gets `https://`. Null for anything else. */
export function parseWebUrl(input: string): URL | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text) ? text : `https://${text}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || !u.hostname) return null;
  return u;
}

/** The URL as a safe link target (http or https only), or null. */
export function safeHref(input: string): string | null {
  return parseWebUrl(input)?.href ?? null;
}

function twitchEmbed(u: URL, origin: string | undefined): StreamEmbed | null {
  if (!TWITCH_HOSTS.has(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  let key: 'channel' | 'video';
  let value: string;
  let title: string;
  if (parts[0] === 'videos' && /^\d{1,15}$/.test(parts[1] ?? '')) {
    key = 'video';
    value = `v${parts[1]}`;
    title = 'Twitch video';
  } else if (parts.length === 1 && /^\w{3,25}$/.test(parts[0]) && !TWITCH_RESERVED.has(parts[0].toLowerCase())) {
    key = 'channel';
    value = parts[0].toLowerCase();
    title = `Twitch: ${parts[0]}`;
  } else return null;
  let parent = 'localhost';
  try {
    if (origin) parent = new URL(origin).hostname || parent;
  } catch { /* keep the default */ }
  const p = new URLSearchParams({ [key]: value, parent, autoplay: 'true', muted: 'true' });
  return { embedUrl: `https://player.twitch.tv/?${p.toString()}`, provider: 'twitch', title };
}

function vimeoEmbed(u: URL): StreamEmbed | null {
  if (!VIMEO_HOSTS.has(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const player = u.hostname === 'player.vimeo.com';
  const id = player ? (parts[0] === 'video' ? parts[1] : undefined) : parts.length >= 1 ? parts[parts.length - 1] : undefined;
  // vimeo.com/<id>, vimeo.com/channels/<name>/<id>, vimeo.com/groups/<name>/videos/<id>, player.vimeo.com/video/<id>
  if (!id || !/^\d{4,12}$/.test(id)) return null;
  const p = new URLSearchParams({ autoplay: '1', muted: '1' });
  return { embedUrl: `https://player.vimeo.com/video/${id}?${p.toString()}`, provider: 'vimeo', title: `Vimeo ${id}` };
}

function videoEmbed(u: URL): StreamEmbed | null {
  if (!VIDEO_EXT.test(u.pathname)) return null;
  const raw = u.pathname.split('/').pop() ?? '';
  let file = raw;
  try {
    file = decodeURIComponent(raw); // a malformed %-escape throws: keep the raw name
  } catch { /* keep raw */ }
  file ||= u.hostname;
  return { embedUrl: u.href, provider: 'video', title: `${u.hostname}: ${file}`.slice(0, 80) };
}

/** Resolve a pasted URL to an embed, or null when it is not a supported stream. `origin` is the page's own origin (Twitch needs its host). */
export function embedFor(url: string, origin?: string): StreamEmbed | null {
  try {
    return resolveEmbed(url, origin);
  } catch {
    return null; // never throw: callers resolve links during render
  }
}

function resolveEmbed(url: string, origin?: string): StreamEmbed | null {
  const u = parseWebUrl(url);
  if (!u) return null;
  const yt = toEmbedUrl(u.href, origin);
  if (yt) return { embedUrl: yt, provider: 'youtube', title: 'YouTube stream' };
  return twitchEmbed(u, origin) ?? vimeoEmbed(u) ?? videoEmbed(u);
}

/** Which provider an embed URL (as produced by `embedFor`) belongs to; null for anything the pop-outs must not load. */
export function providerOfEmbed(embedUrl: string): StreamProvider | null {
  let u: URL;
  try {
    u = new URL(embedUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.protocol === 'https:' && u.hostname === 'www.youtube.com') {
    return u.pathname.startsWith('/embed/') && u.pathname.length > '/embed/'.length ? 'youtube' : null;
  }
  if (u.protocol === 'https:' && u.hostname === 'player.twitch.tv') return u.searchParams.has('channel') || u.searchParams.has('video') ? 'twitch' : null;
  if (u.protocol === 'https:' && u.hostname === 'player.vimeo.com') return /^\/video\/\d+$/.test(u.pathname) ? 'vimeo' : null;
  return VIDEO_EXT.test(u.pathname) ? 'video' : null;
}

export const SUPPORTED_HINT = 'YouTube, Twitch, Vimeo, or a direct .mp4, .webm or .m3u8 file';

export type WatchResult =
  | { ok: true; embed: StreamEmbed }
  | { ok: false; error: string; /** the typed URL as a safe link, when it is a web URL at all */ href: string | null };

/** What the "Watch a livestream" fields do with the typed text. */
export function watchResult(text: string, origin?: string): WatchResult {
  if (!text.trim()) return { ok: false, error: 'Paste a livestream link first.', href: null };
  const embed = embedFor(text, origin);
  if (embed) return { ok: true, embed };
  return { ok: false, error: `Not a supported stream link. Supported: ${SUPPORTED_HINT}.`, href: safeHref(text) };
}
