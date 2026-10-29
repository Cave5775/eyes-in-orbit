import { bodyEntityId, type EntityRecord } from '@eio/core';

/** What the camera shows when an entity is selected: the entity itself, or (untracked) the nearest ancestor that has a position. */
export interface FocusTarget {
  /** entity id to frame */
  id: string;
  /** true when the selected entity has no position at the sim time and `id` is its stand-in */
  untracked: boolean;
}

const EARTH_ID = bodyEntityId('EARTH');
const MAX_HOPS = 12;

/**
 * Fallback chain for selecting an untracked entity (no state at the sim time): the entity itself when it has a position;
 * else its `parentId` entity (a payload's launch vehicle), else its primary body entity (`bodyId`: MAVEN -> Mars), then the
 * same for that one, upward until something has a position. The Earth when nothing does.
 */
export function focusTarget(
  rec: Pick<EntityRecord, 'id' | 'bodyId' | 'parentId'>,
  lookup: (id: string) => Pick<EntityRecord, 'id' | 'bodyId' | 'parentId'> | undefined,
  hasPos: (id: string) => boolean,
): FocusTarget {
  if (hasPos(rec.id)) return { id: rec.id, untracked: false };
  const seen = new Set([rec.id]);
  let cur: Pick<EntityRecord, 'id' | 'bodyId' | 'parentId'> | undefined = rec;
  for (let i = 0; i < MAX_HOPS && cur; i++) {
    const candidates: string[] = [];
    if (cur.parentId) candidates.push(cur.parentId);
    candidates.push(bodyEntityId(cur.bodyId));
    let next: Pick<EntityRecord, 'id' | 'bodyId' | 'parentId'> | undefined;
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
