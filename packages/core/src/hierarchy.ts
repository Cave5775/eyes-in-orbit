import { BodyRegistry, bodyPeriodSec, defaultBodies } from './bodies';
import type { EntityRecord } from './types';

/** Rank of a body or primary that is not in the registry: after everything known. */
const UNKNOWN_DEPTH = 99;
/** Ranks below this are body entities, from this up objects (satellites, probes, ...). */
const OBJECT_BASE = 1_000_000;

const ALT_NAMES: Record<string, string> = {
  SUN: 'Sol', EARTH: 'Terra', MOON: 'Luna',
  // minor-planet designations of the dwarf planets, so "134340" or "1 Ceres" finds them
  CERES: '1 Ceres', PLUTO: '134340 Pluto', ERIS: '136199 Eris', HAUMEA: '136108 Haumea', MAKEMAKE: '136472 Makemake',
};

/** Entity id of a registry body: `body-` + lowercase registry id (`body-earth`). */
export const bodyEntityId = (bodyId: string): string => `body-${bodyId.toLowerCase()}`;

/**
 * One entity record per registry body (Sun, Earth, Moon, Mars by default), so bodies are positional objects like any
 * other: `provider: { type: 'body', bodyId }` (state in `EARTH:inertial`, see `bodyStateEci`).
 *
 * - `kind`: `star` (no parent), `planet` (parent is the root), `dwarf_planet` (parent is the root, `Body.dwarf`: Ceres, Pluto,
 *   Eris, Haumea, Makemake), `moon` (deeper). The default registry has 35 bodies: Sun, Earth, Moon, Mars, the other six planets,
 *   five dwarf planets and 20 moons (see `DEFAULT_BODY_LIST`).
 * - `bodyId`: the registry id of the body it ORBITS (Moon -> `EARTH`). The field is required, so the Sun, which orbits
 *   nothing, names itself (`SUN`). `parentId` is the entity id of the parent body (`body-earth`), unset for the Sun.
 * - `aliases.body` is the registry id; `aliases.alt` an alternative name (Sol, Terra, Luna) for search.
 * - `attrs`: `radiusKm`, `gm`, `periodDays` (orbit around the parent, absent for the Sun), `approx`.
 * - `updatedAt` defaults to 0 (static data; the hub restamps it on upsert).
 */
export function bodyEntityRecords(registry: BodyRegistry = defaultBodies, updatedAt = 0): EntityRecord[] {
  return registry.all().map((b) => {
    const parent = b.parentId ? registry.get(b.parentId) : undefined;
    const period = bodyPeriodSec(b, registry);
    const aliases: Record<string, string> = { body: b.id };
    if (ALT_NAMES[b.id]) aliases.alt = ALT_NAMES[b.id];
    const attrs: NonNullable<EntityRecord['attrs']> = { radiusKm: b.radiusKm, gm: b.gm };
    if (period !== undefined) attrs.periodDays = period / 86400;
    attrs.approx = !!b.approx;
    const rec: EntityRecord = {
      id: bodyEntityId(b.id),
      name: b.name,
      kind: !parent ? 'star' : parent.parentId ? 'moon' : b.dwarf ? 'dwarf_planet' : 'planet',
      bodyId: parent ? parent.id : b.id,
      aliases,
      group: 'bodies',
      provider: { type: 'body', bodyId: b.id },
      render: { ...(parent ? { orbitLine: true } : {}), label: true, colorKey: 'body' },
      attrs,
      updatedAt,
    };
    if (parent) rec.parentId = bodyEntityId(parent.id);
    return rec;
  });
}

/** True for an entity that stands for a registry body (provider type `body`). */
export const isBodyEntity = (rec: Pick<EntityRecord, 'provider'>): boolean => rec.provider?.type === 'body';

/**
 * The ONE converter from a body entity to the registry: the registry id the entity stands for (`body-moon` -> `MOON`), or
 * undefined for any other record. Everything outside core and `lib/ref-body.ts` works with entity ids; this is where the
 * two meet.
 */
export function bodyOf(rec: Pick<EntityRecord, 'provider'>): string | undefined {
  return rec.provider?.type === 'body' ? rec.provider.bodyId : undefined;
}

/**
 * Can the view be centred on this entity, i.e. can it be the frame of reference? A body entity, or an entity flagged
 * `attrs.orbitable === true` (e.g. a large asteroid). A plain satellite is not.
 */
export function isOrbitable(rec: Pick<EntityRecord, 'provider' | 'attrs'>): boolean {
  return rec.provider?.type === 'body' || rec.attrs?.orbitable === true;
}

/** Number of ancestors of a registry body: lineage length minus 1 (Sun 0, the planets and dwarf planets 1, their moons 2). */
export function bodyDepth(id: string, registry: BodyRegistry = defaultBodies): number {
  return registry.lineage(id).length - 1;
}

function depthOrUnknown(id: string, registry: BodyRegistry): number {
  return registry.has(id) ? bodyDepth(id, registry) : UNKNOWN_DEPTH;
}

/**
 * Sortable rank of an entity in the object hierarchy, smaller = higher up.
 *
 * - Body entities (provider type `body`): `depth * 1000 + registry index`, so Sun 0, Earth 1000, Mars 1001, Moon 2000.
 * - Every other object: `1e6 + bodyDepth(rec.bodyId) + 1`, so objects orbiting the Sun rank 1e6+1, those orbiting
 *   Earth or Mars 1e6+2 (same level; recency orders them), those orbiting the Moon 1e6+3. An unknown primary body
 *   ranks last.
 *
 * Order: Sun < Earth < Mars < Moon < objects orbiting the Sun < objects orbiting Earth/Mars < objects orbiting the Moon.
 * All bodies come before all objects, so a body always precedes anything that orbits it.
 */
export function entityRank(rec: Pick<EntityRecord, 'provider' | 'bodyId'>, registry: BodyRegistry = defaultBodies): number {
  if (rec.provider?.type === 'body') {
    const id = rec.provider.bodyId;
    if (!registry.has(id)) return UNKNOWN_DEPTH * 1000;
    const index = registry.all().findIndex((b) => b.id === id);
    return bodyDepth(id, registry) * 1000 + index;
  }
  return OBJECT_BASE + depthOrUnknown(rec.bodyId, registry) + 1;
}

/**
 * Comparator for lists "highest in the hierarchy first": `entityRank` ascending, then most recent first
 * (`createdAt ?? updatedAt` descending), then id.
 */
export function compareHierarchy(
  a: Pick<EntityRecord, 'id' | 'provider' | 'bodyId' | 'createdAt' | 'updatedAt'>,
  b: Pick<EntityRecord, 'id' | 'provider' | 'bodyId' | 'createdAt' | 'updatedAt'>,
  registry: BodyRegistry = defaultBodies,
): number {
  const dr = entityRank(a, registry) - entityRank(b, registry);
  if (dr) return dr;
  const dt = (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt);
  if (dt) return dt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
