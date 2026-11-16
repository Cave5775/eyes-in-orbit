import { bodyOf, type ArchiveImage, type ArchiveImagesResult, type EntityRecord } from '@eio/core';

/**
 * The pure parts of the archive image card of the Sky view (ui/SkyArchive.tsx): which selection gets one, its title, the text of
 * each state, the caption of a picture, the lightbox stepping and the per-session reuse of an answer.
 */

/** The body whose images the card shows for the selected entity: a star, planet or dwarf planet, or the Moon; null for anything else (a satellite, a probe, the Earth, another moon). */
export function cardBody(rec: Pick<EntityRecord, 'kind' | 'provider'> | undefined): string | null {
  if (!rec) return null;
  const id = bodyOf(rec);
  if (id === undefined || id === 'EARTH') return null;
  return rec.kind === 'star' || rec.kind === 'planet' || rec.kind === 'dwarf_planet' || id === 'MOON' ? id : null;
}

/** MAST has one preview size (19 to 102 kB measured, about 2000 px): the card loads this many at first and this many more per click, so opening it never fetches all 24 at once. */
export const THUMBS_FIRST = 8;
export const MORE_STEP = 8;

export const cardTitle = (bodyName: string, observatoryName: string): string => `${bodyName} by ${observatoryName}`;

export type CardView =
  | { kind: 'loading'; text: string }
  | { kind: 'ok'; images: ArchiveImage[]; text: string }
  | { kind: 'none'; text: string }
  | { kind: 'unsupported'; text: string }
  | { kind: 'error'; text: string };

const hhmmZ = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)}Z`;

/** What the card shows: `result` is the server's answer, `error` a failed request, neither means it is still loading. */
export function cardView(observatoryName: string, result: ArchiveImagesResult | null, error: string | null): CardView {
  if (error) return { kind: 'error', text: `The archive could not be reached: ${error}` };
  if (!result) return { kind: 'loading', text: 'Looking up images...' };
  if (result.status === 'ok') {
    const n = result.images.length;
    return { kind: 'ok', images: result.images, text: `${n} image${n === 1 ? '' : 's'}, newest first${result.archive ? `, from ${result.archive.label}` : ''}` };
  }
  if (result.status === 'unsupported') return { kind: 'unsupported', text: `${observatoryName}'s archive has no public preview service here.` };
  if (result.status === 'none') return { kind: 'none', text: result.reason ?? 'No images found.' };
  const until = result.limitedUntil !== undefined ? ` Try again at ${hhmmZ(result.limitedUntil)}.` : '';
  return { kind: 'error', text: `${result.reason ?? 'The archive did not answer.'}${until}` };
}

/** `2024-01-12`, UTC. */
export const dateOf = (tMs: number): string => new Date(tMs).toISOString().slice(0, 10);

const exposure = (s: number): string => (s >= 100 ? `${Math.round(s)} s` : `${Number(s.toFixed(1))} s`);

/** The caption of a picture: date, instrument, filter and exposure, in that order, what is known. */
export function captionOf(img: ArchiveImage): string {
  return [dateOf(img.tMs), img.instrument, img.filters, img.exposureS !== undefined ? exposure(img.exposureS) : ''].filter(Boolean).join('  ·  ');
}

/** The lightbox index after a step, wrapping at both ends; -1 stays -1 (closed). */
export function stepIndex(i: number, n: number, dir: 1 | -1): number {
  if (i < 0 || n <= 0) return -1;
  return (i + dir + n) % n;
}

/**
 * Answers per (observatory, body), reused for `reuseMs`: a second click on the same planet never asks again, and concurrent asks
 * share one request. A failed request is forgotten at once (the next click asks again; the server has its own limits).
 */
export function createArchiveCache(
  load: (observatoryId: string, bodyId: string) => Promise<ArchiveImagesResult>, opts: { now?: () => number; reuseMs?: number } = {},
) {
  const now = opts.now ?? Date.now;
  const reuseMs = opts.reuseMs ?? 5 * 60_000;
  const entries = new Map<string, { promise: Promise<ArchiveImagesResult>; at: number }>();
  return {
    get(observatoryId: string, bodyId: string): Promise<ArchiveImagesResult> {
      const k = `${observatoryId}|${bodyId}`;
      const hit = entries.get(k);
      if (hit && now() - hit.at < reuseMs) return hit.promise;
      const entry = { promise: load(observatoryId, bodyId), at: now() };
      entries.set(k, entry);
      entry.promise.then(
        (r) => {
          if (r.status === 'error' && entries.get(k) === entry) entries.delete(k);
          else entry.at = now();
        },
        () => { if (entries.get(k) === entry) entries.delete(k); },
      );
      return entry.promise;
    },
    clear: () => entries.clear(),
  };
}
