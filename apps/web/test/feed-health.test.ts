import type { ConnectorHealth } from '@eio/core';
import { describe, expect, it } from 'vitest';
import { FEED_BADGE, FEED_TONE, REASON_WORDS, feedCounts, feedOf, feedView, sortFeeds } from '../src/lib/feed-health';
import { mockHealth } from '../src/mock/generators';

const h = (over: Partial<ConnectorHealth>): ConnectorHealth => ({ id: 'c', status: 'ok', runs: 1, lastOkAt: 1, ...over });

describe('feed level to colour and label', () => {
  it('maps the four levels to the four tones and text badges', () => {
    expect(FEED_TONE).toEqual({ ok: 'ok', orange: 'orange', red: 'bad', off: 'dim' });
    expect(FEED_BADGE).toEqual({ ok: 'OK', orange: 'WARN', red: 'FAIL', off: 'OFF' });
  });

  it('has words for every reason', () => {
    for (const r of Object.keys(REASON_WORDS)) expect(REASON_WORDS[r as keyof typeof REASON_WORDS].length).toBeGreaterThan(3);
  });

  it('uses the server feed when present and classifies locally when it is missing', () => {
    expect(feedOf(h({ feed: { level: 'red', reason: 'auth', hasData: false } })).level).toBe('red');
    expect(feedOf(h({ status: 'error', lastOkAt: undefined, lastError: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)' }))).toMatchObject({ level: 'red', reason: 'unreachable' });
  });

  it('builds the tooltip with badge, reason, note and retry time', () => {
    const v = feedView(h({ lastError: 'stations: waiting until 14:30Z (HTTP 403), using cache', note: 'partial: x' }));
    expect(v).toMatchObject({ level: 'orange', tone: 'orange', badge: 'WARN', reason: 'backoff', retry: '14:30Z' });
    expect(v.title.split('\n')).toEqual([
      'WARN: waiting to retry', 'stations: waiting until 14:30Z (HTTP 403), using cache', 'waiting until 14:30Z',
    ]);
    const red = feedView(h({ status: 'error', lastOkAt: undefined, lastError: 'HTTP 403 for https://x.test/', nextRunAt: Date.UTC(2026, 0, 1, 9, 5) }));
    expect(red).toMatchObject({ tone: 'bad', badge: 'FAIL', reason: 'blocked', retry: '09:05Z' });
    expect(red.title).toContain('next try 09:05Z');
    expect(feedView(h({ status: 'disabled', note: 'DISABLED_CONNECTORS' }))).toMatchObject({ tone: 'dim', badge: 'OFF', words: 'disabled (DISABLED_CONNECTORS)' });
    expect(feedView(h({})).title).toBe('OK: receiving data');
  });

  it('lists red first, then orange, green, grey, keeping the order inside a level', () => {
    const list = [
      h({ id: 'g1' }), h({ id: 'off', status: 'disabled' }), h({ id: 'o1', lastError: 'HTTP 429' }),
      h({ id: 'r1', status: 'error', lastOkAt: undefined, lastError: 'HTTP 403' }), h({ id: 'g2' }), h({ id: 'o2', lastError: 'boom' }),
      h({ id: 'r2', status: 'error', lastError: 'HTTP 401' }),
    ];
    expect(sortFeeds(list).map((x) => x.id)).toEqual(['r1', 'r2', 'o1', 'o2', 'g1', 'g2', 'off']);
    expect(feedCounts(list)).toEqual({ red: 2, orange: 2 });
  });

  it('the mock health shows every level', () => {
    const levels = new Set(mockHealth(Date.now()).map((x) => feedOf(x).level));
    expect([...levels].sort()).toEqual(['off', 'ok', 'orange', 'red']);
  });
});
