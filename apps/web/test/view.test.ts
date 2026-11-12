import { describe, expect, it } from 'vitest';
import { DETAIL_KEY, LABELS_KEY, createViewStore, loadFlag, saveFlag, type StorageLike } from '../src/state/view';

const mem = (init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } => {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
};
const broken: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

describe('remembered view flags', () => {
  it('default to on; only the stored text off turns one off', () => {
    expect(loadFlag(LABELS_KEY, mem())).toBe(true);
    expect(loadFlag(LABELS_KEY, mem({ [LABELS_KEY]: 'off' }))).toBe(false);
    expect(loadFlag(LABELS_KEY, mem({ [LABELS_KEY]: 'on' }))).toBe(true);
    expect(loadFlag(LABELS_KEY, mem({ [LABELS_KEY]: 'garbage' }))).toBe(true);
  });
  it('survive blocked or missing storage', () => {
    expect(loadFlag(DETAIL_KEY, broken)).toBe(true);
    expect(loadFlag(DETAIL_KEY, null)).toBe(true);
    expect(() => saveFlag(DETAIL_KEY, false, broken)).not.toThrow();
  });
});

describe('view store', () => {
  it('starts from the remembered labels and detail, scope auto, help closed', () => {
    const s = createViewStore(mem({ [DETAIL_KEY]: 'off' })).getState();
    expect(s).toMatchObject({ labels: true, detail: false, scopeAll: false, help: false, surface: false });
  });
  it('remembers labels and detail in the keys the scene used before', () => {
    const storage = mem();
    const store = createViewStore(storage);
    store.getState().toggleLabels();
    store.getState().toggleDetail();
    expect(storage.data).toEqual({ [LABELS_KEY]: 'off', [DETAIL_KEY]: 'off' });
    store.getState().toggleLabels();
    expect(storage.data[LABELS_KEY]).toBe('on');
    expect(store.getState().labels).toBe(true);
  });
  it('does not remember scope, and toggles help', () => {
    const storage = mem();
    const store = createViewStore(storage);
    store.getState().toggleScope();
    store.getState().toggleHelp();
    expect(store.getState()).toMatchObject({ scopeAll: true, help: true });
    expect(Object.keys(storage.data)).toEqual([]);
  });
});
