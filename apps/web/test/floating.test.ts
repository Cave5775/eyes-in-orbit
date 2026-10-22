import { describe, expect, it } from 'vitest';
import {
  FLOAT_HEAD_PX, MAX_FLOATS, MIN_FLOAT_W, closeFloatWindow, defaultRect, dragRect, fitRect, focusFloatWindow, frameHeight,
  isFloatableUrl, loadFloats, openFloatWindow, parseFloats, resizeRect, saveFloats, setFloatRect, totalHeight, type FloatWindow,
  type StorageLike,
} from '../src/lib/floating';

const VP = { w: 1600, h: 900 };
const A = 'https://www.youtube.com/embed/aaaaaaaaaaa?autoplay=1';
const B = 'https://www.youtube.com/embed/bbbbbbbbbbb?autoplay=1';
const C = 'https://www.youtube.com/embed/ccccccccccc?autoplay=1';
const D = 'https://www.youtube.com/embed/ddddddddddd?autoplay=1';

/** Full containment in the viewport. */
function inside(r: { x: number; y: number; w: number; h: number }, vp = VP): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= vp.w && r.y + r.h <= vp.h;
}

function win(url: string, z: number, extra: Partial<FloatWindow> = {}): FloatWindow {
  return { url, title: 'T', x: 10, y: 10, w: 320, h: totalHeight(320), z, ...extra };
}

/** In-memory storage that can be made to throw. */
function memoryStorage(opts: { throwOn?: 'get' | 'set' | 'remove' } = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem(k) {
      if (opts.throwOn === 'get') throw new Error('denied');
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      if (opts.throwOn === 'set') throw new Error('quota');
      data.set(k, v);
    },
    removeItem(k) {
      if (opts.throwOn === 'remove') throw new Error('denied');
      data.delete(k);
    },
  };
}

describe('floating geometry', () => {
  it('keeps a 16:9 frame under a title bar', () => {
    expect(frameHeight(320)).toBe(180);
    expect(totalHeight(320)).toBe(180 + FLOAT_HEAD_PX);
    expect(frameHeight(480)).toBe(270);
  });

  it('fits a window to the viewport: clamps negative and overflowing positions', () => {
    expect(fitRect({ x: -50, y: -20, w: 400 }, VP)).toMatchObject({ x: 0, y: 0, w: 400 });
    const far = fitRect({ x: 5000, y: 5000, w: 400 }, VP);
    expect(far.x).toBe(VP.w - 400);
    expect(far.y).toBe(VP.h - far.h);
    expect(inside(far)).toBe(true);
  });

  it('never narrower than the minimum and never wider than the viewport allows', () => {
    expect(fitRect({ x: 0, y: 0, w: 50 }, VP).w).toBe(MIN_FLOAT_W);
    const huge = fitRect({ x: 0, y: 0, w: 5000 }, VP);
    expect(inside(huge)).toBe(true);
    // limited by height: 900 - 28 = 872 px of frame, so at most 872 * 16 / 9 wide
    expect(huge.w).toBe(Math.floor((VP.h - FLOAT_HEAD_PX) * 16 / 9));
    expect(huge.h).toBe(VP.h);
  });

  it('keeps 16:9 whatever width is asked for', () => {
    for (const w of [240, 301, 417, 640, 999]) {
      const r = fitRect({ x: 0, y: 0, w }, VP);
      expect(r.h - FLOAT_HEAD_PX).toBe(frameHeight(r.w));
      expect(Math.abs((r.w * 9) / 16 - (r.h - FLOAT_HEAD_PX))).toBeLessThanOrEqual(0.5);
    }
  });

  it('the minimum wins in a viewport too small to hold it', () => {
    const r = fitRect({ x: 0, y: 0, w: 400 }, { w: 200, h: 120 });
    expect(r.w).toBe(MIN_FLOAT_W);
  });

  it('drags by the pointer delta from the start position and stays in the viewport', () => {
    const start = { x: 100, y: 100, w: 320 };
    expect(dragRect(start, 40, -30, VP)).toMatchObject({ x: 140, y: 70, w: 320 });
    expect(inside(dragRect(start, -5000, -5000, VP))).toBe(true);
    expect(dragRect(start, -5000, -5000, VP)).toMatchObject({ x: 0, y: 0 });
    const far = dragRect(start, 9000, 9000, VP);
    expect(far.x + far.w).toBe(VP.w);
    expect(far.y + far.h).toBe(VP.h);
  });

  it('resizes from the corner keeping 16:9 and the minimum width', () => {
    const start = { x: 100, y: 100, w: 320 };
    expect(resizeRect(start, 0, 0, VP).w).toBe(320);
    expect(resizeRect(start, 80, 0, VP).w).toBe(400);
    // a pure vertical drag of 45 px is the same width change as 80 px horizontally (45 * 16 / 9 = 80)
    expect(resizeRect(start, 0, 45, VP).w).toBe(400);
    expect(resizeRect(start, -500, -500, VP).w).toBe(MIN_FLOAT_W);
    expect(resizeRect(start, -500, -500, VP).h).toBe(totalHeight(MIN_FLOAT_W));
  });

  it('resize grows only until the window meets the viewport edge', () => {
    const r = resizeRect({ x: 1400, y: 700, w: 320 }, 5000, 5000, VP);
    expect(inside(r)).toBe(true);
    expect(r.x + r.w).toBeLessThanOrEqual(VP.w);
    expect(r.y + r.h).toBeLessThanOrEqual(VP.h);
  });

  it('a new window is about a third of the viewport, cascades, and stays inside', () => {
    const first = defaultRect(VP, 0);
    const second = defaultRect(VP, 1);
    expect(first.w).toBe(480);
    expect(second.x).toBeLessThan(first.x);
    expect(second.y).toBeGreaterThan(first.y);
    expect(inside(first)).toBe(true);
    expect(inside(defaultRect({ w: 500, h: 300 }, 2))).toBe(true);
    expect(defaultRect({ w: 800, h: 500 }, 0).w).toBe(256);
  });
});

describe('floating windows: open, focus, close, cap', () => {
  it('opens windows on top, one per stream', () => {
    let list: FloatWindow[] = [];
    list = openFloatWindow(list, A, 'Alpha', VP);
    list = openFloatWindow(list, B, 'Beta', VP);
    expect(list.map((f) => f.url)).toEqual([A, B]);
    expect(list[1].z).toBeGreaterThan(list[0].z);
    expect(list[0].title).toBe('Alpha');
    expect(inside(list[1])).toBe(true);
  });

  it('opening an already open stream focuses it and does not add a second window', () => {
    let list = openFloatWindow([], A, 'Alpha', VP);
    list = openFloatWindow(list, B, 'Beta', VP);
    list = openFloatWindow(list, A, 'Alpha', VP);
    expect(list.map((f) => f.url)).toEqual([A, B]);
    expect(list[0].z).toBeGreaterThan(list[1].z);
  });

  it(`caps at ${MAX_FLOATS} windows`, () => {
    let list: FloatWindow[] = [];
    for (const u of [A, B, C]) list = openFloatWindow(list, u, 'x', VP);
    expect(list).toHaveLength(MAX_FLOATS);
    const capped = openFloatWindow(list, D, 'x', VP);
    expect(capped).toBe(list);
    // an open one can still be focused at the cap
    expect(openFloatWindow(list, A, 'x', VP)[0].z).toBeGreaterThan(list[0].z);
  });

  it('refuses URLs that are not YouTube embeds', () => {
    expect(isFloatableUrl(A)).toBe(true);
    expect(isFloatableUrl('https://www.nasa.gov/nasalive')).toBe(false);
    expect(isFloatableUrl('https://www.youtube.com/embed/')).toBe(false);
    expect(openFloatWindow([], 'https://evil.example/embed/x', 'x', VP)).toEqual([]);
  });

  it('focus brings a window to the front and is a no-op when it is already there', () => {
    const list = [win(A, 1), win(B, 2), win(C, 3)];
    expect(focusFloatWindow(list, C)).toBe(list);
    const next = focusFloatWindow(list, A);
    expect(next.find((f) => f.url === A)!.z).toBe(4);
    expect(next.find((f) => f.url === B)!.z).toBe(2);
    expect(focusFloatWindow(list, D)).toBe(list);
  });

  it('close and dock remove the window and nothing else', () => {
    const list = [win(A, 1), win(B, 2)];
    expect(closeFloatWindow(list, A).map((f) => f.url)).toEqual([B]);
    expect(closeFloatWindow(list, D)).toBe(list);
  });

  it('a stored rect is clamped to the viewport and keeps title and stacking order', () => {
    const list = [win(A, 7, { title: 'Keep me' })];
    const moved = setFloatRect(list, A, { x: 9000, y: -9000, w: 320 }, VP);
    expect(moved[0]).toMatchObject({ title: 'Keep me', z: 7, w: 320, y: 0 });
    expect(inside(moved[0])).toBe(true);
    expect(moved[0].h).toBe(totalHeight(320));
  });
});

describe('floating windows: persistence', () => {
  it('round-trips through storage and restores the order and size', () => {
    const storage = memoryStorage();
    const list = [win(A, 5, { x: 30, y: 40, w: 400, title: 'Alpha' }), win(B, 9, { x: 60, y: 70, w: 300, title: 'Beta' })];
    expect(saveFloats(list, storage)).toBe(true);
    const back = loadFloats(storage);
    expect(back.map((f) => f.url)).toEqual([A, B]);
    expect(back[0]).toMatchObject({ x: 30, y: 40, w: 400, title: 'Alpha', h: totalHeight(400) });
    expect(back.map((f) => f.z)).toEqual([1, 2]);
  });

  it('an empty list removes the stored entry', () => {
    const storage = memoryStorage();
    saveFloats([win(A, 1)], storage);
    saveFloats([], storage);
    expect(storage.data.size).toBe(0);
  });

  it('drops malformed rows, non-YouTube URLs, duplicates and tiny widths; caps the count', () => {
    const raw = JSON.stringify([
      { url: A, title: 'a', x: 1, y: 2, w: 320 },
      { url: A, title: 'dupe', x: 1, y: 2, w: 320 },
      { url: 'https://evil.example/embed/x', title: 'bad', x: 1, y: 2, w: 320 },
      { url: B, title: 'tiny', x: 1, y: 2, w: 100 },
      { url: C, title: 'nan', x: 'oops', y: 2, w: 320 },
      null,
      'str',
      { url: D, title: 'd', x: 1, y: 2, w: 320 },
      { url: `https://www.youtube.com/embed/eeeeeeeeeee`, title: 'e', x: 1, y: 2, w: 320 },
      { url: `https://www.youtube.com/embed/fffffffffff`, title: 'f', x: 1, y: 2, w: 320 },
    ]);
    const out = parseFloats(raw);
    expect(out.map((f) => f.url)).toEqual([A, D, 'https://www.youtube.com/embed/eeeeeeeeeee']);
    expect(out.every((f) => f.z >= 1)).toBe(true);
  });

  it('bad JSON and non-array payloads give an empty list', () => {
    expect(parseFloats('{not json')).toEqual([]);
    expect(parseFloats('{"a":1}')).toEqual([]);
    expect(parseFloats(null)).toEqual([]);
    expect(parseFloats('')).toEqual([]);
  });

  it('storage that throws is tolerated on read and write', () => {
    expect(loadFloats(memoryStorage({ throwOn: 'get' }))).toEqual([]);
    expect(saveFloats([win(A, 1)], memoryStorage({ throwOn: 'set' }))).toBe(false);
    expect(saveFloats([], memoryStorage({ throwOn: 'remove' }))).toBe(false);
    expect(loadFloats(null)).toEqual([]);
    expect(saveFloats([win(A, 1)], null)).toBe(false);
  });
});
