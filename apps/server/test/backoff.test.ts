import { describe, expect, it } from 'vitest';
import { MAX_BACKOFF_MS, backoffMs, clearBackoff, isBackedOff, isBlockError, readBackoff, recordFailure } from '../src/backoff';
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
