import { describe, expect, it } from 'vitest';
import {
  CHROME_H, MIN_BOARD_W, MIN_SCENE_H, MIN_SCENE_W, PANELS, STORAGE_KEY, clampSize, defaultSize, dragSize, keyboardStep, loadSizes, maxSize,
  parseSizes, resolveSizes, saveSizes, type StorageLike,
} from '../src/lib/layout';

const WIDE = { w: 1440, h: 900 };
const SMALL = { w: 1024, h: 700 };

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
  };
}

describe('defaults and clamping', () => {
  it('uses the narrow defaults at and below 1100 px', () => {
    expect(defaultSize('left', 1440)).toBe(292);
    expect(defaultSize('left', 1100)).toBe(240);
    expect(defaultSize('right', 1024)).toBe(320);
  });

  it('clamps to the per-panel min and max', () => {
    const sizes = resolveSizes({}, WIDE);
    expect(clampSize('left', 10, sizes, WIDE)).toBe(PANELS.left.min);
    expect(clampSize('left', 99999, sizes, WIDE)).toBeLessThanOrEqual(PANELS.left.max);
    expect(clampSize('bottom', 20, sizes, WIDE)).toBe(PANELS.bottom.min);
  });

  it('keeps room for the globe', () => {
    const sizes = resolveSizes({}, SMALL);
    const left = clampSize('left', 5000, sizes, SMALL);
    expect(left + sizes.right + MIN_SCENE_W).toBeLessThanOrEqual(SMALL.w);
    const bottom = clampSize('bottom', 5000, sizes, SMALL);
    expect(SMALL.h - CHROME_H - bottom).toBeGreaterThanOrEqual(MIN_SCENE_H);
  });

  it('falls back to the default for non-finite input and rounds', () => {
    const sizes = resolveSizes({}, WIDE);
    expect(clampSize('right', NaN, sizes, WIDE)).toBe(372);
    expect(clampSize('right', 300.6, sizes, WIDE)).toBe(301);
  });

  it('never returns a cap below the minimum on tiny viewports', () => {
    const tiny = { w: 500, h: 300 };
    const sizes = resolveSizes({}, tiny);
    for (const k of ['left', 'right', 'bottom'] as const) {
      expect(maxSize(k, sizes, tiny)).toBeGreaterThanOrEqual(PANELS[k].min);
    }
  });

  it('the observatory panel width keeps room for the launch board and persists like the others', () => {
    const sizes = resolveSizes({}, WIDE);
    expect(sizes.obs).toBe(PANELS.obs.def);
    expect(resolveSizes({}, SMALL).obs).toBe(PANELS.obs.defNarrow);
    expect(clampSize('obs', 99999, sizes, SMALL)).toBeLessThanOrEqual(SMALL.w - MIN_BOARD_W);
    expect(clampSize('obs', 10, sizes, WIDE)).toBe(PANELS.obs.min);
    expect(parseSizes('{"obs":500}')).toEqual({ obs: 500 });
    expect(parseSizes('{"obs":50}')).toEqual({});
  });

  it('resolveSizes re-clamps stored values for a smaller window', () => {
    const stored = { left: 600, right: 700 };
    const sizes = resolveSizes(stored, SMALL);
    expect(sizes.left + sizes.right + MIN_SCENE_W).toBeLessThanOrEqual(SMALL.w);
    expect(sizes.left).toBeGreaterThanOrEqual(PANELS.left.min);
    expect(sizes.right).toBeGreaterThanOrEqual(PANELS.right.min);
  });
});

describe('dragging and keyboard', () => {
  it('moves with the pointer in the growing direction', () => {
    expect(dragSize(300, 40, 1)).toBe(340);
    expect(dragSize(300, 40, -1)).toBe(260);
    expect(dragSize(176, -30, -1)).toBe(206);
  });
  it('shift takes the big step', () => {
    expect(keyboardStep(false)).toBeLessThan(keyboardStep(true));
  });
});

describe('persistence', () => {
  it('round-trips through storage', () => {
    const st = memoryStorage();
    expect(saveSizes({ left: 320, bottom: 200 }, st)).toBe(true);
    expect(loadSizes(st)).toEqual({ left: 320, bottom: 200 });
  });

  it('removes the key when nothing is overridden', () => {
    const st = memoryStorage();
    saveSizes({ left: 320 }, st);
    saveSizes({}, st);
    expect(STORAGE_KEY in st.data).toBe(false);
  });

  it('ignores corrupt, foreign and out-of-range data', () => {
    expect(parseSizes(null)).toEqual({});
    expect(parseSizes('not json')).toEqual({});
    expect(parseSizes('[1,2]')).toEqual({});
    expect(parseSizes('{"left":"wide","right":5,"bottom":200,"extra":1,"dsn":300}')).toEqual({ bottom: 200 });
    expect(parseSizes(`{"left":${PANELS.left.max + 1}}`)).toEqual({});
  });

  it('survives storage that throws or is missing', () => {
    const boom: StorageLike = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
    };
    expect(loadSizes(boom)).toEqual({});
    expect(saveSizes({ left: 300 }, boom)).toBe(false);
    expect(loadSizes(null)).toEqual({});
    expect(saveSizes({ left: 300 }, null)).toBe(false);
  });
});
