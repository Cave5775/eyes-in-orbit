import { listParent, sampleWindowOf, type EntityRecord, type Sample } from '@eio/core';

type Rec = Pick<EntityRecord, 'bodyId'> & Partial<Pick<EntityRecord, 'provider'>>;

/** Result per sample array: a feed replaces the array when new samples arrive, so the entry dies with the old window. */
const memo = new WeakMap<readonly Sample[], { frame: string; bodyId: string; n: number; t0: number; t1: number; parent: string }>();

/**
 * The body an entity is listed under (core `listParent`: the deepest sphere of influence that contains its whole sample
 * window, else the common ancestor; `bodyId` without samples). Memoised per sample array, so it costs one evaluation when
 * the samples change and a lookup afterwards (never per frame). `bodyId` itself stays the feed's query centre.
 */
export function listedParent(rec: Rec): string {
  const w = sampleWindowOf(rec);
  if (!w) return rec.bodyId;
  // a provider may push into / trim its array in place: length and end times are part of the key
  const n = w.samples.length, t0 = w.samples[0][0], t1 = w.samples[n - 1][0];
  const hit = memo.get(w.samples);
  if (hit && hit.frame === w.frame && hit.bodyId === rec.bodyId && hit.n === n && hit.t0 === t0 && hit.t1 === t1) return hit.parent;
  const parent = listParent(rec, w);
  memo.set(w.samples, { frame: w.frame, bodyId: rec.bodyId, n, t0, t1, parent });
  return parent;
}
