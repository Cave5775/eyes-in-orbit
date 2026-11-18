import type { EntityRecord } from '@eio/core';

/**
 * The entity catalogue as the store holds it: a read-only VIEW over one shared map. A merge writes the changed records into
 * that map and returns a NEW view (`merged`), so the store's `entities` still changes identity on every change (that is how its
 * 34 consumers notice) without copying the catalogue: a merge costs its records, not the catalogue (a copy of a 1 M entry map
 * was 460 ms; docs/perf.md).
 *
 * The price: a view is not a snapshot. An older view reads the same map, so after a merge it shows the new records too. Nothing
 * in the app keeps an old catalogue to compare contents with (consumers compare identities, and what changed is reported
 * separately in the store's `entityChange`); code that needs a frozen copy makes one (`new Map(view)`). `replace` starts a new
 * map, which old views do not see.
 */
export class Catalog implements ReadonlyMap<string, EntityRecord> {
  private constructor(private readonly map: Map<string, EntityRecord>, readonly version: number) {}

  /** A new catalogue of these records (a map of its own). */
  static of(records: Iterable<EntityRecord> = []): Catalog {
    const m = new Map<string, EntityRecord>();
    for (const r of records) m.set(r.id, r);
    return new Catalog(m, 0);
  }

  /** Write `records` into the shared map and return the next view (this one sees them too). */
  merged(records: Iterable<EntityRecord>): Catalog {
    for (const r of records) this.map.set(r.id, r);
    return new Catalog(this.map, this.version + 1);
  }

  /** Delete `ids` from the shared map and return the next view (this one stops seeing them too). */
  without(ids: Iterable<string>): Catalog {
    for (const id of ids) this.map.delete(id);
    return new Catalog(this.map, this.version + 1);
  }

  get size(): number {
    return this.map.size;
  }
  get(id: string): EntityRecord | undefined {
    return this.map.get(id);
  }
  has(id: string): boolean {
    return this.map.has(id);
  }
  keys(): MapIterator<string> {
    return this.map.keys();
  }
  values(): MapIterator<EntityRecord> {
    return this.map.values();
  }
  entries(): MapIterator<[string, EntityRecord]> {
    return this.map.entries();
  }
  forEach(cb: (value: EntityRecord, key: string, map: ReadonlyMap<string, EntityRecord>) => void, thisArg?: unknown): void {
    this.map.forEach((v, k) => cb.call(thisArg, v, k, this));
  }
  [Symbol.iterator](): MapIterator<[string, EntityRecord]> {
    return this.map[Symbol.iterator]();
  }
  get [Symbol.toStringTag](): string {
    return 'Catalog';
  }
}

const json = (v: unknown): string => (v === undefined ? '' : JSON.stringify(v));

/**
 * Does replacing `prev` by `next` leave everything a LIST of the catalogue shows unchanged (the Objects tree and list, the facet
 * and category counts, tag suggestions, launch groups)? True only for an SGP4 record whose every field but its orbital elements
 * (`provider`) and `updatedAt` is the same: a CelesTrak element update, the bulk of the pushes. Anything else (a new record, a
 * renamed one, a sampled track whose samples moved and may move its listed parent, a launch whose phase changed) counts as a
 * change of shape. Conservative on purpose: a false "changed" costs one rebuild, a false "same" would show stale rows.
 */
export function sameShape(prev: EntityRecord | undefined, next: EntityRecord): boolean {
  if (!prev || prev.provider?.type !== 'sgp4' || next.provider?.type !== 'sgp4') return false;
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    if (k === 'provider' || k === 'updatedAt') continue;
    const a = (prev as unknown as Record<string, unknown>)[k], b = (next as unknown as Record<string, unknown>)[k];
    if (a === b) continue;
    if (typeof a !== 'object' || typeof b !== 'object' || json(a) !== json(b)) return false;
  }
  return true;
}
