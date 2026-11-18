import { describe, expect, it } from 'vitest';
import { focusesSearch, handlesEnterItself, type EnterKeyLike, type TargetLike } from '../src/lib/focus-search';

const el = (tagName: string, extra: Partial<TargetLike> & { attrs?: Record<string, string> } = {}): TargetLike => ({
  tagName, isContentEditable: false, parentElement: null, ...extra,
  getAttribute: (n) => extra.attrs?.[n] ?? null,
});
const key = (target: unknown, over: Partial<EnterKeyLike> = {}): EnterKeyLike => ({
  key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target, ...over,
});

describe('Enter focuses the search field', () => {
  it('fires on Enter with focus on the page itself', () => {
    expect(focusesSearch(key(el('BODY')), false)).toBe(true);
    expect(focusesSearch(key(el('DIV')), false)).toBe(true);
    expect(focusesSearch(key(null), false)).toBe(true);
  });
  it('stays out of inputs, textareas, selects, buttons, links and editable text', () => {
    for (const t of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY']) expect(focusesSearch(key(el(t)), false)).toBe(false);
    expect(focusesSearch(key(el('DIV', { isContentEditable: true })), false)).toBe(false);
  });
  it('stays out of what is inside a button or link, and of role and tabindex controls (rows, splitters)', () => {
    const btn = el('BUTTON');
    expect(focusesSearch(key(el('SPAN', { parentElement: btn })), false)).toBe(false);
    expect(focusesSearch(key(el('DIV', { attrs: { role: 'separator' } })), false)).toBe(false);
    expect(focusesSearch(key(el('DIV', { attrs: { tabindex: '0' } })), false)).toBe(false);
  });
  it('ignores a modified Enter, a repeat, an IME confirm and a key something already handled', () => {
    const t = el('BODY');
    for (const m of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey'] as const) expect(focusesSearch(key(t, { [m]: true }), false)).toBe(false);
    expect(focusesSearch(key(t, { repeat: true }), false)).toBe(false);
    expect(focusesSearch(key(t, { isComposing: true }), false)).toBe(false);
    expect(focusesSearch(key(t, { defaultPrevented: true }), false)).toBe(false);
  });
  it('ignores other keys', () => {
    expect(focusesSearch(key(el('BODY'), { key: 'f' }), false)).toBe(false);
  });
  it('does nothing while the Sky view covers the scene', () => {
    expect(focusesSearch(key(el('BODY')), true)).toBe(false);
  });
  it('handlesEnterItself is false for a plain tree of divs', () => {
    expect(handlesEnterItself(el('DIV', { parentElement: el('MAIN') }))).toBe(false);
  });
});
