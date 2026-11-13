/**
 * Pure geometry and state rules for the pop-out stream windows. No DOM access except the injected storage.
 * A window is a title bar (FLOAT_HEAD_PX) above a 16:9 frame; its width is the only free size, height follows.
 * A window's `url` is the embed URL from lib/stream-url.ts (YouTube, Twitch, Vimeo or a direct video file).
 */

import { providerOfEmbed, type StreamProvider } from './stream-url';

/** At most this many windows at once (each starts about a third of the viewport wide and cascades, so four fit a 1000 x 700 window). */
export const MAX_FLOATS = 4;
/** Narrowest window, measured on the frame, px. */
export const MIN_FLOAT_W = 240;
/** Title bar height above the frame, px. */
export const FLOAT_HEAD_PX = 28;
export const ASPECT_W = 16;
export const ASPECT_H = 9;
export const FLOAT_STORAGE_KEY = 'eio.float.v1';

export interface Viewport {
  w: number;
  h: number;
}

/** Position and size of a window, px. `h` is always derived from `w` (title bar included). */
export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatWindow extends FloatRect {
  /** embed URL; also the identity of the window (one window per stream) */
  url: string;
  title: string;
  /** stacking order: higher is in front */
  z: number;
}

export function viewportNow(): Viewport {
  return typeof window === 'undefined' ? { w: 1280, h: 800 } : { w: window.innerWidth, h: window.innerHeight };
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Height of the 16:9 frame for a frame width. */
export function frameHeight(w: number): number {
  return Math.round((w * ASPECT_H) / ASPECT_W);
}

/** Full window height: title bar plus frame. */
export function totalHeight(w: number): number {
  return FLOAT_HEAD_PX + frameHeight(w);
}

/** Widest frame that fits the viewport in both directions (never below the minimum). */
function maxWidth(vp: Viewport): number {
  const byHeight = Math.floor(((vp.h - FLOAT_HEAD_PX) * ASPECT_W) / ASPECT_H);
  return Math.max(MIN_FLOAT_W, Math.min(vp.w, byHeight));
}

/**
 * Keep a window fully inside the viewport at 16:9 and no narrower than MIN_FLOAT_W.
 * A viewport too small for the minimum lets the window overflow (the minimum wins).
 */
export function fitRect(r: { x: number; y: number; w: number }, vp: Viewport): FloatRect {
  const w = clampNum(Number.isFinite(r.w) ? Math.round(r.w) : MIN_FLOAT_W, MIN_FLOAT_W, maxWidth(vp));
  const h = totalHeight(w);
  const x = clampNum(Number.isFinite(r.x) ? Math.round(r.x) : 0, 0, Math.max(0, vp.w - w));
  const y = clampNum(Number.isFinite(r.y) ? Math.round(r.y) : 0, 0, Math.max(0, vp.h - h));
  return { x, y, w, h };
}

/** Move a window from its drag-start position by the pointer delta, clamped to the viewport. */
export function dragRect(start: { x: number; y: number; w: number }, dx: number, dy: number, vp: Viewport): FloatRect {
  return fitRect({ x: start.x + dx, y: start.y + dy, w: start.w }, vp);
}

/**
 * Corner resize from the top-left anchor. The pointer delta becomes a width change: whichever axis moved further
 * wins (the vertical move is converted to width at 16:9), so the frame keeps its aspect ratio.
 */
export function resizeRect(start: { x: number; y: number; w: number }, dx: number, dy: number, vp: Viewport): FloatRect {
  const dyAsWidth = (dy * ASPECT_W) / ASPECT_H;
  const dw = Math.abs(dx) >= Math.abs(dyAsWidth) ? dx : dyAsWidth;
  return fitRect({ x: start.x, y: start.y, w: start.w + dw }, vp);
}

/** A new window's rect: about a third of the viewport wide (at most 480 px), cascaded by `offset`, inside the viewport. */
export function defaultRect(vp: Viewport, offset = 0): FloatRect {
  const w = Math.round(Math.min(480, Math.max(MIN_FLOAT_W, vp.w * 0.32)));
  return fitRect({ x: vp.w - w - 24 - offset * 32, y: 64 + offset * 32, w }, vp);
}

/** True for an embed URL the resolver (stream-url.ts) could have produced; anything else is never loaded in a window. */
export function isFloatableUrl(url: string): boolean {
  return providerOfEmbed(url) !== null;
}

export type { StreamProvider };

export function nextZ(list: readonly FloatWindow[]): number {
  return list.reduce((m, f) => Math.max(m, f.z), 0) + 1;
}

/** Bring a window to the front. Returns the same array when it is already on top or not open. */
export function focusFloatWindow(list: FloatWindow[], url: string): FloatWindow[] {
  const target = list.find((f) => f.url === url);
  if (!target) return list;
  if (list.every((f) => f.z <= target.z)) return list;
  const z = nextZ(list);
  return list.map((f) => (f.url === url ? { ...f, z } : f));
}

/**
 * Open a window for `url`. An already open stream is brought to the front instead. Beyond MAX_FLOATS the list
 * is returned unchanged, as it is for a URL that cannot be floated.
 */
export function openFloatWindow(list: FloatWindow[], url: string, title: string, vp: Viewport): FloatWindow[] {
  if (!isFloatableUrl(url)) return list;
  if (list.some((f) => f.url === url)) return focusFloatWindow(list, url);
  if (list.length >= MAX_FLOATS) return list;
  const rect = defaultRect(vp, list.length);
  return [...list, { url, title: title.slice(0, 200) || 'Live stream', ...rect, z: nextZ(list) }];
}

export function closeFloatWindow(list: FloatWindow[], url: string): FloatWindow[] {
  return list.some((f) => f.url === url) ? list.filter((f) => f.url !== url) : list;
}

/** Store a window's new position and width, clamped to the viewport. Keeps its title and stacking order. */
export function setFloatRect(list: FloatWindow[], url: string, r: { x: number; y: number; w: number }, vp: Viewport): FloatWindow[] {
  return list.map((f) => (f.url === url ? { ...f, ...fitRect(r, vp) } : f));
}

/** Parse persisted windows; anything malformed is dropped, the rest keep their order, at most MAX_FLOATS. */
export function parseFloats(raw: string | null | undefined): FloatWindow[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: FloatWindow[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const { url, title, x, y, w } = item as Record<string, unknown>;
    if (typeof url !== 'string' || !isFloatableUrl(url) || seen.has(url)) continue;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number') continue;
    if (![x, y, w].every(Number.isFinite) || w < MIN_FLOAT_W) continue;
    seen.add(url);
    const width = Math.round(w);
    out.push({
      url,
      title: typeof title === 'string' && title ? title.slice(0, 200) : 'Live stream',
      x: Math.round(x),
      y: Math.round(y),
      w: width,
      h: totalHeight(width),
      z: out.length + 1,
    });
    if (out.length >= MAX_FLOATS) break;
  }
  return out;
}

/** Minimal slice of the Web Storage interface. */
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

export function loadFloats(storage: StorageLike | null | undefined = defaultStorage()): FloatWindow[] {
  try {
    return parseFloats(storage?.getItem(FLOAT_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveFloats(list: readonly FloatWindow[], storage: StorageLike | null | undefined = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    if (list.length === 0) storage.removeItem?.(FLOAT_STORAGE_KEY);
    else {
      const rows = list.map(({ url, title, x, y, w, z }) => ({ url, title, x, y, w, z }));
      storage.setItem(FLOAT_STORAGE_KEY, JSON.stringify(rows));
    }
    return true;
  } catch {
    return false;
  }
}
