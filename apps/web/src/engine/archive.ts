import { WINDOW_YEARS, archiveAnswer, msToMjd, parseMast, planArchiveAsk, type ArchiveImagesResult, type EntityRecord, type MastParsed } from '@eio/core';
import { clearBackoff, isBackedOff, readBackoff, recordFailure } from './backoff';
import { LimitedError, type Http } from './http';
import type { KvStore } from './store';

export { PER_DAY_CAP, WINDOW_YEARS, mjdToMs, msToMjd, parseMast, portalUrl, previewUrl, selectImages, type MastRow } from '@eio/core';

/**
 * Images of a body taken by one observatory, from its public archive. Only MAST (Hubble and JWST)
 * has a preview service that was checked (core `ARCHIVES`); the answer for any other observatory says why there is none. The
 * pure parts (which archive, which target name, the row parsing, newest first, the per-day de-duplication) are in core
 * `archive-images.ts`, so the web mock answers from a real response the same way.
 *
 * MAST: `Mast.Caom.Filtered` on https://mast.stsci.edu/api/v0/invoke (the JSON request goes in the `request` query parameter;
 * a GET works), filtered on `obs_collection` (HST or JWST), `dataproduct_type` image, `target_name` (case-insensitive) and
 * `t_min` (MJD) within the last years. The service cannot sort, so the window keeps the page small enough to hold all of it
 * and the newest first order is made here. `jpegURL` is a `mast:` URI of a preview jpeg, loaded by the browser straight from
 * `Download/file?uri=` (an image needs no CORS).
 *
 * The invoke call itself has no confirmed CORS headers: it goes through guarded-fetch as source `mast`, which resolves to `direct`
 * until a deployment routes it elsewhere (`net/upstream.ts`).
 */

const MAST_INVOKE = 'https://mast.stsci.edu/api/v0/invoke';
export const PAGE_SIZE = 1000;
/** A body's list is reused this long (observations arrive in the archive rarely). */
export const TTL_MS = 6 * 3_600_000;
const CACHE_VERSION = 'v1';

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

export interface ArchiveImagesOptions {
  now?: () => number;
}

export class ArchiveImagesService {
  private now: () => number;

  constructor(private deps: { store: KvStore; http: Http }, opts: ArchiveImagesOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  async get(obs: Pick<EntityRecord, 'id' | 'name' | 'aliases'>, bodyId: string): Promise<ArchiveImagesResult> {
    const t = this.now();
    const plan = planArchiveAsk(obs, bodyId, t);
    if ('done' in plan) return plan.done;
    const { spec, collection, target, base } = plan.ask;
    const { store, http } = this.deps;
    const source = 'archive-images:mast';
    const key = `archive-images:${CACHE_VERSION}:${collection}:${target}:${WINDOW_YEARS}y`;
    const gate = await readBackoff(store, source);
    if (isBackedOff(gate, t)) {
      // the source is being left alone: no request; a cached list, even a stale one, is still served (with the gate's time)
      const until = new Date(gate.notBefore).toISOString().slice(11, 16);
      const reason = `${gate.message} (next attempt ${until}Z)`;
      const row = await store.get<MastParsed>(key);
      if (row) return { ...archiveAnswer({ ...base, fetchedAt: row.fetchedAt }, spec, target, row.value), fromCache: true, reason, limitedUntil: gate.notBefore };
      return { ...base, status: 'error', reason, limitedUntil: gate.notBefore };
    }
    // OFFLINE=1 is a choice, not a failure of the source: it never closes the gate
    const fail = async (e: unknown): Promise<void> => { if (!http.offline) await recordFailure(store, source, e, t); };
    try {
      const since = t - WINDOW_YEARS * 365.25 * 86_400_000;
      const r = await http.cachedFetch<MastParsed>(key, mastUrl(collection, target, since), TTL_MS, parseMast, undefined, { source: 'mast', mode: 'demand' });
      if (r.stale && r.error) {
        if (r.limitedUntil === undefined) await fail(new Error(r.error));
      } else if (!r.fromCache) await clearBackoff(store, source);
      return { ...archiveAnswer({ ...base, fetchedAt: r.fetchedAt }, spec, target, r.value), ...(r.fromCache ? { fromCache: true } : {}) };
    } catch (err) {
      if (err instanceof LimitedError) return { ...base, status: 'error', reason: `Request limit: ${err.message}`, limitedUntil: err.retryAt };
      await fail(err);
      return { ...base, status: 'error', reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
  }
}
