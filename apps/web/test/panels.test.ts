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
  it('shows every panel', () => {
    expect(DEFAULT_PANELS).toEqual({ board: true, observatories: true, ticker: true, legend: true });
  });

  it('keeps stored state from before the legend existed working (missing key takes its default)', () => {
    expect(parsePanels('{"board":false,"ticker":true}')).toEqual({ board: false, observatories: true, ticker: true, legend: true });
    expect(parsePanels('{"legend":false}')).toEqual({ board: true, observatories: true, ticker: true, legend: false });
    expect(parsePanels('{"observatories":false}').observatories).toBe(false);
  });

  it('drops the dsn key of older stored state (the DSN moved to the Data streams popup)', () => {
    const p = parsePanels('{"dsn":true,"board":false,"ticker":true,"legend":true}');
    expect(p).toEqual({ board: false, observatories: true, ticker: true, legend: true });
    expect('dsn' in p).toBe(false);
    expect(JSON.parse(serialisePanels(p))).toEqual({ board: false, observatories: true, ticker: true, legend: true });
  });

  it('falls back to the defaults for empty, malformed or non-object input', () => {
    for (const raw of [null, undefined, '', 'nope', '{', '[]', 'null', '7', '"dsn"']) expect(parsePanels(raw)).toEqual(DEFAULT_PANELS);
  });
});

describe('parse and serialise', () => {
  it('round-trips every combination', () => {
    for (let n = 0; n < 16; n++) {
      const state = { board: !!(n & 1), ticker: !!(n & 2), legend: !!(n & 4), observatories: !!(n & 8) };
      expect(parsePanels(serialisePanels(state))).toEqual(state);
    }
  });

  it('takes valid booleans, keeps the default for the rest and drops unknown keys', () => {
    expect(parsePanels('{"board":"no","ticker":0,"extra":true}')).toEqual({ board: true, observatories: true, ticker: true, legend: true });
    expect(parsePanels('{"board":false}')).toEqual({ board: false, observatories: true, ticker: true, legend: true });
    expect(Object.keys(parsePanels('{"extra":1}'))).toEqual(['board', 'observatories', 'ticker', 'legend']);
  });

  it('serialises only the known keys', () => {
    expect(JSON.parse(serialisePanels({ board: false, observatories: true, ticker: true, legend: false, extra: 1 } as never))).toEqual({ board: false, observatories: true, ticker: true, legend: false });
  });
});

describe('storage access', () => {
  it('saves under the documented key and loads it back', () => {
    const s = memoryStorage();
    expect(savePanels({ board: true, observatories: false, ticker: false, legend: false }, s)).toBe(true);
    expect(Object.keys(s.data)).toEqual([PANELS_STORAGE_KEY]);
    expect(loadPanels(s)).toEqual({ board: true, observatories: false, ticker: false, legend: false });
  });

  it('never throws when storage is missing or denies access', () => {
    expect(loadPanels(null)).toEqual(DEFAULT_PANELS);
    expect(loadPanels(broken)).toEqual(DEFAULT_PANELS);
    expect(savePanels(DEFAULT_PANELS, null)).toBe(false);
    expect(savePanels(DEFAULT_PANELS, broken)).toBe(false);
  });

  it('returns a fresh object, so callers cannot change the defaults', () => {
    const a = loadPanels(null);
    a.board = false;
    expect(DEFAULT_PANELS.board).toBe(true);
  });
});

describe('usePanels store', () => {
  it('shows and hides the observatory panel like the others', () => {
    const { setPanel } = usePanels.getState();
    setPanel('observatories', false);
    expect(usePanels.getState().visible.observatories).toBe(false);
    setPanel('observatories', true);
    expect(usePanels.getState().visible).toEqual(DEFAULT_PANELS);
  });

  it('toggles and sets a panel (storage is absent in node, so only memory changes)', () => {
    const { setPanel, togglePanel } = usePanels.getState();
    expect(usePanels.getState().visible.ticker).toBe(true);
    togglePanel('ticker');
    expect(usePanels.getState().visible.ticker).toBe(false);
    setPanel('ticker', false);
    expect(usePanels.getState().visible.ticker).toBe(false);
    setPanel('ticker', true);
    expect(usePanels.getState().visible).toEqual(DEFAULT_PANELS);
  });
});
