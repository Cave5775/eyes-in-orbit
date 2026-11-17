import { describe, expect, it } from 'vitest';
import { Store } from '../src/store';

const DAY = 86_400_000;
const now = Date.parse('2026-11-16T12:00:00Z');
const keys = (s: Store, prefix: string) => s.list(prefix).map((r) => r.key).sort();

describe('Store.prune', () => {
  it('drops rows stale for longer than maxAge past their TTL and keeps newer ones', () => {
    const s = new Store(':memory:');
    s.set('a:old', 1, 1000, now - 40 * DAY);
    s.set('a:recent', 2, 1000, now - 10 * DAY);
    s.set('a:fresh', 3, 3600_000, now);
    expect(s.prune(30 * DAY, now)).toBe(1);
    expect(keys(s, 'a:')).toEqual(['a:fresh', 'a:recent']);
  });

  it('keeps rows under a kept prefix at any age, and still prunes other old rows', () => {
    const s = new Store(':memory:');
    s.set('celestrak:starlink', [1], 1000, now - 400 * DAY);
    s.set('celestrak:active', [2], 1000, now - 40 * DAY);
    s.set('backoff:celestrak:x', { failures: 1 }, 1000, now - 40 * DAY);
    s.set('limit:celestrak', { n: 1 }, 1000, now - 40 * DAY);
    s.set('other:y', 1, 1000, now - 40 * DAY);
    expect(s.prune(30 * DAY, now, ['celestrak:'])).toBe(3);
    expect(keys(s, '')).toEqual(['celestrak:active', 'celestrak:starlink']);
  });

  it('treats a kept prefix literally (no LIKE wildcards)', () => {
    const s = new Store(':memory:');
    s.set('a_b:1', 1, 1000, now - 40 * DAY);
    s.set('axb:1', 1, 1000, now - 40 * DAY);
    s.set('100%:1', 1, 1000, now - 40 * DAY);
    s.set('1000:1', 1, 1000, now - 40 * DAY);
    expect(s.prune(30 * DAY, now, ['a_b:', '100%'])).toBe(2);
    expect(keys(s, '')).toEqual(['100%:1', 'a_b:1']);
  });

  it('prunes by age only when no prefixes are given', () => {
    const s = new Store(':memory:');
    s.set('celestrak:starlink', [1], 1000, now - 400 * DAY);
    expect(s.prune(30 * DAY, now)).toBe(1);
  });
});
