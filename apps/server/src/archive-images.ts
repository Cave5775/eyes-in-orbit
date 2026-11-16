import {
  ARCHIVE_IMAGE_CAP, archiveOf, mastTargetOf, type ArchiveImage, type ArchiveImagesResult, type ArchiveSpec, type EntityRecord,
} from '@eio/core';
import { clearBackoff, isBackedOff, readBackoff, recordFailure } from './backoff';
import { LimitedError, type Http } from './http';
import type { Store } from './store';

/**
 * Images of a body taken by one observatory, from its public archive (`GET /api/archive-images`). Only MAST (Hubble and JWST)
 * has a preview service that was checked (see core `ARCHIVES`); the answer for any other observatory says why there is none.
 *
 * MAST: `Mast.Caom.Filtered` on https://mast.stsci.edu/api/v0/invoke (the JSON request goes in the `request` query parameter;
 * a GET works), filtered on `obs_collection` (HST or JWST), `dataproduct_type` image, `target_name` (case-insensitive) and
 * `t_min` (MJD) within the last years. The service cannot sort, so the window keeps the page small enough to hold all of it
 * and the newest first order is made here. `jpegURL` is a `mast:` URI of a preview jpeg, loaded by the browser straight from
 * `Download/file?uri=` (an image needs no CORS).
 */

const MAST_INVOKE = 'https://mast.stsci.edu/api/v0/invoke';
const MAST_DOWNLOAD = 'https://mast.stsci.edu/api/v0.1/Download/file';
const MAST_PORTAL = 'https://mast.stsci.edu/portal/Mashup/Clients/Mast/Portal.html';
/** How far back observations are asked for, years. */
export const WINDOW_YEARS = 4;
export const PAGE_SIZE = 1000;
/** A body's list is reused this long (observations arrive in the archive rarely). */
export const TTL_MS = 6 * 3_600_000;
const CACHE_VERSION = 'v1';
/** At most this many previews of one observing day (a visit has dozens of exposures of one scene). */
export const PER_DAY_CAP = 6;

const MJD_UNIX_EPOCH = 40587;
export const mjdToMs = (mjd: number): number => Math.round((mjd - MJD_UNIX_EPOCH) * 86_400_000);
export const msToMjd = (ms: number): number => ms / 86_400_000 + MJD_UNIX_EPOCH;

export interface MastRow extends ArchiveImage {
  /** CAOM calibration level (3 = combined product, 2 = calibrated, 1 = raw) */
  calib: number;
}

const COLUMNS = 'obs_collection,instrument_name,filters,target_name,t_min,t_exptime,obs_id,obsid,jpegURL,proposal_id,calib_level';

/** The request URL: one collection, one target, observations since `sinceMs`. */
export function mastUrl(collection: string, target: string, sinceMs: number): string {
  const request = {
    service: 'Mast.Caom.Filtered', format: 'json',
    params: {
      columns: COLUMNS,
      filters: [
        { paramName: 'obs_collection', values: [collection] },
        { paramName: 'dataproduct_type', values: ['image'] },
        { paramName: 'target_name', values: [target] },
        { paramName: 't_min', values: [{ min: Math.floor(msToMjd(sinceMs)), max: 99999 }] },
      ],
    },
    pagesize: PAGE_SIZE, page: 1,
  };
  return `${MAST_INVOKE}?request=${encodeURIComponent(JSON.stringify(request))}`;
}

export const previewUrl = (jpegUri: string): string => `${MAST_DOWNLOAD}?uri=${encodeURIComponent(jpegUri)}`;
export const portalUrl = (obsId: string): string => `${MAST_PORTAL}?searchQuery=${encodeURIComponent(obsId)}`;

export interface MastParsed {
  rows: MastRow[];
  /** rows the archive matched (can exceed the page) */
  total: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Rows with a preview jpeg from a `Mast.Caom.Filtered` JSON answer. Throws on a wrong shape or a status other than COMPLETE. */
export function parseMast(text: string): MastParsed {
  let j: { status?: unknown; msg?: unknown; data?: unknown; paging?: { rowsFiltered?: unknown } };
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('MAST returned unexpected non-JSON text');
  }
  if (!j || j.status !== 'COMPLETE' || !Array.isArray(j.data)) throw new Error(`MAST returned unexpected status ${String(j?.status)}${j?.msg ? `: ${String(j.msg)}` : ''}`);
  const rows: MastRow[] = [];
  for (const d of j.data as Record<string, unknown>[]) {
    const jpeg = str(d.jpegURL), obsId = str(d.obs_id);
    if (!jpeg || !obsId || typeof d.t_min !== 'number' || !Number.isFinite(d.t_min)) continue;
    const program = d.proposal_id === undefined || d.proposal_id === null ? '' : String(d.proposal_id).trim();
    rows.push({
      id: obsId, thumbUrl: previewUrl(jpeg), fullUrl: previewUrl(jpeg), pageUrl: portalUrl(obsId), tMs: mjdToMs(d.t_min),
      instrument: str(d.instrument_name), filters: str(d.filters),
      ...(typeof d.t_exptime === 'number' ? { exposureS: d.t_exptime } : {}),
      ...(program ? { program } : {}),
      calib: typeof d.calib_level === 'number' ? d.calib_level : 0,
    });
  }
  const total = typeof j.paging?.rowsFiltered === 'number' ? j.paging.rowsFiltered : j.data.length;
  return { rows, total };
}

const day = (tMs: number): number => Math.floor(tMs / 86_400_000);

/**
 * Newest first, near-identical exposures removed: one row per day, instrument and filter (the same scene exposed again; the
 * higher calibration level wins, then the longer exposure), then at most `PER_DAY_CAP` of one day, at most `cap` rows.
 */
export function selectImages(rows: readonly MastRow[], cap = ARCHIVE_IMAGE_CAP): ArchiveImage[] {
  const best = new Map<string, MastRow>();
  for (const r of rows) {
    const k = `${day(r.tMs)}|${r.instrument}|${r.filters}`;
    const b = best.get(k);
    if (!b || r.calib > b.calib || (r.calib === b.calib && (r.exposureS ?? 0) > (b.exposureS ?? 0))) best.set(k, r);
  }
  const sorted = [...best.values()].sort((a, b) => b.tMs - a.tMs || (a.id < b.id ? -1 : 1));
  const perDay = new Map<number, number>();
  const out: ArchiveImage[] = [];
  for (const r of sorted) {
    const d = day(r.tMs), n = perDay.get(d) ?? 0;
    if (n >= PER_DAY_CAP) continue;
    perDay.set(d, n + 1);
    const { calib: _calib, ...img } = r;
    out.push(img);
    if (out.length >= cap) break;
  }
  return out;
}

const cap1 = (s: string): string => s.charAt(0) + s.slice(1).toLowerCase();

export interface ArchiveImagesOptions {
  now?: () => number;
}

export class ArchiveImagesService {
  private now: () => number;

  constructor(private deps: { store: Store; http: Http }, opts: ArchiveImagesOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  async get(obs: Pick<EntityRecord, 'id' | 'name' | 'aliases'>, bodyId: string): Promise<ArchiveImagesResult> {
    const body = bodyId.toUpperCase();
    const base: ArchiveImagesResult = { observatoryId: obs.id, observatory: obs.name, body, archive: null, status: 'unsupported', images: [], fetchedAt: this.now() };
    const spec = archiveOf(obs);
    if (!spec) return { ...base, reason: `No public image archive is mapped to ${obs.name}.` };
    const archive = { id: spec.id, label: spec.label, url: spec.url };
    if (!spec.mastCollection) return { ...base, archive, reason: spec.unsupported ?? `${spec.label} has no public preview service here.` };
    const target = mastTargetOf(body);
    if (!target) return { ...base, archive, status: 'none', reason: `${spec.label} holds no images of ${cap1(body)} as an observation target.` };
    return this.mast(base, spec, archive, target);
  }

  private async mast(base: ArchiveImagesResult, spec: ArchiveSpec, archive: ArchiveImagesResult['archive'], target: string): Promise<ArchiveImagesResult> {
    const { store, http } = this.deps;
    const collection = spec.mastCollection!;
    const source = 'archive-images:mast';
    const t = this.now();
    const key = `archive-images:${CACHE_VERSION}:${collection}:${target}:${WINDOW_YEARS}y`;
    const gate = readBackoff(store, source);
    if (isBackedOff(gate, t) && !store.get(key)) {
      const until = new Date(gate.notBefore).toISOString().slice(11, 16);
      return { ...base, archive, status: 'error', reason: `${gate.message} (next attempt ${until}Z)`, limitedUntil: gate.notBefore };
    }
    try {
      const since = t - WINDOW_YEARS * 365.25 * 86_400_000;
      const r = await http.cachedFetch(key, mastUrl(collection, target, since), TTL_MS, parseMast, undefined, { source: 'mast', mode: 'demand' });
      if (r.stale && r.error) {
        if (r.limitedUntil === undefined) recordFailure(store, source, new Error(r.error), t);
      } else if (!r.fromCache) clearBackoff(store, source);
      const images = selectImages(r.value.rows);
      const out: ArchiveImagesResult = { ...base, archive, images, total: r.value.total, fetchedAt: r.fetchedAt, ...(r.fromCache ? { fromCache: true } : {}) };
      if (images.length) return { ...out, status: 'ok' };
      return { ...out, status: 'none', reason: `${spec.label} has no preview images of ${cap1(target)} from the last ${WINDOW_YEARS} years.` };
    } catch (err) {
      if (err instanceof LimitedError) return { ...base, archive, status: 'error', reason: `Request limit: ${err.message}`, limitedUntil: err.retryAt };
      recordFailure(store, source, err, t);
      return { ...base, archive, status: 'error', reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
  }
}
