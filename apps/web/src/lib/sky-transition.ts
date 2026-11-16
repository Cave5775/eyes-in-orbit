import { clampFov } from './first-person';

/**
 * How the scene area changes into the Aladin sky view and back (pure: ids, remembered choice, timings and animation values; the
 * DOM side is ui/SkyOverlay.tsx). Everything animates transform, opacity or clip-path only.
 *
 * - crossfade: the Aladin view fades in over the scene (default).
 * - iris: a circle grows from the centre of the view and reveals Aladin.
 * - zoom: the scene's camera narrows its field of view toward the look direction (600 ms), Aladin fades in at the matching field
 *   of view, then pulls back to the real one. Leaving plays it in reverse (Aladin zooms in, then fades out).
 * - sweep: a wipe from left to right with a thin bright scanline on its edge.
 * - cut: no animation.
 * `prefers-reduced-motion` turns every choice into a cut.
 */
export type SkyTransitionId = 'crossfade' | 'iris' | 'zoom' | 'sweep' | 'cut';

export interface SkyTransitionInfo { id: SkyTransitionId; label: string; hint: string }

export const SKY_TRANSITIONS: readonly SkyTransitionInfo[] = [
  { id: 'crossfade', label: 'Crossfade', hint: 'The sky fades in over the scene' },
  { id: 'iris', label: 'Iris', hint: 'A circle opens from the centre onto the sky' },
  { id: 'zoom', label: 'Zoom through', hint: 'The scene zooms toward where you look, then the sky takes over' },
  { id: 'sweep', label: 'Sweep', hint: 'A wipe with a scanline edge, left to right' },
  { id: 'cut', label: 'Cut', hint: 'No transition' },
];

export const DEFAULT_SKY_TRANSITION: SkyTransitionId = 'crossfade';
export const SKY_TRANSITION_KEY = 'eio.skyTransition';

export function parseSkyTransition(raw: string | null | undefined): SkyTransitionId {
  return SKY_TRANSITIONS.some((t) => t.id === raw) ? (raw as SkyTransitionId) : DEFAULT_SKY_TRANSITION;
}

/** The transition that actually plays: a cut for people who ask for reduced motion. */
export const effectiveTransition = (id: SkyTransitionId, reducedMotion: boolean): SkyTransitionId => (reducedMotion ? 'cut' : id);

/** Length of the curtain animation (the part that reveals Aladin), ms. Zoom: the fade only; see ZOOM_*. */
export const TRANSITION_MS: Record<SkyTransitionId, number> = { crossfade: 600, iris: 750, zoom: 160, sweep: 700, cut: 0 };

/** Zoom through: the scene's field of view narrows to this fraction of its own over ZOOM_SCENE_MS, ... */
export const ZOOM_NARROW_FACTOR = 0.4;
export const ZOOM_SCENE_MS = 600;
/** ... Aladin (at the narrowed field of view) fades in over TRANSITION_MS.zoom, then widens to the real field over this long. */
export const ZOOM_PULL_BACK_MS = 350;

/** Total length of the entering transition, ms (the scene is paused when it ends). */
export function enterDurationMs(id: SkyTransitionId): number {
  return id === 'zoom' ? ZOOM_SCENE_MS + TRANSITION_MS.zoom + ZOOM_PULL_BACK_MS : TRANSITION_MS[id];
}

/** Web Animations keyframes of the curtain (the element holding Aladin) from hidden to fully shown; played in reverse to leave. */
export function curtainKeyframes(id: SkyTransitionId): Keyframe[] | null {
  switch (id) {
    case 'crossfade':
    case 'zoom':
      return [{ opacity: 0 }, { opacity: 1 }];
    case 'iris':
      // a percentage radius is relative to the box diagonal over root 2: 71% reaches the corners from the centre
      return [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }];
    case 'sweep':
      return [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }];
    case 'cut':
      return null;
  }
}

/**
 * Keyframes of the scanline (a full-size box whose right border is the line) that rides the sweep's edge: the curtain is clipped
 * at x = W (1 - r) and the line sits at W + tx, so tx = -r W keeps them together. Null for every other transition.
 */
export function scanKeyframes(id: SkyTransitionId): Keyframe[] | null {
  return id === 'sweep' ? [{ transform: 'translateX(-100%)', opacity: 1 }, { transform: 'translateX(0%)', opacity: 1 }] : null;
}

/** The easing of the curtain animation. */
export const curtainEasing = (id: SkyTransitionId): string => (id === 'iris' ? 'cubic-bezier(0.4, 0, 0.2, 1)' : id === 'sweep' ? 'cubic-bezier(0.45, 0, 0.25, 1)' : 'ease-in-out');

const easeInCubic = (p: number) => p * p * p;
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const clamp01 = (p: number) => Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));

/** Vertical field of view the scene's camera ends the zoom at. */
export const zoomNarrowFov = (vFovDeg: number): number => clampFov(vFovDeg * ZOOM_NARROW_FACTOR);

/** The scene camera's vertical field of view `p` (0..1) of the way through the zoom: it starts slowly and ends fast, like falling toward the target. */
export function zoomSceneFov(vFovDeg: number, p: number): number {
  const end = zoomNarrowFov(vFovDeg);
  return vFovDeg + (end - vFovDeg) * easeInCubic(clamp01(p));
}

/** Aladin's horizontal field of view `p` of the way through its pull back from `narrowDeg` to `fullDeg` (a ratio of fields, so the zoom feels even). */
export function zoomAladinFov(narrowDeg: number, fullDeg: number, p: number): number {
  const k = easeOutCubic(clamp01(p));
  return Math.exp(Math.log(narrowDeg) + (Math.log(fullDeg) - Math.log(narrowDeg)) * k);
}
