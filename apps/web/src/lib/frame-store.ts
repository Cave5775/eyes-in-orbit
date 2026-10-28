import { bodyEntityId, isOrbitable, type EntityRecord } from '@eio/core';
import { EARTH_CENTRE, type Centre } from './frame';

/**
 * Pure helpers behind the frame in the store (docs/frames.md): what selecting an entity does to the frame, and how the
 * frame is remembered in `localStorage['eio.frame']`. The lock is deliberately not remembered: it is always off on load.
 */

export const FRAME_STORAGE_KEY = 'eio.frame';

/** What the frame needs of a record: its id, and enough to tell whether it can be a frame. */
export type FrameRec = Pick<EntityRecord, 'id' | 'provider' | 'attrs'>;

/**
 * The frame a selection asks for: the entity itself when it is orbitable (a body entity, or `attrs.orbitable === true`), or
 * null when selecting must not touch the frame: a plain object, a locked frame, nothing selected.
 */
export function frameOnSelect(rec: FrameRec | undefined, locked: boolean): Centre | null {
  if (!rec || locked || !isOrbitable(rec)) return null;
  return rec.id;
}

/**
 * JSON of a frame as it is stored: `{"kind":"entity","id":"body-moon"}`. That is the shape the previous format used for an
 * entity centre, so an older build still reads it (it turns a body entity into the body centre it stands for).
 */
export const serialiseFrame = (c: Centre): string => JSON.stringify({ kind: 'entity', id: c });

/**
 * The stored centre as an entity id, or null for anything missing, malformed or of the wrong shape. The previous format also
 * stored a body by registry id, `{"kind":"body","id":"MARS"}`: that reads as `body-mars` (migration).
 */
export function parseFrame(raw: string | null | undefined): Centre | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const { kind, id } = o as Record<string, unknown>;
  if ((kind !== 'body' && kind !== 'entity') || typeof id !== 'string' || id === '') return null;
  return kind === 'body' ? bodyEntityId(id) : id;
}

/**
 * The frame to restore once the catalog is loaded: the entity must exist in the catalog; anything unknown or stale (a removed
 * entity, a body that is gone) falls back to the Earth. `parsed` null (nothing stored) is the Earth too.
 */
export function resolveFrame(parsed: Centre | null, entity: (id: string) => FrameRec | undefined): Centre {
  return parsed && entity(parsed) ? parsed : EARTH_CENTRE;
}

/** Minimal slice of the Web Storage interface. */
export interface FrameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): FrameStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The remembered frame, null when nothing usable is stored or storage is unavailable. */
export function loadFrame(storage: FrameStorage | null | undefined = defaultStorage()): Centre | null {
  try {
    return parseFrame(storage?.getItem(FRAME_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Remember the frame; false when storage is unavailable or full. */
export function saveFrame(c: Centre, storage: FrameStorage | null | undefined = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(FRAME_STORAGE_KEY, serialiseFrame(c));
    return true;
  } catch {
    return false;
  }
}
