import { defaultBodies, type EntityRecord } from '@eio/core';
import { fmtDays, fmtKm, fmtNum } from './format';
import { viewClass } from './view-class';

/** Pure parts of the detail panel's body facts and the EntityBrowser's category chips. */

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

/** The detail panel's empty text. */
export const emptyHint = (): string => 'Select an object on the globe, in the entity list or the launch board.';

// ---------------------------------------------------------------- general categories (the browser's chips)

/**
 * The few general categories the entity browser offers as chips (specific groups such as `starlink`, `gps-ops` or a launch
 * are tags typed in the search field, see `search-tags.ts`). Every entity is in exactly one category, so the counts add up
 * and a hidden category hides exactly what its chip counts.
 */
export type CategoryId = 'satellites' | 'stations' | 'navigation' | 'probes' | 'launch-vehicles' | 'debris' | 'ground' | 'bodies' | 'other';

export interface Category {
  id: CategoryId;
  label: string;
  /** one line for the chip tooltip */
  hint: string;
  /** the colour of everything in the category: its points in the scene, its dots in the lists, the legend, the labels (styles.css `--c-<id>` holds the same value) */
  color: string;
}

/** Chip order. `other` is shown only when the catalog has something in it. */
export const CATEGORIES: readonly Category[] = [
  { id: 'satellites', label: 'Satellites', color: '#90bef1', hint: 'Satellites that are not navigation, stations or debris (Starlink, active, amateur...)' },
  { id: 'stations', label: 'Stations', color: '#f9f684', hint: 'Space stations (ISS, Tiangong)' },
  { id: 'navigation', label: 'Navigation', color: '#ff58a6', hint: 'GNSS satellites (GPS, GLONASS, Galileo, BeiDou)' },
  { id: 'probes', label: 'Probes', color: '#7781f2', hint: 'Deep-space probes, landers and rovers (orbiters of other bodies are satellites)' },
  { id: 'launch-vehicles', label: 'Launch vehicles', color: '#fb9f21', hint: 'Launch vehicles, stages and capsules' },
  { id: 'debris', label: 'Debris', color: '#777d7f', hint: 'Debris and spent rocket bodies' },
  { id: 'ground', label: 'Ground', color: '#40b272', hint: 'Ground stations and launch pads' },
  { id: 'bodies', label: 'Bodies', color: '#e8f5fd', hint: 'The Sun, planets and moons (scenery: they cannot be hidden)' },
  { id: 'other', label: 'Other', color: '#3eeec1', hint: 'Everything else' },
];

export const categoryLabel = (id: string): string => CATEGORIES.find((c) => c.id === id)?.label ?? id;

/** Kinds of the celestial bodies; they are drawn as scenery and the hide toggle leaves them alone. */
export const BODY_CATEGORY_KINDS: ReadonlySet<string> = new Set(['star', 'planet', 'moon', 'dwarf_planet', 'asteroid']);
/** CelesTrak navigation groups (plus the combined `gnss`). */
const NAV_GROUP_NAMES: ReadonlySet<string> = new Set(['gps-ops', 'glo-ops', 'galileo', 'beidou', 'gnss']);

/**
 * The category of an entity, from its kind, its group and `render.colorKey`. This is also its colour everywhere (`colorKeyOf`
 * in entity.ts, the palette, the legend, the lists): `render.colorKey` is only an advisory hint from the feed, and the old
 * per-constellation `starlink` key is just a satellite here.
 */
export function categoryOf(rec: { kind: string; group?: string; bodyId?: string; provider?: { type: string }; render?: { colorKey?: string } }): CategoryId {
  const k = rec.kind;
  const ck = rec.render?.colorKey;
  if (BODY_CATEGORY_KINDS.has(k) || ck === 'body') return 'bodies';
  if (k === 'station' || ck === 'station') return 'stations';
  if (k === 'debris' || ck === 'debris') return 'debris';
  // an orbiter of another body (MRO, LRO) is a satellite of that body, not a deep-space probe (lib/view-class.ts)
  if (rec.bodyId !== undefined && viewClass({ kind: k, bodyId: rec.bodyId, provider: rec.provider as EntityRecord['provider'] }) === 'orbiter') return 'satellites';
  if (k === 'probe' || k === 'rover' || k === 'lander' || ck === 'probe' || ck === 'rover') return 'probes';
  if (k === 'launch_vehicle' || k === 'stage' || k === 'capsule' || ck === 'vehicle') return 'launch-vehicles';
  if (k === 'ground_station' || k === 'pad' || ck === 'ground') return 'ground';
  if (ck === 'navigation' || (k === 'satellite' && NAV_GROUP_NAMES.has(rec.group ?? ''))) return 'navigation';
  if (k === 'satellite' || ck === 'satellite' || ck === 'starlink') return 'satellites';
  return 'other';
}

// ---------------------------------------------------------------- the `type` tag

/**
 * Other spellings of the categories (the old `cat:` aliases), by their hyphenated form. A word that is also a kind
 * (`moon`, `planets`, `ground_station`, `pad`) is that kind first, see `normaliseType`.
 */
export const CATEGORY_ALIASES: Readonly<Record<string, CategoryId>> = {
  vehicle: 'launch-vehicles', vehicles: 'launch-vehicles', rocket: 'launch-vehicles', rockets: 'launch-vehicles', launch: 'launch-vehicles',
  nav: 'navigation', gnss: 'navigation', gps: 'navigation', 'ground-station': 'ground', 'ground-stations': 'ground', pads: 'ground', pad: 'ground',
  sats: 'satellites', sat: 'satellites', body: 'bodies', planets: 'bodies', planet: 'bodies', moons: 'bodies', moon: 'bodies',
};

/** The entity kinds the app knows (`EntityKind` in @eio/core, the connectors and the mock catalogue); any other string is a kind too. */
export const KNOWN_KINDS: ReadonlySet<string> = new Set([
  'satellite', 'station', 'probe', 'launch_vehicle', 'stage', 'capsule', 'drone', 'rover', 'lander', 'ground_station', 'pad', 'debris',
  'star', 'planet', 'moon', 'asteroid', 'dwarf_planet',
]);

const CATEGORY_IDS: ReadonlySet<string> = new Set(CATEGORIES.map((c) => c.id));

/**
 * The canonical form of a `type:` value (lower case): a general category keeps its id (`launch-vehicles`, also reached by
 * `launch_vehicles`, `Launch Vehicles` and the aliases `nav`, `gps`, `rockets`...), anything else is a kind with `_` between
 * the words (`ground-station` is `ground_station`; a plural of a known kind is the kind: `rovers` is `rover`).
 */
export function normaliseType(raw: string): string {
  const d = raw.trim().toLowerCase();
  const h = d.replace(/[\s_]+/g, '-');
  if (CATEGORY_IDS.has(h)) return h;
  const k = d.replace(/[\s-]+/g, '_');
  const single = k.length > 1 && k.endsWith('s') ? k.slice(0, -1) : k;
  if (KNOWN_KINDS.has(k)) return k;
  if (KNOWN_KINDS.has(single)) return single;
  return CATEGORY_ALIASES[h] ?? k;
}

interface TypeMatcher {
  category?: CategoryId;
  kinds?: readonly string[];
}

const typeMatchers = new Map<string, TypeMatcher>();

function typeMatcher(value: string): TypeMatcher {
  let m = typeMatchers.get(value);
  if (m) return m;
  const v = normaliseType(value);
  if (CATEGORY_IDS.has(v)) m = { category: v as CategoryId };
  else {
    // a kind, singular or plural (`rover`, `rovers`)
    const base = v.length > 1 && v.endsWith('s') ? v.slice(0, -1) : v;
    m = { kinds: v === base ? [v, `${v}s`] : [v, base] };
  }
  if (typeMatchers.size > 500) typeMatchers.clear();
  typeMatchers.set(value, m);
  return m;
}

/**
 * Does the entity match the tag `type:<value>`? The one question of the old `cat:` and `kind:` tags. The value is, ignoring case,
 * singular or plural and the difference of `-`, `_` and space, either
 *
 * - a general category id (`satellites`, `launch-vehicles`, `debris`, `ground`, `bodies`...): the entities `categoryOf` puts
 *   there (`type:satellites` is the plain satellites, not the navigation ones; the category chips count exactly these), or
 * - an entity kind (`satellite`, `probe`, `ground_station`, `moon`, `stage`...): the entities of that kind, so `type:satellite`
 *   is every satellite and `type:probe` only the probes, not the rovers (use `type:probes` for the whole family).
 *
 * A word that is both an old category alias and a kind (`moon`, `planets`, `pad`) is the kind.
 */
export function matchesType(rec: { kind: string; group?: string; render?: { colorKey?: string } }, value: string): boolean {
  const m = typeMatcher(value);
  if (m.category) return categoryOf(rec) === m.category;
  return !!m.kinds && m.kinds.includes(rec.kind.toLowerCase());
}

/** Entities per category (all categories present, in chip order; `other` only when it has members). */
export function categoryCounts(records: Iterable<{ kind: string; group?: string; render?: { colorKey?: string } }>): [CategoryId, number][] {
  const n = new Map<CategoryId, number>();
  for (const r of records) {
    const c = categoryOf(r);
    n.set(c, (n.get(c) ?? 0) + 1);
  }
  return CATEGORIES.filter((c) => c.id !== 'other' || n.has('other')).map((c): [CategoryId, number] => [c.id, n.get(c.id) ?? 0]);
}
