import { defaultBodies, launchIdFromCospar } from '@eio/core';
import { CATEGORIES, categoryOf } from './browser-ui';

/**
 * Tags in the entity search field (pure). The browser's chips only offer a few general categories; a specific group is a
 * tag typed in the field:
 *
 *   group:starlink  #starlink   CelesTrak group (also `group:cosmos` for `cosmos-2251-debris`: a word prefix)
 *   kind:probe      type:probe  entity kind (`launch_vehicle`, `ground_station`, ...)
 *   cat:navigation              general category (the chips: satellites, stations, navigation, probes, ...)
 *   launch:2024-123             launch group from the COSPAR designator (`launch:1993` is every launch of that year)
 *   id:25544        norad:25544 an id or alias value: entity id, NORAD, COSPAR, ...
 *   body:earth                  what orbits that body or one of its moons (the tree nodes)
 *
 * Different keys AND together, repeated values of one key OR (`group:gps-ops group:galileo`), a leading `-` negates
 * (`-kind:debris`). Everything else, including unknown `key:value` words, is plain text for the name search. What a tag
 * does (show only those, or hide them) is the `effect` of its term in lib/query.ts.
 */

export type TagKey = 'kind' | 'group' | 'launch' | 'cat' | 'id' | 'body';
export const TAG_KEYS: readonly TagKey[] = ['kind', 'group', 'launch', 'cat', 'id', 'body'];

/** Other spellings of the keys. */
const KEY_ALIASES: Record<string, TagKey> = {
  kind: 'kind', type: 'kind', group: 'group', launch: 'launch', cat: 'cat', category: 'cat', id: 'id', norad: 'id', cospar: 'id', body: 'body',
};

/** Values by key. */
export type TagValues = Partial<Record<TagKey, string[]>>;

export interface TagFilter {
  include: TagValues;
  exclude: TagValues;
}

export const NO_TAGS: TagFilter = { include: {}, exclude: {} };

export interface ParsedQuery {
  /** the plain-text words, joined by single spaces */
  text: string;
  tags: TagFilter;
}

export interface TagToken {
  key: TagKey;
  /** normalised value (lower case; see `normaliseValue`) */
  value: string;
  negated: boolean;
}

const CAT_ALIASES: Record<string, string> = {
  vehicle: 'launch-vehicles', vehicles: 'launch-vehicles', rocket: 'launch-vehicles', rockets: 'launch-vehicles', launch: 'launch-vehicles',
  nav: 'navigation', gnss: 'navigation', gps: 'navigation', ground_station: 'ground', 'ground-stations': 'ground', pads: 'ground', pad: 'ground',
  sats: 'satellites', sat: 'satellites', body: 'bodies', planets: 'bodies', planet: 'bodies', moons: 'bodies', moon: 'bodies',
};

/** The canonical form of a tag value: lower case; kinds use `_`, categories their id (`cat:satellite` is `satellites`). */
export function normaliseValue(key: TagKey, raw: string): string {
  const v = raw.trim().toLowerCase();
  if (key === 'kind') return v.replace(/[\s-]+/g, '_');
  if (key === 'cat') {
    const d = v.replace(/_/g, '-');
    const alias = CAT_ALIASES[d];
    if (alias) return alias;
    if (CATEGORIES.some((c) => c.id === d)) return d;
    return CATEGORIES.find((c) => c.id === `${d}s`)?.id ?? d;
  }
  return v;
}

const TOKEN = /^(-?)(?:#|([A-Za-z]+):)(.*)$/;

/**
 * One word as a tag: `[-]key:value` or `[-]#value` (a group). null for plain text (also for an unknown key) and for a tag
 * without a value yet (`group:`), which `parseQuery` leaves out of the text.
 */
export function parseToken(word: string): TagToken | null {
  const m = TOKEN.exec(word);
  if (!m) return null;
  const key = m[2] === undefined ? 'group' : KEY_ALIASES[m[2].toLowerCase()];
  if (!key) return null;
  const value = normaliseValue(key, m[3]);
  if (!value) return null;
  return { key, value, negated: m[1] === '-' };
}

/** A tag word whose value is still empty (`group:`, `#`, `-id:`): being typed, neither text nor filter. */
const isEmptyTag = (word: string): boolean => {
  const m = TOKEN.exec(word);
  return !!m && (m[2] === undefined || KEY_ALIASES[m[2].toLowerCase()] !== undefined) && m[3].trim() === '';
};

export const tagToken = (key: TagKey, value: string, negated = false): string => `${negated ? '-' : ''}${key}:${value}`;
/** The canonical word of a parsed token (`#starlink` gives `group:starlink`). */
export const tokenWord = (t: TagToken): string => tagToken(t.key, t.value, t.negated);

const add = (v: TagValues, key: TagKey, value: string): void => {
  const list = (v[key] ??= []);
  if (!list.includes(value)) list.push(value);
};

/** Split the raw search text into plain text and tags. */
export function parseQuery(raw: string): ParsedQuery {
  const words: string[] = [];
  const tags: TagFilter = { include: {}, exclude: {} };
  for (const word of raw.split(/\s+/)) {
    if (!word) continue;
    const t = parseToken(word);
    if (t) add(t.negated ? tags.exclude : tags.include, t.key, t.value);
    else if (!isEmptyTag(word)) words.push(word);
  }
  return { text: words.join(' '), tags };
}

/** The fields of an entity the tags look at (a record, or a search hit with the extra fields looked up). */
export interface TagTarget {
  id?: string;
  kind: string;
  group?: string;
  bodyId?: string;
  aliases?: Record<string, string>;
  render?: { colorKey?: string };
}

/** Does `rec` match the single tag `key:value` (value already normalised)? */
export function matchesTag(rec: TagTarget, key: TagKey, value: string): boolean {
  switch (key) {
    case 'kind':
      return rec.kind.toLowerCase() === value;
    case 'group': {
      const g = (rec.group ?? '').toLowerCase();
      return g === value || g.startsWith(`${value}-`);
    }
    case 'launch': {
      const l = launchIdFromCospar(rec.aliases?.cospar);
      return !!l && (l === value || l.startsWith(`${value}-`));
    }
    case 'cat':
      return categoryOf(rec) === value;
    case 'id': {
      if (rec.id?.toLowerCase() === value) return true;
      for (const a of Object.values(rec.aliases ?? {})) if (String(a).toLowerCase() === value) return true;
      return false;
    }
    case 'body': {
      // the body it orbits or any body above it: `body:earth` holds the Moon's objects too, like the tree node
      const b = (rec.bodyId ?? '').toUpperCase();
      return defaultBodies.has(b) ? defaultBodies.lineage(b).some((x) => x.id.toLowerCase() === value) : b.toLowerCase() === value;
    }
  }
}

// ---------------------------------------------------------------- typing: chips and autocomplete

/**
 * Complete tag words that are followed by whitespace become chips; `rest` is what stays in the field. The word still being
 * typed (no whitespace after it yet) stays, however complete it looks.
 */
export function splitCommitted(raw: string): { chips: string[]; rest: string } {
  const chips: string[] = [];
  const keep: string[] = [];
  const words = raw.split(/\s+/);
  const endsOpen = !/\s$/.test(raw);
  words.forEach((w, i) => {
    if (!w) return;
    const t = i === words.length - 1 && endsOpen ? null : parseToken(w);
    if (t) chips.push(tokenWord(t));
    else keep.push(w);
  });
  const rest = keep.join(' ');
  return { chips, rest: rest && !endsOpen ? `${rest} ` : rest };
}

export interface ActiveTag {
  /** index in the raw text where the word starts */
  start: number;
  negated: boolean;
  key: TagKey;
  /** what follows the colon so far */
  partial: string;
}

/** The tag word being typed at the end of the text (`gro` is not one yet; `group:st` and `#st` are), or null. */
export function activeTag(raw: string): ActiveTag | null {
  const m = /(?:^|\s)(\S*)$/.exec(raw);
  if (!m) return null;
  const word = m[1];
  const t = TOKEN.exec(word);
  if (!t) return null;
  const key = t[2] === undefined ? 'group' : KEY_ALIASES[t[2].toLowerCase()];
  if (!key) return null;
  return { start: raw.length - word.length, negated: t[1] === '-', key, partial: t[3] };
}

export interface TagSuggestion {
  /** normalised value, as it goes into the tag */
  value: string;
  /** shown next to the value, e.g. the launch's name */
  label?: string;
  count: number;
}

/** Suggestions for the tag being typed: value prefix first, then word prefix, then substring; ties by count. */
export function suggestTags(active: ActiveTag, source: readonly TagSuggestion[], limit = 8): TagSuggestion[] {
  const q = normaliseValue(active.key, active.partial);
  const scored: { s: TagSuggestion; rank: number }[] = [];
  for (const s of source) {
    const v = s.value.toLowerCase();
    const label = (s.label ?? '').toLowerCase();
    let rank = -1;
    if (!q) rank = 3;
    else if (v === q) rank = 0;
    else if (v.startsWith(q)) rank = 1;
    else if (v.split(/[-_\s]+/).some((w) => w.startsWith(q)) || label.startsWith(q)) rank = 2;
    else if (v.includes(q) || label.includes(q)) rank = 3;
    if (rank >= 0) scored.push({ s, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || b.s.count - a.s.count || a.s.value.localeCompare(b.s.value));
  return scored.slice(0, limit).map((x) => x.s);
}

/**
 * Backspace in the search field removes the chip just before the input when there is nothing in front of the caret to
 * delete: an empty field, or a caret at the very start of the typed text (a collapsed selection at 0). The chips sit before
 * the input, so the last chip is the one directly in front of the caret. A selection (even one that starts at 0) is deleted
 * as text, as is a caret anywhere else. Selection offsets are null for inputs that have none: only an empty field counts then.
 */
export function backspaceRemovesChip(value: string, selStart: number | null, selEnd: number | null, chipCount: number): boolean {
  if (chipCount <= 0) return false;
  if (selStart === null || selEnd === null) return value === '';
  return selStart === 0 && selEnd === 0;
}

/** Accepting a suggestion: the finished chip word and the text that stays in the field. */
export function acceptTag(raw: string, active: ActiveTag, value: string): { chip: string; rest: string } {
  return { chip: tagToken(active.key, value, active.negated), rest: raw.slice(0, active.start).replace(/\s+$/, '') };
}
