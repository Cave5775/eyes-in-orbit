import type { ConnectorHealth } from './feeds';

/**
 * How a datafeed is doing, in the four states the UI colours:
 * ok = green, orange = degraded (data still available or the cause is temporary), red = nothing usable is arriving,
 * off = grey (disabled, OFFLINE mode, a stub, not started).
 */
export type FeedLevel = 'ok' | 'orange' | 'red' | 'off';

/** Why the feed has this level. One code per cause; the UI turns it into words. */
export type FeedReason =
  | 'ok'
  | 'idle'
  | 'disabled'
  | 'offline'
  | 'stub'
  | 'no-credentials'
  | 'partial'
  | 'backoff'
  | 'rate-limited'
  | 'timeout'
  | 'server-error'
  | 'no-ephemeris'
  | 'stale'
  | 'blocked'
  | 'unreachable'
  | 'auth'
  | 'invalid'
  | 'repeated'
  | 'error';

export interface FeedState {
  level: FeedLevel;
  reason: FeedReason;
  /** the text to show next to the reason: the last error for a failing or degraded feed, else the connector's note */
  note?: string;
  /** retry time in UTC (`14:30Z`) when the message says the feed is waiting for one */
  retryUtc?: string;
  /** an earlier run delivered data that the app still holds */
  hasData: boolean;
}

/** Consecutive failed runs after which a feed that never delivered anything is red whatever the cause. */
export const REPEATED_FAILURES = 3;

/** What went wrong, read from an error message as the connectors and `http.ts` write them. `error` = unrecognised. */
export type FeedCause = Extract<FeedReason, 'rate-limited' | 'timeout' | 'server-error' | 'no-ephemeris' | 'blocked' | 'unreachable' | 'auth' | 'invalid' | 'offline' | 'error'>;

export function classifyCause(message: string | undefined): FeedCause {
  const m = message ?? '';
  if (/\bHTTP (401|407)\b|login (failed|returned no session)|SPACETRACK_(USER|PASSWORD)|\b(token|credentials?|api key)\b.*\b(missing|invalid|rejected|required)\b/i.test(m)) return 'auth';
  if (/\bHTTP 429\b|retry-after=|rate limited until/i.test(m)) return 'rate-limited';
  if (/\bHTTP 403\b/.test(m)) return 'blocked';
  if (/offline \(OFFLINE=1\)|\bOFFLINE=1\b/.test(m)) return 'offline';
  if (/\b(UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|socket closed before session|no data from Lightstreamer/i.test(m)) return 'unreachable';
  if (/no ephemeris/i.test(m)) return 'no-ephemeris';
  if (/\bHTTP 5\d\d\b/.test(m)) return 'server-error';
  if (/timed? ?out|timeout|aborted/i.test(m)) return 'timeout';
  if (/did not return a JSON array|unexpected [\w. -]*response|not a DSN document|malformed|JSON|schema|holds no objects|CONERR|REQERR/i.test(m)) return 'invalid';
  return 'error';
}

/** `waiting until 14:30Z` (backoff gates), `next attempt 14:30Z` (Space-Track) or `rate limited until 14:30Z` (the request limiter) in a message. */
export function retryTimeOf(message: string | undefined): string | undefined {
  return /(?:waiting until|next attempt|rate limited until)\s+(\d{1,2}:\d{2}Z)/i.exec(message ?? '')?.[1];
}

const feed = (level: FeedLevel, reason: FeedReason, hasData: boolean, note?: string, retryUtc?: string): FeedState =>
  ({ level, reason, hasData, ...(note ? { note } : {}), ...(retryUtc ? { retryUtc } : {}) });

/**
 * The one place that turns a connector's health record into a colour level and a reason.
 *
 * - off: disabled, OFFLINE mode (network connectors), stub (needs credentials / not implemented), not run yet
 * - ok with an error text left over (`softFail`): orange; reason backoff / rate-limited / partial / no-ephemeris / the cause / stale
 * - a request block still in force (`limit.blockedUntil`: 403/429, Retry-After, repeated failures, a failed login's wait) is
 *   orange `rate-limited` with the retry time, except a rejected login (auth), which stays red
 * - error: auth is always red; blocked, unreachable and invalid are red unless an earlier run left data (then orange);
 *   rate limit, timeout, 5xx, no ephemeris and unknown errors are orange, red as `repeated` once a feed that never
 *   delivered data has failed REPEATED_FAILURES runs in a row
 */
export function classifyFeed(h: ConnectorHealth, now = Date.now()): FeedState {
  const hasData = h.lastOkAt !== undefined;
  const msg = h.lastError;
  if (h.status === 'disabled') {
    const offline = /OFFLINE/.test(h.note ?? '');
    return feed('off', offline ? 'offline' : 'disabled', hasData, h.note);
  }
  if (h.status === 'stub') return feed('off', /^needs\b/i.test(h.note ?? '') ? 'no-credentials' : 'stub', false, h.note);
  if (h.offline && h.status !== 'idle') return feed('off', 'offline', hasData, h.fromCache ? 'OFFLINE=1: serving cached data' : (h.note ?? 'OFFLINE=1'));
  if (h.status === 'idle') return feed('off', 'idle', hasData, h.note);

  const blockedUntil = h.limit?.blockedUntil;
  if (blockedUntil !== undefined && blockedUntil > now && h.limit?.blockKind !== 'failure' && !(h.status === 'error' && classifyCause(msg) === 'auth')) {
    return feed('orange', 'rate-limited', hasData, msg ?? h.note, new Date(blockedUntil).toISOString().slice(11, 16) + 'Z');
  }
  const retryUtc = retryTimeOf(msg);
  if (h.status === 'ok') {
    if (!msg) return feed('ok', 'ok', true, h.note);
    const cause = classifyCause(msg);
    let reason: FeedReason;
    if (cause === 'rate-limited') reason = 'rate-limited';
    else if (retryUtc) reason = 'backoff';
    else if (cause === 'no-ephemeris') reason = 'no-ephemeris';
    else if (/^partial\b|targets failed/.test(h.note ?? '')) reason = 'partial';
    else reason = cause === 'error' || cause === 'offline' ? 'stale' : cause;
    return feed('orange', reason, true, msg, retryUtc);
  }

  // status 'error'
  const cause = classifyCause(msg);
  const failures = h.failures ?? 1;
  if (cause === 'auth') return feed('red', 'auth', hasData, msg);
  if (cause === 'blocked' || cause === 'unreachable' || cause === 'invalid') return feed(hasData ? 'orange' : 'red', cause, hasData, msg, retryUtc);
  if (cause === 'rate-limited') return feed('orange', cause, hasData, msg, retryUtc);
  if (!hasData && failures >= REPEATED_FAILURES) return feed('red', 'repeated', false, msg, retryUtc);
  return feed('orange', cause === 'offline' ? 'stale' : cause, hasData, msg, retryUtc);
}
