import { bodyEntityId, type EntityRecord } from '@eio/core';
import { listedParent } from './listed-parent';

/** What the camera shows when an entity is selected: the entity itself, or (untracked) the nearest ancestor that has a position. */
export interface FocusTarget {
  /** entity id to frame */
  id: string;
  /** true when the selected entity has no position at the sim time and `id` is its stand-in */
  untracked: boolean;
}

type FocusRec = Pick<EntityRecord, 'id' | 'bodyId' | 'parentId'> & Partial<Pick<EntityRecord, 'provider'>>;

const EARTH_ID = bodyEntityId('EARTH');
const MAX_HOPS = 12;

/**
 * Fallback chain for selecting an untracked entity (no state at the sim time): the entity itself when it has a position;
 * else its `parentId` entity (a payload's launch vehicle), else its listed parent body entity (MAVEN -> Mars, Voyager -> Sun), then the
 * same for that one, upward until something has a position. The Earth when nothing does.
 */
export function focusTarget(
  rec: FocusRec,
  lookup: (id: string) => FocusRec | undefined,
  hasPos: (id: string) => boolean,
): FocusTarget {
  if (hasPos(rec.id)) return { id: rec.id, untracked: false };
  const seen = new Set([rec.id]);
  let cur: FocusRec | undefined = rec;
  for (let i = 0; i < MAX_HOPS && cur; i++) {
    const candidates: string[] = [];
    if (cur.parentId) candidates.push(cur.parentId);
    candidates.push(bodyEntityId(listedParent(cur))); // the LISTED parent: a deep-space probe falls back to the Sun, not the Earth
    let next: FocusRec | undefined;
    for (const c of candidates) {
      if (seen.has(c)) continue;
      const r = lookup(c);
      if (!r) continue;
      if (hasPos(c)) return { id: c, untracked: true };
      next ??= r;
    }
    if (!next) break;
    seen.add(next.id);
    cur = next;
  }
  return { id: EARTH_ID, untracked: true };
}
