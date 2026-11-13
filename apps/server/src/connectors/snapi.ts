import type { Article } from '@eio/core';
import type { Connector } from '../connector';
import type { Http } from '../http';

const BASE = 'https://api.spaceflightnewsapi.net/v4/articles/';
const GLOBAL_TTL_MS = 5 * 60_000;
const SEARCH_TTL_MS = 10 * 60_000;

type Json = Record<string, any>;

export function normalizeArticle(raw: Json): Article {
  const launchIds = (raw.launches ?? []).map((l: Json) => l.launch_id).filter(Boolean);
  return {
    id: raw.id,
    title: raw.title,
    url: raw.url,
    imageUrl: raw.image_url || undefined,
    site: raw.news_site,
    summary: raw.summary || undefined,
    publishedAt: raw.published_at,
    launchIds: launchIds.length ? launchIds : undefined,
  };
}

/** Parse a SNAPI v4 page (`{count, results: [...]}`). */
export function parseArticles(text: string): Article[] {
  const j = JSON.parse(text);
  if (!Array.isArray(j.results)) throw new Error(`unexpected SNAPI response: ${text.slice(0, 120)}`);
  return j.results.map(normalizeArticle);
}

export function newsUrl(opts: { search?: string; limit?: number } = {}): string {
  const p = new URLSearchParams({ limit: String(opts.limit ?? 20), ordering: '-published_at' });
  if (opts.search) p.set('search', opts.search);
  return `${BASE}?${p}`;
}

/** Longest search text sent to SNAPI (characters). */
export const MAX_QUERY_CHARS = 80;

/** Lower case, single spaces, at most `MAX_QUERY_CHARS`: the same text for the cache key and the request. */
export const normalizeQuery = (search: string): string => search.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_QUERY_CHARS).trim();

/**
 * Search articles (cached 10 min per query). A user-triggered `demand` request: when the limiter refuses it (20 per hour,
 * 2 s spacing) it answers from the cache, else throws `LimitedError` at once. Offline with no cache yields an empty list.
 */
export async function searchNews(http: Http, search: string, limit = 20): Promise<Article[]> {
  const q = normalizeQuery(search);
  try {
    return (await http.cachedFetch(`snapi:search:${limit}:${q}`, newsUrl({ search: q, limit }), SEARCH_TTL_MS, parseArticles, undefined, { source: 'snapi', mode: 'demand' })).value;
  } catch (err) {
    if (http.offline) return [];
    throw err;
  }
}

export const snapi: Connector = {
  id: 'snapi',
  intervalMs: GLOBAL_TTL_MS,
  startDelayMs: 1500,
  async run(ctx) {
    const { value } = await ctx.cachedFetch('snapi:global', newsUrl({ limit: 30 }), GLOBAL_TTL_MS - 10_000, parseArticles, undefined, { source: 'snapi', mode: 'poll', staleRetryMs: GLOBAL_TTL_MS });
    ctx.hub.setArticles(value);
  },
};
