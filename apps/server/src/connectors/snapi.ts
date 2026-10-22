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

/** Search articles (cached 10 min per query). Offline with no cache yields an empty list. */
export async function searchNews(http: Http, search: string, limit = 20): Promise<Article[]> {
  const q = search.trim().toLowerCase();
  try {
    return (await http.cachedFetch(`snapi:search:${limit}:${q}`, newsUrl({ search, limit }), SEARCH_TTL_MS, parseArticles)).value;
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
    const { value } = await ctx.cachedFetch('snapi:global', newsUrl({ limit: 30 }), GLOBAL_TTL_MS - 10_000, parseArticles);
    ctx.hub.setArticles(value);
  },
};
