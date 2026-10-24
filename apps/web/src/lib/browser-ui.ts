import { bodyEntityRecords, defaultBodies, entityRank, type EntityRecord } from '@eio/core';
import { fmtDays, fmtKm, fmtNum } from './format';
import { bodyCentre, sameCentre, type Centre } from './frame';

/** Pure parts of the TopBar body tabs and the EntityBrowser filter chips. */

// ---------------------------------------------------------------- body tabs

export interface BodyTab {
  /** registry body id (`MOON`) */
  bodyId: string;
  /** tab text, e.g. `Moon` */
  name: string;
  /** the body entity behind the tab (`body-moon`) */
  entityId: string;
}

/**
 * One tab per body entity in the catalog, highest in the hierarchy first (`entityRank`: Sun, Earth, Mars, Moon). Before the
 * catalog has arrived (no body entity yet) the tabs come from the registry, so they are never missing.
 */
export function bodyTabs(entities: Iterable<EntityRecord>): BodyTab[] {
  const tabs: (BodyTab & { rank: number })[] = [];
  const collect = (list: Iterable<EntityRecord>) => {
    for (const e of list) {
      const bodyId = e.provider?.type === 'body' ? e.provider.bodyId : undefined;
      if (bodyId !== undefined && defaultBodies.has(bodyId)) tabs.push({ bodyId, name: e.name, entityId: e.id, rank: entityRank(e) });
    }
  };
  collect(entities);
  if (tabs.length === 0) collect(bodyEntityRecords());
  tabs.sort((a, b) => a.rank - b.rank || (a.entityId < b.entityId ? -1 : 1));
  return tabs.map(({ bodyId, name, entityId }) => ({ bodyId, name, entityId }));
}

/** The tab of the body that is the frame (none for an entity centre). */
export const activeBodyTab = (tabs: readonly BodyTab[], frame: Centre): string | null =>
  tabs.find((t) => sameCentre(frame, bodyCentre(t.bodyId)))?.bodyId ?? null;

// ---------------------------------------------------------------- body attributes (detail panel)

/** Attribute keys the BODY section shows, so the generic ATTRIBUTES list does not repeat them. */
export const BODY_ATTR_KEYS: readonly string[] = ['radiusKm', 'gm', 'periodDays', 'approx'];

export interface BodyFact {
  label: string;
  value: string;
}

/**
 * The facts of a body entity for the detail panel: radius, GM, the orbital period in days around its parent, the parent and
 * the approx flag. Missing values are left out (the Sun has no period and no parent).
 */
export function bodyFacts(rec: Pick<EntityRecord, 'attrs' | 'bodyId' | 'parentId'>): BodyFact[] {
  const a = rec.attrs ?? {};
  const num = (k: string): number | undefined => (typeof a[k] === 'number' && Number.isFinite(a[k]) ? (a[k] as number) : undefined);
  const out: BodyFact[] = [];
  const radius = num('radiusKm');
  if (radius !== undefined) out.push({ label: 'Radius', value: fmtKm(radius, radius < 10 ? 2 : 0) });
  const gm = num('gm');
  if (gm !== undefined) out.push({ label: 'GM', value: `${fmtNum(gm, gm < 1000 ? 1 : 0)} km³/s²` });
  const parent = rec.parentId ? (defaultBodies.has(rec.bodyId) ? defaultBodies.get(rec.bodyId).name : rec.bodyId) : undefined;
  const period = num('periodDays');
  if (period !== undefined) out.push({ label: parent ? `Orbital period around ${parent}` : 'Orbital period', value: fmtDays(period) });
  if (parent) out.push({ label: 'Parent', value: parent });
  if (typeof a.approx === 'boolean') out.push({ label: 'Approximate', value: a.approx ? 'yes (low-precision elements)' : 'no' });
  return out;
}

/** The detail panel's empty text; the DSN panel is named only while it is shown (it is hidden by default). */
export const emptyHint = (dsnShown: boolean): string =>
  `Select an object on the globe, in the entity list or the launch board${dsnShown ? ' or the DSN panel' : ''}.`;

// ---------------------------------------------------------------- filter chips

export interface ChipCap {
  shown: [string, number][];
  /** chips left out, to put behind an "n more" button */
  hidden: number;
}

export interface ChipCapOptions {
  /** every chip is shown (the strip scrolls) */
  expanded?: boolean;
  /** chips that stay visible even beyond the cap (e.g. kinds `star`, `planet`, `moon`) */
  pinned?: readonly string[];
  /** chips that stay visible beyond the cap because they are switched on */
  active?: ReadonlySet<string>;
}

/**
 * The first `cap` chips of a list sorted by count, plus the pinned and the active ones wherever they are (the original
 * order is kept), so that every chip is reachable: `hidden` counts the rest, the expander shows them.
 */
export function capChips(entries: readonly [string, number][], cap: number, opts: ChipCapOptions = {}): ChipCap {
  if (opts.expanded || entries.length <= cap) return { shown: [...entries], hidden: 0 };
  const keep = new Set<string>(opts.pinned);
  const shown = entries.filter(([k], i) => i < cap || keep.has(k) || opts.active?.has(k));
  return { shown, hidden: entries.length - shown.length };
}

export const KIND_CHIP_CAP = 10;
export const GROUP_CHIP_CAP = 14;
/** body kinds are always among the kind chips when the catalog has them */
export const BODY_KINDS: readonly string[] = ['star', 'planet', 'moon'];
