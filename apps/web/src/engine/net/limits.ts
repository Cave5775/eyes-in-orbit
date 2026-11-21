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
  /**
   * The host's block answers (403/429 from a CDN) carry no CORS headers, so the browser hides them behind a bare fetch
   * `TypeError`. For these sources such a failure while online counts as an answer (a failed response for `failureStop` and
   * `backoff`) instead of an ignorable network error; otherwise the app would keep retrying a host that blocks it.
   */
  opaqueIsAnswer?: boolean;
}

const MIN = 60_000, HOUR = 3_600_000;

export const LIMITS: Record<string, SourceLimit> = {
  // https://celestrak.org/usage-policy.php : one download per group per 3 h (cache TTL), stop after repeated non-200 answers
  celestrak: {
    label: 'CelesTrak', policy: 'https://celestrak.org/usage-policy.php',
    minSpacingMs: 2000, perHour: 15, opaqueIsAnswer: true,
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
    minSpacingMs: 1500, perHour: 600, perDay: 5000, opaqueIsAnswer: true,
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
  // MAST archive queries for the Sky view's image card (engine/archive-images.ts): on demand only, cached 6 h per body
  mast: {
    label: 'MAST archive (STScI)', policy: 'unpublished',
    minSpacingMs: 1500, perHour: 60, demandPerHour: 40,
    blockOn: { 429: 15 * MIN, 503: 15 * MIN },
  },
  // NASA MMGIS waypoint layers (engine/connectors/surface-sites.ts): two ~600 kB files every 6 h (cache TTL). A missing key answers 403 (S3 behind CloudFront), so 403 also blocks
  mmgis: {
    label: 'NASA MMGIS rover waypoints', policy: 'unpublished (NASA public data, https://github.com/NASA-AMMOS/MMGIS)',
    minSpacingMs: 1500, perHour: 8,
    blockOn: { 403: 6 * HOUR, 429: 3 * HOUR },
    backoff: { baseMs: 30 * MIN, maxMs: 12 * HOUR },
  },
  // NASA MMGIS map tiles for the Mars surface patch (engine/mmgis-tiles.ts): on demand, kept in IndexedDB for 90 days, so a
  // tile is asked for once. Static files on S3 behind CloudFront: 4 per second at most (2 at a time), 1200 per hour; 429/503 block,
  // server errors and network failures back off from 1 min to 1 h. A 403/404 is a tile S3 does not have (clipped or sparse mosaic
  // edges): it counts for nothing here and only goes to the per-tile negative cache in mmgis-tiles.ts
  'mmgis-tiles': {
    label: 'NASA MMGIS map tiles', policy: 'unpublished (NASA public data, https://github.com/NASA-AMMOS/MMGIS)',
    minSpacingMs: 250, perHour: 1200, maxWaitMs: 2000,
    blockOn: { 429: 15 * MIN, 503: 15 * MIN },
    backoff: { baseMs: MIN, maxMs: HOUR, statuses: [500, 502, 503, 504] },
  },
  // Minor Planet Center MPCORB (engine/connectors/minor-planets.ts): one ~70 MB gz download a month (cache TTL 30 days, conditional
  // request), so 2 attempts an hour is far more than needed; 403/429/503 block for hours, failures back off from 1 h to 12 h
  mpcorb: {
    label: 'Minor Planet Center MPCORB', policy: 'unpublished (https://www.minorplanetcenter.net/iau/MPCORB.html: the file is updated daily, software may include it with the header and credit)',
    minSpacingMs: 60_000, perHour: 2, perDay: 6, maxWaitMs: 0, opaqueIsAnswer: true,
    blockOn: { 403: 6 * HOUR, 429: 6 * HOUR, 503: 3 * HOUR },
    backoff: { baseMs: HOUR, maxMs: 12 * HOUR },
  },
  // the HEAD staleness check of the same download (engine/connectors/minor-planets.ts): its own source so the GET after it is not held back by the 60 s spacing above
  'mpcorb-head': {
    label: 'Minor Planet Center MPCORB (HEAD)', policy: 'unpublished',
    minSpacingMs: 5000, perHour: 4, perDay: 12, maxWaitMs: 0,
    blockOn: { 403: 6 * HOUR, 429: 6 * HOUR, 503: 3 * HOUR },
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
  if (is('mast.stsci.edu')) return 'mast';
  if (is('mars.nasa.gov')) return 'mmgis';
  if (is('minorplanetcenter.net') || is('minorplanetcenter.org')) return 'mpcorb';
  return 'other';
}

/** The source whose limit a connector or describe feed shows in its health record. */
export const FEED_SOURCE: Record<string, string> = {
  celestrak: 'celestrak', spacetrack: 'spacetrack:query', launchlibrary: 'll2', snapi: 'snapi', dsn: 'dsn',
  horizons: 'horizons', 'horizons-bodies': 'horizons', 'iss-rest': 'wheretheiss', 'iss-live': 'iss-live',
  wikipedia: 'wikimedia', discos: 'discos', 'surface-sites': 'mmgis', 'minor-planets': 'mpcorb',
};
