import { launchGroupLabel, launchIdFromCospar, type EntityRecord } from '@eio/core';
import { isHiddenBy, matchesTags, tagsActive, type HiddenTags, type TagFilter, type TagTarget } from './search-tags';

/** `only` hides everything outside the selected launch in the scene; `highlight` dims it instead. */
export type LaunchMode = 'only' | 'highlight';

/** Empty set / no launch = no restriction. */
export interface Filters {
  kinds: ReadonlySet<string>;
  groups: ReadonlySet<string>;
  /** Launch id (`YYYY-NNN`, derived from the COSPAR designator) of the selected launch group. */
  launch?: string | null;
  launchMode?: LaunchMode;
  /** tags typed in the search field (`group:starlink`, `-kind:debris`...): they filter the list and the scene like the sets above */
  tags?: TagFilter;
  /**
   * Hidden groups (`cat:debris`, `group:starlink`...): those entities leave the scene but stay in the browser list. Not a
   * filter: `matchesFilters` and `filtersActive` ignore it.
   */
  hidden?: HiddenTags;
}

export const NO_FILTERS: Filters = { kinds: new Set(), groups: new Set(), launch: null, launchMode: 'only' };

type Filterable = Pick<EntityRecord, 'kind' | 'group'> & Omit<TagTarget, 'kind' | 'group'>;

/** Launch id (`1993-036`) of a record, from its COSPAR alias. */
export const launchIdOf = (rec: { aliases?: Record<string, string> }): string | undefined => launchIdFromCospar(rec.aliases?.cospar);

const inLaunch = (rec: Filterable, f: Filters): boolean => !f.launch || launchIdOf(rec) === f.launch;

/** Strict match used by the entity list: kind, group and launch must all match (in either launch mode). */
export function matchesFilters(rec: Filterable, f: Filters): boolean {
  if (f.kinds.size && !f.kinds.has(rec.kind)) return false;
  if (f.groups.size && !f.groups.has(rec.group ?? '')) return false;
  if (!matchesTags(rec, f.tags)) return false;
  return inLaunch(rec, f);
}

/** Is the entity in a hidden group (see `Filters.hidden`)? */
export const isHiddenRec = (rec: Filterable, f: Filters): boolean => isHiddenBy(rec, f.hidden);

export type Visibility = 'show' | 'dim' | 'hide';

/**
 * Scene appearance. Kind, group and tag filters and hidden groups always hide (`keep`: the selected entity, which a hidden
 * group does not hide). A launch filter hides non-members in `only` mode and dims them in `highlight` mode.
 */
export function sceneVisibility(rec: Filterable, f: Filters, keep = false): Visibility {
  if (f.kinds.size && !f.kinds.has(rec.kind)) return 'hide';
  if (f.groups.size && !f.groups.has(rec.group ?? '')) return 'hide';
  if (!matchesTags(rec, f.tags)) return 'hide';
  if (!keep && isHiddenBy(rec, f.hidden)) return 'hide';
  if (inLaunch(rec, f)) return 'show';
  return f.launchMode === 'highlight' ? 'dim' : 'hide';
}

export const filtersActive = (f: Filters): boolean => f.kinds.size > 0 || f.groups.size > 0 || !!f.launch || tagsActive(f.tags);

export function toggled<T>(set: ReadonlySet<T>, v: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(v)) next.add(v);
  return next;
}

/**
 * Relevance of `rec` for query `q`: exact id/alias > name prefix > word prefix > substring.
 * Mirrors the server's ranking so offline/mock search behaves the same. 0 = no match.
 */
export function matchScore(rec: Pick<EntityRecord, 'id' | 'name' | 'aliases'>, q: string): number {
  const query = q.trim().toLowerCase();
  if (!query) return 1;
  const name = rec.name.toLowerCase();
  const id = rec.id.toLowerCase();
  const aliases = Object.values(rec.aliases).map((a) => String(a).toLowerCase());
  if (id === query || aliases.includes(query)) return 100;
  if (name.startsWith(query)) return 80;
  if (name.split(/[\s\-_()/]+/).some((w) => w.startsWith(query))) return 60;
  if (name.includes(query)) return 40;
  if (aliases.some((a) => a.includes(query))) return 30;
  if (id.includes(query)) return 20;
  return 0;
}

export interface SearchHit {
  id: string;
  name: string;
  kind: string;
  group?: string;
  aliases: Record<string, string>;
}

/** Local ranked search; stable by name for equal scores. */
export function rankEntities(records: Iterable<EntityRecord>, q: string, limit = 50): SearchHit[] {
  const scored: { rec: EntityRecord; s: number }[] = [];
  for (const rec of records) {
    const s = matchScore(rec, q);
    if (s > 0) scored.push({ rec, s });
  }
  scored.sort((a, b) => b.s - a.s || a.rec.name.localeCompare(b.rec.name));
  return scored.slice(0, limit).map(({ rec }) => ({ id: rec.id, name: rec.name, kind: rec.kind, group: rec.group, aliases: rec.aliases }));
}

/** Facet counts for the filter chips, most common first. */
export function facetCounts(records: Iterable<Pick<EntityRecord, 'kind' | 'group'>>): {
  kinds: [string, number][];
  groups: [string, number][];
} {
  const kinds = new Map<string, number>();
  const groups = new Map<string, number>();
  for (const r of records) {
    kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    if (r.group) groups.set(r.group, (groups.get(r.group) ?? 0) + 1);
  }
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { kinds: sorted(kinds), groups: sorted(groups) };
}

const KIND_PRIORITY: Record<string, number> = { station: 0, launch_vehicle: 1, probe: 2, rover: 3, ground_station: 4 };

/** Default browse order: notable kinds first, then alphabetical. */
export function browseOrder(a: Pick<EntityRecord, 'kind' | 'name'>, b: Pick<EntityRecord, 'kind' | 'name'>): number {
  return (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9) || a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------- launch groups

export interface LaunchGroup {
  /** `YYYY-NNN` */
  id: string;
  /** e.g. "COSMOS 2251" */
  label: string;
  count: number;
  /** Entity ids of the members. */
  ids: string[];
}

/** Groups of objects sharing a launch (>= `minMembers`), largest first. Records without a valid COSPAR are ignored. */
export function buildLaunchGroups(
  records: Iterable<Pick<EntityRecord, 'id' | 'name' | 'aliases'>>,
  minMembers = 2,
): LaunchGroup[] {
  const byLaunch = new Map<string, Pick<EntityRecord, 'id' | 'name' | 'aliases'>[]>();
  for (const r of records) {
    const id = launchIdOf(r);
    if (!id) continue;
    const list = byLaunch.get(id);
    if (list) list.push(r);
    else byLaunch.set(id, [r]);
  }
  const out: LaunchGroup[] = [];
  for (const [id, members] of byLaunch) {
    if (members.length < minMembers) continue;
    out.push({
      id,
      label: launchGroupLabel(members.map((m) => ({ name: m.name, cospar: m.aliases.cospar })), id),
      count: members.length,
      ids: members.map((m) => m.id),
    });
  }
  return out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/** Combobox search over launch groups by label or launch id; empty query keeps the count order. */
export function searchLaunchGroups(groups: readonly LaunchGroup[], q: string, limit = 50): LaunchGroup[] {
  const query = q.trim().toLowerCase();
  if (!query) return groups.slice(0, limit);
  const scored: { g: LaunchGroup; s: number }[] = [];
  for (const g of groups) {
    const label = g.label.toLowerCase();
    let s = 0;
    if (g.id === query) s = 100;
    else if (label === query) s = 95;
    else if (label.startsWith(query)) s = 80;
    else if (label.split(/[\s\-_()/]+/).some((w) => w.startsWith(query))) s = 60;
    else if (label.includes(query)) s = 40;
    else if (g.id.includes(query)) s = 30;
    if (s) scored.push({ g, s });
  }
  scored.sort((a, b) => b.s - a.s || b.g.count - a.g.count || a.g.label.localeCompare(b.g.label));
  return scored.slice(0, limit).map((x) => x.g);
}
