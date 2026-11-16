import { describe, expect, it } from 'vitest';
import { FP_FOV_MIN } from '../src/lib/first-person';
import {
  DEFAULT_SKY_TRANSITION, SKY_TRANSITIONS, ZOOM_NARROW_FACTOR, ZOOM_PULL_BACK_MS, ZOOM_SCENE_MS, TRANSITION_MS,
  curtainEasing, curtainKeyframes, effectiveTransition, enterDurationMs, parseSkyTransition, scanKeyframes, zoomAladinFov, zoomNarrowFov, zoomSceneFov,
} from '../src/lib/sky-transition';

const ids = SKY_TRANSITIONS.map((t) => t.id);

describe('sky transitions', () => {
  it('lists crossfade (the default), iris, zoom, sweep and cut', () => {
    expect(ids).toEqual(['crossfade', 'iris', 'zoom', 'sweep', 'cut']);
    expect(DEFAULT_SKY_TRANSITION).toBe('crossfade');
    for (const t of SKY_TRANSITIONS) expect(t.label && t.hint).toBeTruthy();
  });

  it('parses a remembered id and falls back to the default on anything else', () => {
    for (const id of ids) expect(parseSkyTransition(id)).toBe(id);
    for (const bad of [null, undefined, '', 'Iris', 'wipe', '{}']) expect(parseSkyTransition(bad)).toBe('crossfade');
  });

  it('reduced motion turns every choice into a cut', () => {
    for (const id of ids) {
      expect(effectiveTransition(id, true)).toBe('cut');
      expect(effectiveTransition(id, false)).toBe(id);
    }
  });

  it('every moving transition animates only opacity, clip-path or transform', () => {
    const allowed = new Set(['opacity', 'clipPath', 'transform', 'offset', 'easing']);
    for (const id of ids) {
      for (const frames of [curtainKeyframes(id), scanKeyframes(id)]) {
        for (const f of frames ?? []) for (const k of Object.keys(f)) expect(allowed.has(k)).toBe(true);
      }
    }
    expect(curtainKeyframes('cut')).toBeNull();
    expect(curtainKeyframes('crossfade')).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(curtainKeyframes('iris')![0].clipPath).toMatch(/^circle\(0%/);
    expect(curtainKeyframes('sweep')!.map((f) => f.clipPath)).toEqual(['inset(0 100% 0 0)', 'inset(0 0% 0 0)']);
    expect(scanKeyframes('sweep')).not.toBeNull();
    for (const id of ['crossfade', 'iris', 'zoom', 'cut'] as const) expect(scanKeyframes(id)).toBeNull();
    for (const id of ids) expect(curtainEasing(id)).toBeTruthy();
  });

  it('timings: cut takes no time, zoom is the scene zoom, the fade and the pull back', () => {
    expect(enterDurationMs('cut')).toBe(0);
    expect(enterDurationMs('crossfade')).toBe(TRANSITION_MS.crossfade);
    expect(enterDurationMs('zoom')).toBe(ZOOM_SCENE_MS + TRANSITION_MS.zoom + ZOOM_PULL_BACK_MS);
    expect(ZOOM_SCENE_MS).toBe(600);
  });

  it('zoom: the scene field narrows monotonically from its own to the narrowed one, never below the first-person minimum', () => {
    expect(zoomSceneFov(60, 0)).toBe(60);
    expect(zoomSceneFov(60, 1)).toBeCloseTo(60 * ZOOM_NARROW_FACTOR, 9);
    let prev = 61;
    for (let i = 0; i <= 10; i++) {
      const f = zoomSceneFov(60, i / 10);
      expect(f).toBeLessThanOrEqual(prev);
      prev = f;
    }
    expect(zoomNarrowFov(1)).toBe(FP_FOV_MIN);
    expect(zoomSceneFov(1, 1)).toBe(FP_FOV_MIN);
    expect(zoomSceneFov(60, -3)).toBe(60);
    expect(zoomSceneFov(60, 9)).toBeCloseTo(24, 9);
    expect(zoomSceneFov(60, NaN)).toBe(60);
  });

  it('zoom: Aladin widens from the narrow field to the real one, ending exactly on it', () => {
    expect(zoomAladinFov(30, 80, 0)).toBeCloseTo(30, 9);
    expect(zoomAladinFov(30, 80, 1)).toBeCloseTo(80, 9);
    let prev = 0;
    for (let i = 0; i <= 10; i++) {
      const f = zoomAladinFov(30, 80, i / 10);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
});
