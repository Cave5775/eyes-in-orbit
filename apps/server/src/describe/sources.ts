import { isTrustedDescribeUrl, type DescribeFact } from '@eio/core';

const WIKI_HOSTS = ['wikipedia.org', 'wikimedia.org', 'wikidata.org'];

/**
 * URL builders and parsers of the three description sources. Pure functions on response text so they can be tested on
 * fixtures; every parser throws a message starting `unexpected <source> response` when the shape is wrong (the health
 * classifier files that as `invalid`).
 */

const WD_API = 'https://www.wikidata.org/w/api.php';

const parseJson = (text: string, what: string): Record<string, unknown> => {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`unexpected ${what} response: not JSON`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`unexpected ${what} response: not an object`);
  return v as Record<string, unknown>;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// ---- Wikidata

/** Items whose "satellite catalog number" (P377, the NORAD id) is `norad`. */
export const wikidataSearchUrl = (norad: number): string =>
  `${WD_API}?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:P377=${norad}`)}&srlimit=5&format=json`;

/** Item ids (`Q25271`) from a `list=search` response; empty for no hit. */
export function parseWikidataSearch(text: string): string[] {
  const q = parseJson(text, 'Wikidata search').query as { search?: unknown } | undefined;
  if (!q || !Array.isArray(q.search)) throw new Error('unexpected Wikidata search response: no query.search list');
  return q.search.map((s) => str((s as { title?: unknown }).title)).filter((t): t is string => !!t && /^Q\d+$/.test(t));
}

/** Items whose English label matches `name` (for objects without a catalogue number). */
export const wikidataNameSearchUrl = (name: string): string =>
  `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&type=item&limit=5&format=json`;

export interface NameCandidate {
  id: string;
  label: string;
  description: string;
}

/** Candidates of a `wbsearchentities` response (label and description are what disambiguation reads). */
export function parseWikidataNameSearch(text: string): NameCandidate[] {
  const j = parseJson(text, 'Wikidata name search');
  if (!Array.isArray(j.search)) throw new Error('unexpected Wikidata name search response: no search list');
  const out: NameCandidate[] = [];
  for (const s of j.search as Record<string, unknown>[]) {
    const id = str(s.id);
    if (id && /^Q\d+$/.test(id)) out.push({ id, label: str(s.label) ?? '', description: str(s.description) ?? '' });
  }
  return out;
}

const SPACE_DESCRIPTION = /\b(spacecraft|space ?probe|satellite|space telescope|space station|rover|lander|orbiter|space observatory|space mission|artificial)\b/i;

/**
 * The one candidate whose label equals `name` (case-insensitive) and whose description says it is something that flies
 * in space; null when none or several qualify (never guess).
 */
export function uniqueSpaceCandidate(cands: NameCandidate[], name: string): NameCandidate | null {
  const want = name.trim().toLowerCase();
  const hits = cands.filter((c) => c.label.toLowerCase() === want && SPACE_DESCRIPTION.test(c.description));
  return hits.length === 1 ? hits[0] : null;
}

export const wikidataEntitiesUrl = (ids: string[]): string =>
  `${WD_API}?action=wbgetentities&ids=${ids.map(encodeURIComponent).join('|')}&props=claims|sitelinks|labels|descriptions&sitefilter=enwiki&languages=en&format=json`;

export interface WikidataItem {
  id: string;
  label?: string;
  description?: string;
  /** English Wikipedia article title */
  enwiki?: string;
  /** P377 satellite catalog numbers */
  norad: string[];
  /** P8913 COSPAR ids */
  cospar: string[];
}

const claimValues = (claims: Record<string, unknown> | undefined, prop: string): string[] => {
  const list = claims?.[prop];
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => (c as { mainsnak?: { datavalue?: { value?: unknown } } }).mainsnak?.datavalue?.value)
    .filter((v): v is string => typeof v === 'string');
};

export function parseWikidataEntities(text: string): WikidataItem[] {
  const j = parseJson(text, 'Wikidata entities');
  const entities = j.entities as Record<string, Record<string, unknown>> | undefined;
  if (!entities || typeof entities !== 'object') throw new Error('unexpected Wikidata entities response: no entities');
  const out: WikidataItem[] = [];
  for (const [id, e] of Object.entries(entities)) {
    if (!e || typeof e !== 'object' || e.missing !== undefined) continue;
    const labels = e.labels as Record<string, { value?: unknown }> | undefined;
    const descs = e.descriptions as Record<string, { value?: unknown }> | undefined;
    const links = e.sitelinks as Record<string, { title?: unknown }> | undefined;
    const claims = e.claims as Record<string, unknown> | undefined;
    out.push({
      id,
      label: str(labels?.en?.value),
      description: str(descs?.en?.value),
      enwiki: str(links?.enwiki?.title),
      norad: claimValues(claims, 'P377'),
      cospar: claimValues(claims, 'P8913'),
    });
  }
  return out;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Choose among items sharing a catalogue number (the ISS and its Zarya module both carry 25544). In order: the one
 * whose COSPAR id matches; the one whose label equals the object name; the only one with an English article. Null
 * when still ambiguous: a wrong description is worse than the fallback line.
 */
export function pickWikidataItem(items: WikidataItem[], who: { name: string; cospar?: string; norad?: number }): WikidataItem | null {
  const ok = who.norad === undefined ? items : items.filter((i) => i.norad.length === 0 || i.norad.includes(String(who.norad)));
  if (ok.length === 1) return ok[0];
  if (who.cospar) {
    const byCospar = ok.filter((i) => i.cospar.includes(who.cospar!));
    if (byCospar.length === 1) return byCospar[0];
  }
  const byLabel = ok.filter((i) => i.label && norm(i.label) === norm(who.name));
  if (byLabel.length === 1) return byLabel[0];
  const withArticle = ok.filter((i) => i.enwiki);
  return withArticle.length === 1 ? withArticle[0] : null;
}

export const wikidataUrl = (id: string): string => `https://www.wikidata.org/wiki/${id}`;

// ---- Wikipedia

export const wikipediaSummaryUrl = (title: string): string =>
  `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;

export const wikipediaSearchUrl = (name: string): string =>
  `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(name)}`;

export interface WikipediaSummary {
  title: string;
  text: string;
  url: string;
  blurb?: string;
  thumbnail?: { url: string; width: number; height: number };
}

/** Page summary (REST `page/summary`); null for a disambiguation page, which says nothing about one object. */
export function parseWikipediaSummary(text: string): WikipediaSummary | null {
  const j = parseJson(text, 'Wikipedia summary');
  const title = str(j.title);
  const extract = str(j.extract);
  if (!title || !extract) throw new Error('unexpected Wikipedia summary response: no title or extract');
  if (j.type === 'disambiguation') return null;
  const urls = j.content_urls as { desktop?: { page?: unknown } } | undefined;
  const given = str(urls?.desktop?.page);
  const url = given && isTrustedDescribeUrl(given, WIKI_HOSTS) ? given : `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const out: WikipediaSummary = { title, text: extract, url };
  const blurb = str(j.description);
  if (blurb) out.blurb = blurb;
  const th = j.thumbnail as { source?: unknown; width?: unknown; height?: unknown } | undefined;
  const src = str(th?.source);
  const w = num(th?.width);
  const h = num(th?.height);
  if (src && isTrustedDescribeUrl(src, WIKI_HOSTS) && w && h) out.thumbnail = { url: src, width: w, height: h };
  return out;
}

// ---- ESA DISCOS (https://discosweb.esoc.esa.int, API v2, JSON:API, bearer token)

export const DISCOS_BASE = 'https://discosweb.esoc.esa.int';

export const discosUrl = (satno: number): string =>
  `${DISCOS_BASE}/api/objects?filter=${encodeURIComponent(`eq(satno,${satno})`)}&include=operators`;

export const discosHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'discosweb-api-version': '2',
  accept: 'application/vnd.api+json',
});

export interface DiscosObject {
  url?: string;
  facts: DescribeFact[];
}

const metres = (n: number): string => `${Number(n.toFixed(2))} m`;

/**
 * Facts of the object with the given satno from a DISCOS `objects` response, or null when the catalogue has none.
 * Attribute names follow ESA's published v2 documentation; this was written without a token, so it has been checked
 * against the documented shape only (see test/fixtures/discos-object-docs-shape.json), not against a live response.
 */
export function parseDiscos(text: string): DiscosObject | null {
  const j = parseJson(text, 'DISCOS');
  if (!Array.isArray(j.data)) throw new Error('unexpected DISCOS response: no data array');
  const obj = (j.data as Record<string, unknown>[])[0];
  if (!obj) return null;
  const a = (obj.attributes ?? {}) as Record<string, unknown>;
  const facts: DescribeFact[] = [];
  const add = (label: string, value: string | undefined): void => void (value && facts.push({ label, value }));

  add('Object class', str(a.objectClass));
  const mass = num(a.mass);
  add('Mass', mass !== undefined ? `${Number(mass.toFixed(1))} kg` : undefined);
  add('Shape', str(a.shape));
  const dims = [a.width, a.height, a.depth].map(num).filter((n): n is number => n !== undefined);
  const diameter = num(a.diameter);
  if (dims.length) add('Size', dims.map(metres).join(' x '));
  else if (diameter !== undefined) add('Diameter', metres(diameter));
  const span = num(a.span);
  add('Span', span !== undefined ? metres(span) : undefined);
  const xs = num(a.xSectAvg);
  add('Mean cross-section', xs !== undefined ? `${Number(xs.toFixed(2))} m²` : undefined);

  const refs = ((obj.relationships as { operators?: { data?: unknown } } | undefined)?.operators?.data ?? []) as { id?: unknown }[];
  const included = Array.isArray(j.included) ? (j.included as Record<string, unknown>[]) : [];
  const ops = refs
    .map((r) => included.find((i) => i.type === 'operators' && i.id === r.id))
    .map((i) => str((i?.attributes as { name?: unknown } | undefined)?.name))
    .filter((n): n is string => !!n);
  add('Operator', ops.join(', ') || undefined);
  add('Mission type', str(a.missionType));
  if (typeof a.active === 'boolean') add('Status', a.active ? 'active' : 'inactive');
  add('First epoch', str(a.firstEpoch)?.slice(0, 10));
  add('Predicted decay', str(a.predDecayDate)?.slice(0, 10));

  const id = str(obj.id);
  return { url: id ? `${DISCOS_BASE}/objects/${encodeURIComponent(id)}` : undefined, facts };
}
