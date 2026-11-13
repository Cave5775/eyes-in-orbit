import type { EntityRecord } from './types';

/** Outcome of one source in a description lookup. */
export type DescribeSourceState = 'ok' | 'miss' | 'off' | 'error' | 'limited';

/** One line of the DISCOS facts table. */
export interface DescribeFact {
  label: string;
  value: string;
}

/**
 * What `GET /api/describe/:entityId` returns: a text description of one object assembled on demand from Wikipedia
 * (found through Wikidata), ESA DISCOS facts (needs a token) and, always, a line built from the catalogue fields the
 * entity already carries.
 */
export interface Description {
  entityId: string;
  /** NORAD catalogue number the lookups used, when the entity has one */
  norad?: number;
  /** Wikipedia article summary */
  summary?: {
    title: string;
    text: string;
    url: string;
    /** short Wikidata description, e.g. "modular space station in low Earth orbit" */
    blurb?: string;
    thumbnail?: { url: string; width: number; height: number };
  };
  wikidata?: { id: string; url: string; label?: string };
  discos?: { url?: string; facts: DescribeFact[] };
  /** always present: composed from the entity's own catalogue fields */
  fallback: string;
  /** Wikipedia search for the object name, for when nothing was matched */
  searchUrl: string;
  sources: { wikidata: DescribeSourceState; wikipedia: DescribeSourceState; discos: DescribeSourceState };
  /** ms since epoch when the lookup ran (cache rows keep the original time) */
  fetchedAt: number;
  /** served from the local cache */
  fromCache?: boolean;
  /**
   * A source was not asked because its request limit applies (a source state is `limited`): ms since epoch when asking
   * is possible again. A description with this field is never cached; the About tab shows "rate limited, try again at HH:MM".
   */
  limitedUntil?: number;
}

const noradOf = (rec: EntityRecord): number | undefined => {
  const n = Number(rec.aliases?.norad);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** The launch year from a COSPAR designator such as `1998-067A`. */
const launchYear = (cospar?: string): number | undefined => {
  const m = /^(\d{4})-\d{3}/.exec(cospar ?? '');
  return m ? Number(m[1]) : undefined;
};

const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/**
 * One sentence from what the entity itself carries (name, kind, group, NORAD and COSPAR ids). It states no fact the
 * catalogue does not hold: CelesTrak element sets carry no owner, country or launch site, only the designator, whose
 * first four digits are the launch year.
 */
export function composeFallback(rec: EntityRecord): string {
  const kind = rec.kind.replace(/_/g, ' ');
  const norad = noradOf(rec);
  const cospar = rec.aliases?.cospar;
  const year = launchYear(cospar);
  let s = `${rec.name} is ${article(kind)} ${kind}`;
  if (rec.group) s += ` in the "${rec.group}" group`;
  if (year) s += `, launched in ${year}`;
  s += '.';
  const ids: string[] = [];
  if (cospar) ids.push(`international designator ${cospar}`);
  if (norad) ids.push(`NORAD catalogue number ${norad}`);
  if (ids.length) s += ` ${ids.join(', ').replace(/^./, (c) => c.toUpperCase())}.`;
  const attrs = rec.attrs ? Object.entries(rec.attrs).filter(([, v]) => typeof v === 'string' && v) : [];
  const owner = attrs.find(([k]) => /^(owner|country|operator)$/i.test(k));
  if (owner) s += ` ${owner[0][0].toUpperCase()}${owner[0].slice(1)}: ${owner[1]}.`;
  return s;
}

/** Hosts (and their subdomains) a description may link to or load pictures from. */
export const DESCRIBE_HOSTS: readonly string[] = ['wikipedia.org', 'wikimedia.org', 'wikidata.org', 'discosweb.esoc.esa.int'];

/** True for an https URL whose host is one of `hosts` or a subdomain of one: nothing else is rendered as a link or image. */
export function isTrustedDescribeUrl(url: unknown, hosts: readonly string[] = DESCRIBE_HOSTS): boolean {
  if (typeof url !== 'string') return false;
  // https://host[:port][/?#...] with no credentials; the core package has no URL class (no DOM lib)
  const m = /^https:\/\/([a-z0-9.-]+)(?::\d+)?(?:[/?#]|$)/i.exec(url);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}
