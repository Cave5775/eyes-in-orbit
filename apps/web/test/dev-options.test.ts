import { describe, expect, it } from 'vitest';
import {
  DEV_OPTIONS_KEY, atDevDefaults, clampNumber, commitDraft, defaultValues, loadDevValues, parseValue, saveDevValues, type DevOptionDef, type DevStorage, type NumberOption,
} from '../src/lib/dev-options';
import { createDevOptionsStore } from '../src/state/dev-options';

const num: NumberOption = { id: 'n', label: 'N', type: 'number', min: 0.1, max: 2, step: 0.1, default: 0.5 };
const defs: DevOptionDef[] = [num, { id: 't', label: 'T', type: 'toggle', default: true }];
const mem = (init: Record<string, string> = {}): DevStorage & { data: Record<string, string> } => {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
};
const broken: DevStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

describe('clampNumber', () => {
  it('limits to the range and snaps to the step', () => {
    expect(clampNumber(num, 5)).toBe(2);
    expect(clampNumber(num, -1)).toBe(0.1);
    expect(clampNumber(num, 0.34)).toBe(0.3);
    expect(clampNumber(num, 0.1 + 0.2)).toBe(0.3);
  });
  it('gives the default for non-finite input', () => {
    expect(clampNumber(num, NaN)).toBe(0.5);
    expect(clampNumber(num, Infinity)).toBe(0.5);
  });
});

describe('parseValue', () => {
  it('reads numbers from text and numbers, toggles only from booleans', () => {
    expect(parseValue(num, '1.2')).toBe(1.2);
    expect(parseValue(num, 0.7)).toBe(0.7);
    expect(parseValue(num, '')).toBe(0.5);
    expect(parseValue(num, 'abc')).toBe(0.5);
    expect(parseValue(defs[1], false)).toBe(false);
    expect(parseValue(defs[1], 'off')).toBe(true);
  });
});

describe('persistence', () => {
  it('starts from the defaults and round-trips changed values', () => {
    expect(loadDevValues(mem(), defs)).toEqual({ n: 0.5, t: true });
    const s = mem();
    saveDevValues({ n: 1.5, t: false }, s, defs);
    expect(loadDevValues(s, defs)).toEqual({ n: 1.5, t: false });
  });
  it('stores only what differs from the default', () => {
    const s = mem();
    saveDevValues({ n: 0.5, t: false }, s, defs);
    expect(JSON.parse(s.data[DEV_OPTIONS_KEY])).toEqual({ t: false });
  });
  it('drops unknown ids and repairs bad or out-of-range stored values', () => {
    const s = mem({ [DEV_OPTIONS_KEY]: JSON.stringify({ n: 99, t: 'yes', gone: 1 }) });
    expect(loadDevValues(s, defs)).toEqual({ n: 2, t: true });
  });
  it('survives garbage, blocked and missing storage', () => {
    expect(loadDevValues(mem({ [DEV_OPTIONS_KEY]: '{not json' }), defs)).toEqual(defaultValues(defs));
    expect(loadDevValues(mem({ [DEV_OPTIONS_KEY]: '[1]' }), defs)).toEqual(defaultValues(defs));
    expect(loadDevValues(broken, defs)).toEqual(defaultValues(defs));
    expect(loadDevValues(null, defs)).toEqual(defaultValues(defs));
    expect(() => saveDevValues({ n: 1 }, broken, defs)).not.toThrow();
  });
  it('atDevDefaults tells a changed set from the defaults', () => {
    expect(atDevDefaults(defaultValues(defs), defs)).toBe(true);
    expect(atDevDefaults({ n: 1, t: true }, defs)).toBe(false);
  });
});

describe('developer options store', () => {
  it('sets with clamping, remembers, and resets to the defaults', () => {
    const s = mem();
    const store = createDevOptionsStore(s, defs);
    store.getState().set('n', '9');
    store.getState().set('t', false);
    store.getState().set('missing', 1);
    expect(store.getState().values).toEqual({ n: 2, t: false });
    expect(createDevOptionsStore(s, defs).getState().values).toEqual({ n: 2, t: false });
    store.getState().reset();
    expect(store.getState().values).toEqual({ n: 0.5, t: true });
    expect(createDevOptionsStore(s, defs).getState().values).toEqual({ n: 0.5, t: true });
  });
});

describe('commitDraft (a number field commits on blur or Enter)', () => {
  it('clamps and snaps the typed text, and keeps the current value for empty or non-numeric text', () => {
    expect(commitDraft(num, '0.3', 0.5)).toBe(0.3);
    expect(commitDraft(num, '0,3', 0.5)).toBe(0.3);
    expect(commitDraft(num, '0', 0.5)).toBe(0.1);
    expect(commitDraft(num, '99', 0.5)).toBe(2);
    expect(commitDraft(num, '', 0.7)).toBe(0.7);
    expect(commitDraft(num, '.', 0.7)).toBe(0.7);
    expect(commitDraft(num, 'abc', 0.7)).toBe(0.7);
  });
});
