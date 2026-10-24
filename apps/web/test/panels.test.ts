import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANELS, PANELS_STORAGE_KEY, loadPanels, parsePanels, savePanels, serialisePanels, usePanels, type StorageLike,
} from '../src/state/panels';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
  };
}

const broken: StorageLike = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
};

describe('panel visibility defaults', () => {
  it('hides the DSN panel and shows the rest', () => {
    expect(DEFAULT_PANELS).toEqual({ dsn: false, board: true, ticker: true });
  });

  it('falls back to the defaults for empty, malformed or non-object input', () => {
    for (const raw of [null, undefined, '', 'nope', '{', '[]', 'null', '7', '"dsn"']) expect(parsePanels(raw)).toEqual(DEFAULT_PANELS);
  });
});

describe('parse and serialise', () => {
  it('round-trips every combination', () => {
    for (let n = 0; n < 8; n++) {
      const state = { dsn: !!(n & 1), board: !!(n & 2), ticker: !!(n & 4) };
      expect(parsePanels(serialisePanels(state))).toEqual(state);
    }
  });

  it('takes valid booleans, keeps the default for the rest and drops unknown keys', () => {
    expect(parsePanels('{"dsn":true,"board":"no","ticker":0,"extra":true}')).toEqual({ dsn: true, board: true, ticker: true });
    expect(parsePanels('{"board":false}')).toEqual({ dsn: false, board: false, ticker: true });
    expect(Object.keys(parsePanels('{"extra":1}'))).toEqual(['dsn', 'board', 'ticker']);
  });

  it('serialises only the known keys', () => {
    expect(JSON.parse(serialisePanels({ dsn: true, board: false, ticker: true, extra: 1 } as never))).toEqual({ dsn: true, board: false, ticker: true });
  });
});

describe('storage access', () => {
  it('saves under the documented key and loads it back', () => {
    const s = memoryStorage();
    expect(savePanels({ dsn: true, board: true, ticker: false }, s)).toBe(true);
    expect(Object.keys(s.data)).toEqual([PANELS_STORAGE_KEY]);
    expect(loadPanels(s)).toEqual({ dsn: true, board: true, ticker: false });
  });

  it('never throws when storage is missing or denies access', () => {
    expect(loadPanels(null)).toEqual(DEFAULT_PANELS);
    expect(loadPanels(broken)).toEqual(DEFAULT_PANELS);
    expect(savePanels(DEFAULT_PANELS, null)).toBe(false);
    expect(savePanels(DEFAULT_PANELS, broken)).toBe(false);
  });

  it('returns a fresh object, so callers cannot change the defaults', () => {
    const a = loadPanels(null);
    a.dsn = true;
    expect(DEFAULT_PANELS.dsn).toBe(false);
  });
});

describe('usePanels store', () => {
  it('toggles and sets a panel (storage is absent in node, so only memory changes)', () => {
    const { setPanel, togglePanel } = usePanels.getState();
    expect(usePanels.getState().visible.dsn).toBe(false);
    togglePanel('dsn');
    expect(usePanels.getState().visible.dsn).toBe(true);
    setPanel('dsn', true);
    expect(usePanels.getState().visible.dsn).toBe(true);
    setPanel('dsn', false);
    expect(usePanels.getState().visible).toEqual(DEFAULT_PANELS);
  });
});
