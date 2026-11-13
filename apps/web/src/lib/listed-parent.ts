import { listParent, sampleWindowOf, type EntityRecord, type Sample } from '@eio/core';

type Rec = Pick<EntityRecord, 'bodyId'> & Partial<Pick<EntityRecord, 'provider'>>;

/** Result per sample array: a feed replaces the array when new samples arrive, so the entry dies with the old window. */
const memo = new WeakMap<readonly Sample[], { frame: string; bodyId: string; parent: string }>();

/**
 * The body an entity is listed under (core `listParent`: the deepest sphere of influence that contains its whole sample
 * window, else the common ancestor; `bodyId` without samples). Memoised per sample array, so it costs one evaluation when
 * the samples change and a lookup afterwards (never per frame). `bodyId` itself stays the feed's query centre.
 */
export function listedParent(rec: Rec): string {
  const w = sampleWindowOf(rec);
  if (!w) return rec.bodyId;
  const hit = memo.get(w.samples);
  if (hit && hit.frame === w.frame && hit.bodyId === rec.bodyId) return hit.parent;
  const parent = listParent(rec, w);
  memo.set(w.samples, { frame: w.frame, bodyId: rec.bodyId, parent });
  return parent;
}
