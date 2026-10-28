import { classifyFeed, type ConnectorHealth, type FeedLevel, type FeedReason, type FeedState } from '@eio/core';

/**
 * The one mapping from a connector's health to what the UI shows: colour class, short text badge (so colour is never the
 * only signal), the reason in words and the tooltip. The level and reason come from the server (`health.feed`);
 * a record without one (an older server) is classified here with the same function.
 */

/** CSS class on `.dot` / `.chip`: ok = --ok (green), orange = --orange, bad = --bad (red), dim = --dim (grey). */
export type FeedTone = 'ok' | 'orange' | 'bad' | 'dim';

export const FEED_TONE: Record<FeedLevel, FeedTone> = { ok: 'ok', orange: 'orange', red: 'bad', off: 'dim' };

/** A short word that goes next to the dot. */
export const FEED_BADGE: Record<FeedLevel, string> = { ok: 'OK', orange: 'WARN', red: 'FAIL', off: 'OFF' };

export const REASON_WORDS: Record<FeedReason, string> = {
  ok: 'receiving data',
  idle: 'not running yet',
  disabled: 'disabled (DISABLED_CONNECTORS)',
  offline: 'offline mode (OFFLINE=1)',
  stub: 'not implemented',
  'no-credentials': 'needs credentials',
  partial: 'partial data, some groups or targets failed',
  backoff: 'waiting to retry',
  'rate-limited': 'rate limited by the source',
  timeout: 'slow or timing out',
  'server-error': 'source server error',
  'no-ephemeris': 'no ephemeris for a target',
  stale: 'showing older data after a failed refresh',
  blocked: 'blocked by the source (HTTP 403)',
  unreachable: 'source unreachable',
  auth: 'login or credentials rejected',
  invalid: 'unreadable response from the source',
  repeated: 'failing repeatedly, no data',
  error: 'failed',
};

/** Worst first: failing feeds are listed at the top. */
const ORDER: Record<FeedLevel, number> = { red: 0, orange: 1, ok: 2, off: 3 };

export const feedOf = (h: ConnectorHealth): FeedState => h.feed ?? classifyFeed(h);

export interface FeedView {
  level: FeedLevel;
  reason: FeedReason;
  tone: FeedTone;
  badge: string;
  /** the reason in words */
  words: string;
  /** the error text or note the connector reported */
  note?: string;
  /** `14:30Z` when the feed is waiting for a retry time */
  retry?: string;
  /** hover text: badge, reason, note and retry time on separate lines */
  title: string;
}

const hhmmZ = (ms: number): string => new Date(ms).toISOString().slice(11, 16) + 'Z';

export function feedView(h: ConnectorHealth): FeedView {
  const f = feedOf(h);
  const retry = f.retryUtc ?? (f.level === 'orange' || f.level === 'red' ? (h.nextRunAt ? hhmmZ(h.nextRunAt) : undefined) : undefined);
  const words = REASON_WORDS[f.reason];
  const badge = FEED_BADGE[f.level];
  const note = f.note;
  const title = [`${badge}: ${words}`, note, retry ? `${f.retryUtc ? 'waiting until' : 'next try'} ${retry}` : undefined, h.fromCache ? 'served from the local cache' : undefined]
    .filter(Boolean).join('\n');
  return { level: f.level, reason: f.reason, tone: FEED_TONE[f.level], badge, words, note, retry, title };
}

/** Red first, then orange, green and grey; the original order is kept inside a level. */
export function sortFeeds(list: ConnectorHealth[]): ConnectorHealth[] {
  return list.map((h, i) => ({ h, i, o: ORDER[feedOf(h).level] })).sort((a, b) => a.o - b.o || a.i - b.i).map((x) => x.h);
}

/** How many connectors are red and orange, for the counts next to the link state. */
export function feedCounts(list: ConnectorHealth[]): { red: number; orange: number } {
  let red = 0, orange = 0;
  for (const h of list) {
    const l = feedOf(h).level;
    if (l === 'red') red++;
    else if (l === 'orange') orange++;
  }
  return { red, orange };
}
