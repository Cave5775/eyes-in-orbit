import { embedFor, parseWebUrl } from './stream-url';

/**
 * The links the user opened with "Watch a livestream", remembered in this browser (localStorage 'eio.recent-links.v1').
 * Pure: storage is passed in. Stored per entry: the link, a short title and the time it was last opened. Nothing else.
 *
 * Normalisation: the link is the typed text parsed by `parseWebUrl` (a bare `host/path` gets https://, the host is lower-cased,
 * a default port is dropped) with the #fragment removed; this href is the identity used to de-duplicate, so typing
 * `youtu.be/x` and `https://youtu.be/x#t=5` is one entry. The path and query are kept as typed (they name the stream).
 */

export const RECENT_STORAGE_KEY = 'eio.recent-links.v1';
export const MAX_RECENT = 20;
const MAX_TITLE = 80;

export interface RecentLink {
  /** normalised link, as the user typed it (re-resolved with embedFor on open) */
  url: string;
  title: string;
  /** ms since epoch, last opened */
  at: number;
}

/** The identity of a typed link, or null when it is not an http(s) link. */
export function normaliseLink(text: string): string | null {
  const u = parseWebUrl(text);
  if (!u) return null;
  u.hash = '';
  return u.href;
}

/** A row title: the window title the app gives the stream, or host and path when that is generic or empty. */
export function recentTitle(url: string, embedTitle?: string): string {
  const t = (embedTitle ?? '').trim();
  if (t && t !== 'YouTube stream') return t.slice(0, MAX_TITLE);
  const u = parseWebUrl(url);
  if (!u) return url.slice(0, MAX_TITLE);
  const v = u.searchParams.get('v');
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return `${u.hostname.replace(/^www\./, '')}${path}${v ? `?v=${v}` : ''}`.slice(0, MAX_TITLE);
}

/** Add (or move to the front) a link; de-duplicated by normalised link, capped. An invalid link leaves the list as it is. */
export function addRecent(list: readonly RecentLink[], text: string, embedTitle: string | undefined, now: number): RecentLink[] {
  const url = normaliseLink(text);
  if (!url || !embedFor(url)) return list.slice();
  const entry: RecentLink = { url, title: recentTitle(url, embedTitle), at: now };
  return [entry, ...list.filter((e) => e.url !== url)].slice(0, MAX_RECENT);
}

export function removeRecent(list: readonly RecentLink[], url: string): RecentLink[] {
  return list.filter((e) => e.url !== url);
}

/** Tolerant parse: corrupt JSON gives []; entries that the field itself would refuse are dropped; most recent first, capped. */
export function parseRecent(raw: string | null | undefined): RecentLink[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: RecentLink[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const { url, title, at } = row as Record<string, unknown>;
    if (typeof url !== 'string') continue;
    const norm = normaliseLink(url);
    if (!norm || norm !== url || seen.has(norm) || !embedFor(norm)) continue;
    seen.add(norm);
    out.push({
      url: norm,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, MAX_TITLE) : recentTitle(norm),
      at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_RECENT);
}

export function serialiseRecent(list: readonly RecentLink[]): string {
  return JSON.stringify(list.slice(0, MAX_RECENT).map(({ url, title, at }) => ({ url, title, at })));
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadRecent(storage: StorageLike | null | undefined = defaultStorage()): RecentLink[] {
  try {
    return parseRecent(storage?.getItem(RECENT_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveRecent(list: readonly RecentLink[], storage: StorageLike | null | undefined = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    if (list.length === 0) storage.removeItem?.(RECENT_STORAGE_KEY);
    else storage.setItem(RECENT_STORAGE_KEY, serialiseRecent(list));
    return true;
  } catch {
    return false;
  }
}
