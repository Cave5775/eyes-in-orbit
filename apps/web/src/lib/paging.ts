import type { EntityRecord } from '@eio/core';

/**
 * Paged loading of the entity catalogue (`api.entities({ limit, offset })`, docs/CONTRACT.md). One unpaged answer for a
 * million objects is a document of about a gigabyte that must be built, sent and parsed whole; pages are a few MB each, the
 * first is on screen while the rest arrive, and a failure in the middle keeps what was already loaded.
 *
 * The store copies its catalogue map on every commit (a new reference is what tells the UI something changed) and the scene
 * reconciles the whole catalogue on every change, so committing every page would cost O(pages x catalogue). Commits follow a
 * doubling schedule instead: the first page at once, then whenever the records waiting are as many as those already committed
 * (20 k, 40 k, 80 k ...). Total work stays about twice one commit of the whole catalogue, and the screen still fills
 * progressively.
 */

/** Records per page requested (the server caps a page at 50,000). */
export const PAGE_SIZE = 20_000;

export interface CatalogPage {
  serverTime: number;
  entities: EntityRecord[];
  /** offset of the next page; absent on the last */
  next?: number;
  total?: number;
}

export interface PagedLoad {
  /** `serverTime` of the FIRST page: the cursor for the next `since` request, so changes made while paging are fetched next time */
  serverTime: number;
  count: number;
  pages: number;
  commits: number;
  total?: number;
}

export interface PagedOptions {
  /** records per page (informational: the caller's `fetchPage` sends it) */
  pageSize?: number;
  /** stop with an error after this many pages (a server that never ends its list) */
  maxPages?: number;
  /** progress after every page: records loaded so far and the total when the server said it */
  onProgress?: (loaded: number, total: number | undefined) => void;
}

/**
 * Fetch pages until the server stops saying `next`, handing records to `commit` on the doubling schedule (`first` is true for
 * the first commit: the caller replaces its catalogue then, merges afterwards). A page that fails (or a `next` that does not
 * advance) commits what is waiting and rethrows, so the caller keeps a partial catalogue and knows the load did not finish.
 */
export async function loadPaged(
  fetchPage: (offset: number) => Promise<CatalogPage>,
  commit: (records: EntityRecord[], first: boolean, serverTime: number) => void,
  opts: PagedOptions = {},
): Promise<PagedLoad> {
  const maxPages = opts.maxPages ?? 100_000;
  let offset = 0;
  let serverTime = 0;
  let total: number | undefined;
  let pending: EntityRecord[] = [];
  let committed = 0;
  let loaded = 0;
  let pages = 0;
  let commits = 0;
  const flush = () => {
    if (!pending.length && commits > 0) return;
    commit(pending, commits === 0, serverTime);
    commits++;
    committed += pending.length;
    pending = [];
  };
  try {
    for (;;) {
      const page = await fetchPage(offset);
      if (pages === 0) {
        serverTime = page.serverTime;
        total = page.total;
      }
      pages++;
      for (const r of page.entities) pending.push(r);
      loaded += page.entities.length;
      opts.onProgress?.(loaded, total);
      if (page.next === undefined) break;
      if (!(page.next > offset)) throw new Error(`paging does not advance: next ${page.next} after offset ${offset}`);
      if (pages >= maxPages) throw new Error(`more than ${maxPages} pages`);
      offset = page.next;
      // the first page, then each time the waiting records equal those already shown
      if (commits === 0 || pending.length >= committed) flush();
    }
  } catch (err) {
    flush();
    throw err;
  }
  flush();
  return { serverTime, count: loaded, pages, commits, total };
}

/** The slice of `items` for `offset` / `limit` and the next offset (absent at the end): what the server does, for the offline mock. */
export function pageSlice<T>(items: readonly T[], offset = 0, limit?: number): { items: T[]; next?: number } {
  const from = Math.max(0, Math.floor(offset));
  if (!limit || limit <= 0) return { items: from ? items.slice(from) : [...items] };
  const to = from + Math.floor(limit);
  const out = items.slice(from, to);
  return to < items.length ? { items: out, next: to } : { items: out };
}
