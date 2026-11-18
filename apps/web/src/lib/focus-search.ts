/**
 * The Enter hotkey: it moves focus to the search field and selects its text. It is only for an Enter nothing else wants, so it
 * stays out of the way of every control that uses Enter itself (a text field, a row or button, a link, a splitter), of any
 * modified Enter, and of the Sky view, which covers the scene (the scene hotkeys F, S and H are gated the same way).
 */

/** The part of a DOM element the check reads (so it can be tested without a DOM). */
export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  parentElement?: TargetLike | null;
  getAttribute?: (name: string) => string | null;
}

export interface EnterKeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target: unknown;
}

const OWN_ENTER_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY']);
const OWN_ENTER_ROLES = new Set(['button', 'link', 'separator', 'textbox', 'combobox', 'option', 'menuitem', 'tab', 'checkbox', 'switch', 'slider']);

/** The element, or one above it, handles Enter itself: a form control, a button, a link, editable text, or anything the page made focusable. */
export function handlesEnterItself(target: unknown): boolean {
  let el = target as TargetLike | null | undefined;
  while (el && typeof el === 'object') {
    if (el.isContentEditable) return true;
    if (el.tagName && OWN_ENTER_TAGS.has(el.tagName.toUpperCase())) return true;
    const role = el.getAttribute?.('role');
    if (role && OWN_ENTER_ROLES.has(role)) return true;
    if (el.getAttribute?.('tabindex') != null) return true;
    el = el.parentElement;
  }
  return false;
}

/** Whether this key press should focus the search field. `skyCovers`: the Sky view is entering or on. */
export function focusesSearch(e: EnterKeyLike, skyCovers: boolean): boolean {
  if (e.key !== 'Enter') return false;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
  if (e.repeat || e.isComposing || e.defaultPrevented) return false;
  if (skyCovers) return false;
  return !handlesEnterItself(e.target);
}
