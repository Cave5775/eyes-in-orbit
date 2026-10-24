import { describe, expect, it } from 'vitest';
import { MAX_BACKOFF_MS, backoffMs, clearBackoff, isBackedOff, isBlockError, isConnectError, readBackoff, recordFailure, retryAfterMs } from '../src/backoff';
import { Store } from '../src/store';

describe('backoff policy', () => {
  it('grows with each failure and never exceeds the cap', () => {
    for (const blocked of [true, false]) {
      let prev = 0;
      for (let n = 1; n <= 12; n++) {
        const ms = backoffMs(n, blocked);
        expect(ms).toBeGreaterThanOrEqual(prev);
        expect(ms).toBeLessThanOrEqual(MAX_BACKOFF_MS);
        prev = ms;
      }
    }
  });

  it('waits longer after a rate-limit block than after a transient error', () => {
    expect(backoffMs(1, true)).toBeGreaterThan(backoffMs(1, false));
  });

  it('keeps off CelesTrak for at least its ~2 h data refresh after a 403', () => {
    expect(backoffMs(1, true)).toBeGreaterThanOrEqual(2 * 3600_000);
  });

  it('recognises rate-limit responses by status', () => {
    expect(isBlockError('HTTP 403 for https://celestrak.org/x: denied')).toBe(true);
    expect(isBlockError('HTTP 429 for x')).toBe(true);
    expect(isBlockError('HTTP 503 for x')).toBe(false);
    expect(isBlockError('The operation was aborted due to timeout')).toBe(false);
  });
});

describe('connect failures and Retry-After', () => {
  it('classifies a connect timeout and a reset as block errors, but not the total-request timeout', () => {
    expect(isBlockError('fetch failed (UND_ERR_CONNECT_TIMEOUT)')).toBe(true);
    expect(isBlockError('fetch failed (ECONNRESET)')).toBe(true);
    expect(isConnectError('fetch failed (UND_ERR_CONNECT_TIMEOUT)')).toBe(true);
    expect(isConnectError('HTTP 403 for x')).toBe(false);
    expect(isBlockError('fetch failed')).toBe(false);
    expect(isBlockError('fetch failed (ENOTFOUND)')).toBe(false);
    expect(isBlockError('The operation was aborted due to timeout')).toBe(false);
  });

  it('keeps the short schedule for a connect timeout (an outage ends on its own), the long one only for 403/429', () => {
    const t0 = 1_000;
    const next = recordFailure(new Store(':memory:'), 'c', new Error('fetch failed (UND_ERR_CONNECT_TIMEOUT)'), t0);
    expect(next.notBefore - t0).toBe(backoffMs(1, false));
    expect(next.message).toContain('UND_ERR_CONNECT_TIMEOUT');
  });

  it('parses Retry-After as seconds or as an HTTP date', () => {
    const now = Date.parse('2026-10-24T10:00:00Z');
    expect(retryAfterMs('HTTP 429 for u [retry-after=120; server=cloudflare]', now)).toBe(120_000);
    expect(retryAfterMs('HTTP 429 for u [retry-after=Sat, 24 Oct 2026 12:00:00 GMT; server=x]', now)).toBe(2 * 3600_000);
    expect(retryAfterMs('HTTP 429 for u [retry-after=Sat, 24 Oct 2026 09:00:00 GMT]', now)).toBe(0);
    expect(retryAfterMs('HTTP 429 for u [retry-after=soon]', now)).toBeUndefined();
    expect(retryAfterMs('HTTP 429 for u', now)).toBeUndefined();
  });

  it('honours a Retry-After longer than the schedule, ignores a shorter one, and caps it at 24 h', () => {
    const store = new Store(':memory:');
    const t0 = 5_000;
    const long = recordFailure(store, 'r1', new Error('HTTP 429 for u [retry-after=' + 6 * 3600 + ']'), t0);
    expect(long.notBefore - t0).toBe(6 * 3600_000);
    const short = recordFailure(store, 'r2', new Error('HTTP 429 for u [retry-after=60]'), t0);
    expect(short.notBefore - t0).toBe(backoffMs(1, true));
    const huge = recordFailure(store, 'r3', new Error('HTTP 429 for u [retry-after=9999999]'), t0);
    expect(huge.notBefore - t0).toBe(24 * 3600_000);
  });
});

describe('backoff state', () => {
  it('counts consecutive failures and closes the gate until notBefore', () => {
    const store = new Store(':memory:');
    const t0 = 1_000_000;
    const a = recordFailure(store, 'x', new Error('HTTP 403 for u'), t0);
    expect(a).toEqual({ failures: 1, notBefore: t0 + backoffMs(1, true), message: 'HTTP 403 for u' });
    const b = recordFailure(store, 'x', new Error('HTTP 403 for u'), t0 + a.notBefore);
    expect(b.failures).toBe(2);
    expect(isBackedOff(readBackoff(store, 'x'), b.notBefore - 1)).toBe(true);
    expect(isBackedOff(readBackoff(store, 'x'), b.notBefore)).toBe(false);
  });

  it('is stored in the cache database, can be read back and cleared', () => {
    const store = new Store(':memory:');
    recordFailure(store, 'y', 'boom', 5);
    expect(readBackoff(store, 'y')?.failures).toBe(1);
    clearBackoff(store, 'y');
    expect(readBackoff(store, 'y')).toBeUndefined();
    expect(isBackedOff(undefined)).toBe(false);
  });
});
