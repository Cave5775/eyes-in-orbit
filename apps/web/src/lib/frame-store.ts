import { defaultBodies, isBodyEntity, orbitableBodyId, type EntityRecord } from '@eio/core';
import { EARTH_CENTRE, bodyCentre, type Centre } from './frame';

/**
 * Pure helpers behind the frame in the store (docs/frames.md): what selecting an entity does to the frame, and how the
 * frame is remembered in `localStorage['eio.frame']`. The lock is deliberately not remembered: it is always off on load.
 */

export const FRAME_STORAGE_KEY = 'eio.frame';

/** What the frame needs of a record: enough to tell a body entity from an object and to find the registry body. */
export type FrameRec = Pick<EntityRecord, 'id' | 'provider' | 'attrs'>;

/**
 * The frame a selection asks for: the body a body entity stands for (`body-earth` -> Earth, the same as the Earth tab), or
 * null when selecting must not touch the frame: an ordinary object, a locked frame, nothing selected, or an entity whose
 * `orbitableBodyId` is not a registry body.
 */
export function frameOnSelect(rec: FrameRec | undefined, locked: boolean): Centre | null {
  if (!rec || locked) return null;
  const id = orbitableBodyId(rec);
  return id !== undefined && defaultBodies.has(id) ? bodyCentre(id) : null;
}

/** JSON of a centre as it is stored: `{"kind":"body","id":"MOON"}`. */
export const serialiseFrame = (c: Centre): string => JSON.stringify({ kind: c.kind, id: c.id });

/** The stored centre, or null for anything missing, malformed or of the wrong shape. */
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
  return { kind, id };
}

/**
 * The frame to restore once the catalog is loaded: a body centre must be a registry body, an entity centre must exist in
 * the catalog (a body entity becomes the body centre it stands for); anything unknown or stale (a removed entity, a body
 * that is gone) falls back to the Earth. `parsed` null (nothing stored) is the Earth too.
 */
export function resolveFrame(parsed: Centre | null, entity: (id: string) => FrameRec | undefined): Centre {
  if (!parsed) return EARTH_CENTRE;
  if (parsed.kind === 'body') return defaultBodies.has(parsed.id) ? parsed : EARTH_CENTRE;
  const rec = entity(parsed.id);
  if (!rec) return EARTH_CENTRE;
  if (isBodyEntity(rec)) {
    const bid = orbitableBodyId(rec);
    return bid !== undefined && defaultBodies.has(bid) ? bodyCentre(bid) : EARTH_CENTRE;
  }
  return parsed;
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
