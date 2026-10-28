import { BODY_CATEGORY_KINDS, CATEGORIES, CATEGORY_ALIASES, normaliseType } from './browser-ui';
import { TAG_KEYS, matchesTag, normaliseValue, parseToken, tagToken, type TagKey, type TagTarget } from './search-tags';

/**
 * THE query: the one thing the search field, the entity list, the tree counts, the scene, the labels, FIT VISIBLE and the 3D
 * model layer agree on (pure). A query is a list of terms; a term is a tag (`group:starlink`, `-type:debris`) or the typed
 * text, and carries an effect:
 *
 *   only  the objects must match (AND across keys, OR within a key, a negated value must not match; the text is a key too)
 *   hide  the objects that match are not drawn nor listed (hide terms OR together)
 *
 * `classify` is the single predicate. The entities in `ctx.focus` (the selection, what is related to it) are never hidden or
 * filtered out, and the celestial bodies can never be hidden (only filtered).
 */

export type Effect = 'only' | 'hide';
export type TermKey = TagKey | 'text';

export interface Term {
  key: TermKey;
  /** normalised tag value (see `normaliseValue`), or the typed text for the `text` key */
  value: string;
  /** a negated tag (`-type:debris`); never set on the text */
  neg?: boolean;
  effect: Effect;
}

export interface Query {
  terms: Term[];
}

export const NO_QUERY: Query = { terms: [] };

/**
 * - `off`   no `only`/text term restricts anything and the entity is not hidden: drawn as usual
 * - `show`  drawn, and an `only`/text term lets it through (or it is in the focus while one is active)
 * - `out`   an `only`/text term leaves it out (hidden, or dimmed while HIGHLIGHT is on)
 * - `hide`  a hide term hides it (always hidden)
 */
export type Class = 'off' | 'show' | 'out' | 'hide';

export interface Ctx {
  /** never hidden nor filtered out: the selection and the objects related to it */
  focus: ReadonlySet<string>;
  /** the ids the typed text matches (computed once per text); null/undefined: the text term restricts nothing yet */
  text?: ReadonlySet<string> | null;
}

export const NO_FOCUS: ReadonlySet<string> = new Set();
export const NO_CTX: Ctx = { focus: NO_FOCUS };

/** What `classify` looks at (an entity record, or a search hit with the extra fields looked up). */
export type QueryTarget = TagTarget;

// ---------------------------------------------------------------- the predicate

interface Compiled {
  hide: Term[];
  /** `only` terms by key (tag keys and text): positive values (OR) and negated values */
  inc: [TermKey, Term[]][];
  exc: [TermKey, Term[]][];
  /** some `only` / text term exists */
  active: boolean;
}

const compiled = new WeakMap<Query, Compiled>();

function compile(q: Query): Compiled {
  let c = compiled.get(q);
  if (c) return c;
  const hide: Term[] = [];
  const inc = new Map<TermKey, Term[]>();
  const exc = new Map<TermKey, Term[]>();
  let active = false;
  for (const t of q.terms) {
    if (t.effect === 'hide') hide.push(t);
    else {
      active = true;
      const m = t.neg ? exc : inc;
      const l = m.get(t.key);
      if (l) l.push(t);
      else m.set(t.key, [t]);
    }
  }
  c = { hide, inc: [...inc], exc: [...exc], active };
  compiled.set(q, c);
  return c;
}

/** Does the entity match the term itself (before the term's negation)? The text looks the id up in `ctx.text`. */
function hits(rec: QueryTarget, t: Term, ctx: Ctx): boolean {
  if (t.key === 'text') return !!rec.id && !!ctx.text?.has(rec.id);
  return matchesTag(rec, t.key, t.value);
}

/** Does the term, negation included, hold for the entity? */
const holds = (rec: QueryTarget, t: Term, ctx: Ctx): boolean => hits(rec, t, ctx) !== !!t.neg;

/** True when an `only` or text term exists: the query restricts what is shown (labels, the keep arrays and HIGHLIGHT use it). */
export const queryActive = (q: Query): boolean => compile(q).active;
export const hasHide = (q: Query): boolean => compile(q).hide.length > 0;

/** The one visibility predicate (see `Class`). */
export function classify(rec: QueryTarget, q: Query, ctx: Ctx = NO_CTX): Class {
  const c = compile(q);
  const free = !!rec.id && ctx.focus.has(rec.id);
  if (!free && c.hide.length && !BODY_CATEGORY_KINDS.has(rec.kind)) {
    for (const t of c.hide) if (holds(rec, t, ctx)) return 'hide';
  }
  if (!c.active) return 'off';
  if (free) return 'show';
  for (const [key, terms] of c.inc) {
    if (key === 'text' && !ctx.text) continue; // the text has not been looked up (yet): it restricts nothing
    if (!terms.some((t) => hits(rec, t, ctx))) return 'out';
  }
  for (const [, terms] of c.exc) if (terms.some((t) => hits(rec, t, ctx))) return 'out';
  return 'show';
}

/** Is it drawn (or listed) at all? Dimming under HIGHLIGHT is up to the scene. */
export const isDrawn = (c: Class): boolean => c === 'off' || c === 'show';

/** Entities that pass, in order. */
export function filterRecords<T extends QueryTarget>(records: Iterable<T>, q: Query, ctx: Ctx = NO_CTX): T[] {
  const out: T[] = [];
  for (const r of records) if (isDrawn(classify(r, q, ctx))) out.push(r);
  return out;
}

// ---------------------------------------------------------------- terms

export const termIs = (t: Term, key: TermKey, value: string, neg = false): boolean => t.key === key && t.value === value && !!t.neg === neg;
export const findTerm = (q: Query, key: TermKey, value: string, neg = false): Term | undefined => q.terms.find((t) => termIs(t, key, value, neg));
export const tagTerms = (q: Query): Term[] => q.terms.filter((t) => t.key !== 'text');
export const hideTerms = (q: Query): Term[] => q.terms.filter((t) => t.effect === 'hide');
/** The typed text of a query ('' when none). */
export const textOf = (q: Query): string => q.terms.find((t) => t.key === 'text')?.value ?? '';

/** The word of a term as typed: `group:starlink`, `-type:debris`; the text as it is. */
export const termWord = (t: Term): string => (t.key === 'text' ? t.value : tagToken(t.key, t.value, !!t.neg));

/** A term from a tag word (`#starlink`, `-type:debris`); null when it is not one. */
export function termFromWord(word: string, effect: Effect = 'only'): Term | null {
  const t = parseToken(word);
  if (!t) return null;
  return t.negated ? { key: t.key, value: t.value, neg: true, effect } : { key: t.key, value: t.value, effect };
}

/** Same terms in the same order (a store update with an equal query is no change). */
export function sameQuery(a: Query, b: Query): boolean {
  return a === b || (a.terms.length === b.terms.length && a.terms.every((t, i) => termIs(t, b.terms[i].key, b.terms[i].value, !!b.terms[i].neg) && t.effect === b.terms[i].effect));
}

const keep = (q: Query, terms: Term[]): Query => (terms.length === q.terms.length ? q : { terms });

/** The text term goes last, so the chips keep their order. */
export function withText(q: Query, text: string): Query {
  const t = text.trim();
  if (textOf(q) === t) return q;
  const terms = q.terms.filter((x) => x.key !== 'text');
  if (t) terms.push({ key: 'text', value: t, effect: 'only' });
  return { terms };
}

/**
 * Add tag terms. One that is in the query already (same key, value and sign) is left alone, or with `override` takes the new
 * effect (typing `type:debris` for a hidden category makes it an only term).
 */
export function addTerms(q: Query, add: readonly Term[], override = false): Query {
  let terms = [...q.terms];
  for (const t of add) {
    if (t.key === 'text') continue;
    const cur = terms.find((x) => termIs(x, t.key, t.value, !!t.neg));
    if (cur) {
      if (override && cur.effect !== t.effect) terms = terms.map((x) => (x === cur ? { ...x, effect: t.effect } : x));
      continue;
    }
    const at = terms.findIndex((x) => x.key === 'text');
    terms.splice(at < 0 ? terms.length : at, 0, t);
  }
  return terms.length === q.terms.length && terms.every((t, i) => t === q.terms[i]) ? q : { terms };
}

export function removeTerm(q: Query, key: TermKey, value: string, neg = false): Query {
  return keep(q, q.terms.filter((t) => !termIs(t, key, value, neg)));
}

/** Switch a term's effect (no-op when it is not there or has that effect). */
export function setTermEffect(q: Query, key: TermKey, value: string, effect: Effect, neg = false): Query {
  const cur = findTerm(q, key, value, neg);
  if (!cur || cur.effect === effect) return q;
  return { terms: q.terms.map((t) => (t === cur ? { ...t, effect } : t)) };
}

/**
 * The chip / eye click: the term is added with `effect`, removed when it already has that effect, and switched when it has the
 * other one (the category `Satellites` chip on a hidden category makes it an `only` term).
 */
export function toggleTerm(q: Query, key: TagKey, value: string, effect: Effect = 'only', neg = false): Query {
  const cur = findTerm(q, key, value, neg);
  if (!cur) return addTerms(q, [{ key, value, effect, ...(neg ? { neg: true } : {}) }]);
  return cur.effect === effect ? removeTerm(q, key, value, neg) : setTermEffect(q, key, value, effect, neg);
}

/** SHOW ALL: no hide term left. */
export const withoutHidden = (q: Query): Query => keep(q, q.terms.filter((t) => t.effect !== 'hide'));
/** CLEAR: no only term and no text left; the hide terms stay (SHOW ALL clears those). */
export const withoutFilter = (q: Query): Query => keep(q, q.terms.filter((t) => t.effect === 'hide'));

// ---------------------------------------------------------------- storage

/** Stored form (`localStorage['eio.query']`): the tag terms with their effects as JSON; the typed text is not remembered. */
export const serialiseQuery = (q: Query): string =>
  JSON.stringify({ terms: tagTerms(q).map((t) => (t.neg ? { key: t.key, value: t.value, neg: true, effect: t.effect } : { key: t.key, value: t.value, effect: t.effect })) });

const isTagKey = (k: unknown): k is TagKey => typeof k === 'string' && (TAG_KEYS as readonly string[]).includes(k);

/**
 * The stored `cat` and `kind` tags became `type` (migration of `eio.query` and `eio.hidden`). A `cat` value keeps its old
 * meaning: the category it named (`cat:satellite` was the category `satellites`, `cat:moon` all the bodies) as the type of
 * that id; a `kind` value is the kind. null for a key that is neither (nor a current one) and for an empty value.
 */
export function migrateLegacyTag(key: unknown, value: unknown): { key: TagKey; value: string } | null {
  if (typeof value !== 'string') return null;
  let v: string;
  if (key === 'cat') {
    const d = value.trim().toLowerCase().replace(/_/g, '-');
    v = CATEGORY_ALIASES[d] ?? (CATEGORIES.some((c) => c.id === d) ? d : CATEGORIES.find((c) => c.id === `${d}s`)?.id ?? d);
    v = normaliseType(v);
  } else if (key === 'kind') v = normaliseType(value);
  else if (isTagKey(key)) v = normaliseValue(key, value);
  else return null;
  return v ? { key: key === 'cat' || key === 'kind' ? 'type' : (key as TagKey), value: v } : null;
}

/** Parse the stored form; anything malformed gives the empty query, bad terms are dropped. */
export function parseStoredQuery(raw: string | null | undefined): Query {
  if (!raw) return NO_QUERY;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return NO_QUERY;
  }
  const list = obj && typeof obj === 'object' ? (obj as { terms?: unknown }).terms : undefined;
  if (!Array.isArray(list)) return NO_QUERY;
  const terms: Term[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const { key, value, neg, effect } = x as Record<string, unknown>;
    if (effect !== 'only' && effect !== 'hide') continue;
    const m = migrateLegacyTag(key, value);
    if (!m || terms.some((t) => termIs(t, m.key, m.value, neg === true))) continue;
    terms.push(neg === true ? { key: m.key, value: m.value, neg: true, effect } : { key: m.key, value: m.value, effect });
  }
  return terms.length ? { terms } : NO_QUERY;
}

/**
 * The old `localStorage['eio.hidden']` ({"cat":["debris"],"group":["starlink"]}) as hide terms (`cat` and `kind` become `type`);
 * malformed values give none and unknown keys and non-strings are dropped. Read once at startup, then the key is deleted.
 */
export function legacyHiddenTerms(raw: string | null | undefined): Term[] {
  if (!raw) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const out: Term[] = [];
  for (const k of ['cat', 'kind', ...TAG_KEYS]) {
    const v = (obj as Record<string, unknown>)[k];
    if (!Array.isArray(v)) continue;
    for (const x of v) {
      const m = migrateLegacyTag(k, x);
      if (m && !out.some((t) => termIs(t, m.key, m.value))) out.push({ key: m.key, value: m.value, effect: 'hide' });
    }
  }
  return out;
}
