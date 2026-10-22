/** Pure sizing and persistence logic for the resizable panels (no DOM access except the injected storage). */

export type PanelKey = 'left' | 'right' | 'bottom' | 'dsn';
export type PanelSizes = Partial<Record<PanelKey, number>>;

interface Spec {
  /** default size in px on a wide viewport */
  def: number;
  /** default size in px on a viewport at or below NARROW_PX wide */
  defNarrow: number;
  min: number;
  max: number;
}

/** Sizes in px: widths for `left`, `right` and `dsn` (the DSN panel inside the bottom row), height for `bottom`. */
export const PANELS: Record<PanelKey, Spec> = {
  left: { def: 292, defNarrow: 240, min: 200, max: 640 },
  right: { def: 372, defNarrow: 320, min: 260, max: 760 },
  bottom: { def: 176, defNarrow: 176, min: 110, max: 520 },
  dsn: { def: 470, defNarrow: 360, min: 260, max: 900 },
};

export const PANEL_KEYS = Object.keys(PANELS) as PanelKey[];

/** Viewport width at or below which the narrow defaults apply (matches the CSS media query). */
export const NARROW_PX = 1100;
/** Minimum space that must stay for the globe. */
export const MIN_SCENE_W = 360;
export const MIN_SCENE_H = 200;
/** Top bar plus news ticker rows (px), see styles.css. */
export const CHROME_H = 46 + 26;

export const STORAGE_KEY = 'eio.layout.v1';

export interface Viewport {
  w: number;
  h: number;
}

export function defaultSize(key: PanelKey, vw: number): number {
  return vw <= NARROW_PX ? PANELS[key].defNarrow : PANELS[key].def;
}

/** Upper bound for `key` given the viewport and the other (already effective) sizes. */
export function maxSize(key: PanelKey, sizes: Record<PanelKey, number>, vp: Viewport): number {
  const spec = PANELS[key];
  let room: number;
  switch (key) {
    case 'left': room = vp.w - MIN_SCENE_W - sizes.right; break;
    case 'right': room = vp.w - MIN_SCENE_W - sizes.left; break;
    case 'bottom': room = vp.h - CHROME_H - MIN_SCENE_H; break;
    case 'dsn': room = vp.w - PANELS.dsn.min; break;
  }
  // never let a tiny viewport push the cap below the minimum
  return Math.max(spec.min, Math.min(spec.max, room));
}

/** Clamp `value` into [min, max] for `key`; non-finite input falls back to the default. */
export function clampSize(key: PanelKey, value: number, sizes: Record<PanelKey, number>, vp: Viewport): number {
  const v = Number.isFinite(value) ? value : defaultSize(key, vp.w);
  return Math.round(Math.min(maxSize(key, sizes, vp), Math.max(PANELS[key].min, v)));
}

/**
 * Effective sizes: stored overrides (or defaults) clamped for the viewport. `left` and `right` are
 * resolved first against the other's default so that shrinking the window cannot hide the globe.
 */
export function resolveSizes(stored: PanelSizes, vp: Viewport): Record<PanelKey, number> {
  const out = {
    left: stored.left ?? defaultSize('left', vp.w),
    right: stored.right ?? defaultSize('right', vp.w),
    bottom: stored.bottom ?? defaultSize('bottom', vp.w),
    dsn: stored.dsn ?? defaultSize('dsn', vp.w),
  };
  out.left = clampSize('left', out.left, out, vp);
  out.right = clampSize('right', out.right, out, vp);
  out.left = clampSize('left', out.left, out, vp);
  out.bottom = clampSize('bottom', out.bottom, out, vp);
  out.dsn = clampSize('dsn', out.dsn, out, vp);
  return out;
}

/** New size while dragging: `sign` is +1 when the size grows with the pointer, -1 when it shrinks. */
export function dragSize(start: number, delta: number, sign: 1 | -1): number {
  return start + sign * delta;
}

export const STEP = 16;
export const STEP_BIG = 64;

export function keyboardStep(shift: boolean): number {
  return shift ? STEP_BIG : STEP;
}

/** Minimal slice of the Web Storage interface. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Parse persisted sizes; unknown keys, non-numbers and out-of-range values are dropped. */
export function parseSizes(raw: string | null | undefined): PanelSizes {
  if (!raw) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: PanelSizes = {};
  for (const key of PANEL_KEYS) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= PANELS[key].min && v <= PANELS[key].max) out[key] = Math.round(v);
  }
  return out;
}

export function loadSizes(storage: StorageLike | null | undefined = defaultStorage()): PanelSizes {
  try {
    return parseSizes(storage?.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

export function saveSizes(sizes: PanelSizes, storage: StorageLike | null | undefined = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    if (Object.keys(sizes).length === 0) storage.removeItem?.(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(sizes));
    return true;
  } catch {
    return false;
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
