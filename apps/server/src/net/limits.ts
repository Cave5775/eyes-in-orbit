/**
 * Per-source request limits: the published limit (with the page that states it) and the cap this app enforces below it.
 * Every outgoing request goes through `net/limiter.ts`, which reads this table. "unpublished" means the source states no
 * number; the cap is then a conservative choice made here. A source not listed falls back to `other`.
 */
export interface SourceLimit {
  label: string;
  /** where the published limit is stated, or `unpublished` */
  policy: string;
  /** minimum gap between two requests (ms) */
  minSpacingMs: number;
  /** attempts per minute / hour / day, counted per attempt (before the request is sent) */
  perMinute?: number;
  perHour?: number;
  perDay?: number;
  /** extra hourly cap for `demand` calls (user-triggered lookups), on top of the total `perHour` */
  demandPerHour?: number;
  /** HTTP status -> shortest block (ms) when the source answers it; a longer Retry-After wins */
  blockOn?: Record<number, number>;
  /** after `count` failed responses within `windowMs` stop for `blockMs` */
  failureStop?: { count: number; windowMs: number; blockMs: number };
  /** exponential block after failures: base * 2^(n-1), at most `maxMs`; `statuses` limits it to those HTTP statuses (network errors always count) */
  backoff?: { baseMs: number; maxMs: number; statuses?: number[] };
  /** longest wait a poll caller sits out for the spacing gap (default 15 s); longer gaps are rescheduled */
  maxWaitMs?: number;
}

const MIN = 60_000, HOUR = 3_600_000;

export const LIMITS: Record<string, SourceLimit> = {
  // https://celestrak.org/usage-policy.php : one download per group per 3 h (cache TTL), stop after repeated non-200 answers
  celestrak: {
    label: 'CelesTrak', policy: 'https://celestrak.org/usage-policy.php',
    minSpacingMs: 2000, perHour: 15,
    blockOn: { 403: 3 * HOUR, 429: 3 * HOUR },
    failureStop: { count: 3, windowMs: 2 * HOUR, blockMs: 24 * HOUR },
  },
  // https://www.space-track.org/documentation : < 30 requests/min and < 300/h; we ask far less
  'spacetrack:login': {
    label: 'Space-Track login', policy: 'https://www.space-track.org/documentation',
    minSpacingMs: 5000, perHour: 4,
  },
  'spacetrack:query': {
    label: 'Space-Track GP query', policy: 'https://www.space-track.org/documentation',
    minSpacingMs: 2 * HOUR, perDay: 12,
    blockOn: { 403: 6 * HOUR, 429: 6 * HOUR },
  },
  'spacetrack:logout': {
    label: 'Space-Track logout', policy: 'https://www.space-track.org/documentation',
    minSpacingMs: 1000, perHour: 8,
  },
  // https://thespacedevs.com/llapi : 15 requests/h on the free tier
  ll2: {
    label: 'Launch Library 2', policy: 'https://thespacedevs.com/llapi',
    minSpacingMs: 1000, perHour: 7,
    blockOn: { 429: HOUR },
  },
  snapi: {
    label: 'Spaceflight News API', policy: 'unpublished',
    minSpacingMs: 2000, perHour: 32, demandPerHour: 20,
    blockOn: { 429: 15 * MIN },
  },
  dsn: {
    label: 'DSN Now', policy: 'unpublished',
    minSpacingMs: 4000, perHour: 800,
    backoff: { baseMs: 30_000, maxMs: 10 * MIN },
  },
  horizons: {
    label: 'JPL Horizons', policy: 'unpublished (HTTP 503 = overloaded)',
    minSpacingMs: 1500, perHour: 120,
    blockOn: { 503: 15 * MIN, 429: 15 * MIN },
  },
  // https://wheretheiss.at/w/developer : about one request per second
  wheretheiss: {
    label: 'wheretheiss.at', policy: 'https://wheretheiss.at/w/developer',
    minSpacingMs: 1500, perHour: 1900,
    blockOn: { 429: 5 * MIN },
  },
  'iss-live': {
    label: 'ISS Lightstreamer', policy: 'unpublished',
    minSpacingMs: 30_000, perHour: 12, maxWaitMs: 0,
    blockOn: { 403: 15 * MIN, 429: 15 * MIN },
  },
  // https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits and the Wikimedia User-Agent policy
  wikimedia: {
    label: 'Wikidata / Wikipedia', policy: 'https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits',
    minSpacingMs: 1500, perHour: 600, perDay: 5000,
    blockOn: { 429: 5000 },
    backoff: { baseMs: 5000, maxMs: 15 * MIN, statuses: [429] },
  },
  discos: {
    label: 'ESA DISCOS', policy: 'unpublished',
    minSpacingMs: 1000, perMinute: 10, perHour: 200,
    blockOn: { 429: 5 * MIN },
  },
  // 4 at a time is the ImageryCache queue; the rate is 5 per second
  gibs: {
    label: 'NASA GIBS imagery', policy: 'unpublished',
    minSpacingMs: 200, perHour: 1000, maxWaitMs: 1000,
    blockOn: { 429: 15 * MIN, 503: 15 * MIN },
  },
  other: { label: 'Other hosts', policy: 'unpublished', minSpacingMs: 1000, perHour: 120 },
};

/** The source a URL belongs to (host table); `other` when none matches. */
export function sourceForUrl(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch { /* other */ }
  const is = (d: string) => host === d || host.endsWith(`.${d}`);
  if (is('celestrak.org')) return 'celestrak';
  if (is('space-track.org')) return 'spacetrack:query';
  if (is('thespacedevs.com')) return 'll2';
  if (is('spaceflightnewsapi.net')) return 'snapi';
  if (is('eyes.nasa.gov')) return 'dsn';
  if (is('ssd.jpl.nasa.gov')) return 'horizons';
  if (is('wheretheiss.at')) return 'wheretheiss';
  if (is('wikipedia.org') || is('wikidata.org')) return 'wikimedia';
  if (is('esoc.esa.int')) return 'discos';
  if (is('gibs.earthdata.nasa.gov')) return 'gibs';
  return 'other';
}

/** The source whose limit a connector or describe feed shows in its health record. */
export const FEED_SOURCE: Record<string, string> = {
  celestrak: 'celestrak', spacetrack: 'spacetrack:query', launchlibrary: 'll2', snapi: 'snapi', dsn: 'dsn',
  horizons: 'horizons', 'horizons-bodies': 'horizons', 'iss-rest': 'wheretheiss', 'iss-live': 'iss-live',
  wikipedia: 'wikimedia', discos: 'discos',
};
