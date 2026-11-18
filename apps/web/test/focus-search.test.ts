import { describe, expect, it } from 'vitest';
import { focusesSearch, handlesEnterItself, type EnterKeyLike, type TargetLike } from '../src/lib/focus-search';

const el = (tagName: string, extra: Partial<TargetLike> & { attrs?: Record<string, string> } = {}): TargetLike => ({
  tagName, isContentEditable: false, parentElement: null, ...extra,
  getAttribute: (n) => extra.attrs?.[n] ?? null,
});
const key = (target: unknown, over: Partial<EnterKeyLike> = {}): EnterKeyLike => ({
  key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target, ...over,
});

const free = { skyCovers: false };

describe('Enter focuses the search field', () => {
  it('fires on Enter with focus on the page itself', () => {
    expect(focusesSearch(key(el('BODY')), free)).toBe(true);
    expect(focusesSearch(key(el('DIV')), free)).toBe(true);
    expect(focusesSearch(key(null), free)).toBe(true);
  });
  it('stays out of inputs, textareas, selects, buttons, links and editable text', () => {
    for (const t of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY']) expect(focusesSearch(key(el(t)), free)).toBe(false);
    expect(focusesSearch(key(el('DIV', { isContentEditable: true })), free)).toBe(false);
  });
  it('stays out of what is inside a button or link, and of role and tabindex controls (rows, splitters)', () => {
    const btn = el('BUTTON');
    expect(focusesSearch(key(el('SPAN', { parentElement: btn })), free)).toBe(false);
    expect(focusesSearch(key(el('DIV', { attrs: { role: 'separator' } })), free)).toBe(false);
    expect(focusesSearch(key(el('DIV', { attrs: { tabindex: '0' } })), free)).toBe(false);
  });
  it('ignores a modified Enter, a repeat, an IME confirm and a key something already handled', () => {
    const t = el('BODY');
    for (const m of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey'] as const) expect(focusesSearch(key(t, { [m]: true }), free)).toBe(false);
    expect(focusesSearch(key(t, { repeat: true }), free)).toBe(false);
    expect(focusesSearch(key(t, { isComposing: true }), free)).toBe(false);
    expect(focusesSearch(key(t, { defaultPrevented: true }), free)).toBe(false);
  });
  it('ignores other keys', () => {
    expect(focusesSearch(key(el('BODY'), { key: 'f' }), free)).toBe(false);
  });
  it('does nothing while the Sky view covers the scene', () => {
    expect(focusesSearch(key(el('BODY')), { skyCovers: true })).toBe(false);
  });
  it('does nothing when the panel is hidden or a popover, menu or dialog is open', () => {
    expect(focusesSearch(key(el('BODY')), { skyCovers: false, panelHidden: true })).toBe(false);
    expect(focusesSearch(key(el('BODY')), { skyCovers: false, popoverOpen: true })).toBe(false);
    expect(focusesSearch(key(el('BODY')), { skyCovers: false, panelHidden: false, popoverOpen: false })).toBe(true);
  });
  it('handlesEnterItself is false for a plain tree of divs', () => {
    expect(handlesEnterItself(el('DIV', { parentElement: el('MAIN') }))).toBe(false);
  });
});
