/**
 * Zoom and pan of a picture inside a clipping box of the same size. A point p of the unzoomed picture (box
 * coordinates, origin top-left) is shown at p * scale + (x, y), so the CSS is `translate(x, y) scale(scale)` with
 * transform-origin 0 0. The pan is always clamped so the picture covers the box (no empty edges).
 */
export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
export const ZOOM_RESET: ZoomView = { scale: 1, x: 0, y: 0 };

/** Wheel exponent: about 12% per notch of 100 (deltaY is clamped so a fast flick cannot jump). */
const WHEEL_RATE = 0.0012;

export function wheelZoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(-Math.max(-300, Math.min(300, deltaY)) * WHEEL_RATE);
}

/** Clamps the scale to 1..8 and the pan so the picture covers the box; at scale 1 the pan is exactly 0. */
export function clampView(v: ZoomView, w: number, h: number): ZoomView {
  const scale = Number.isFinite(v.scale) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale)) : 1;
  if (scale <= ZOOM_MIN) return ZOOM_RESET;
  const x = Math.min(0, Math.max(w - w * scale, Number.isFinite(v.x) ? v.x : 0));
  const y = Math.min(0, Math.max(h - h * scale, Number.isFinite(v.y) ? v.y : 0));
  return { scale, x, y };
}

/** Multiplies the scale by `factor`, keeping the picture point under (cx, cy) (box coordinates) where it is. */
export function zoomAt(v: ZoomView, factor: number, cx: number, cy: number, w: number, h: number): ZoomView {
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale * factor));
  const ratio = scale / v.scale;
  return clampView({ scale, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio }, w, h);
}

/** Moves the picture by (dx, dy) screen pixels. */
export function panBy(v: ZoomView, dx: number, dy: number, w: number, h: number): ZoomView {
  return clampView({ scale: v.scale, x: v.x + dx, y: v.y + dy }, w, h);
}

export const isZoomed = (v: ZoomView): boolean => v.scale > ZOOM_MIN;
