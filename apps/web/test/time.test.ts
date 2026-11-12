import { describe, expect, it } from 'vitest';
import { fmtElementAge } from '../src/lib/format';
import {
  DAY_MS, HOUR_MS, MAX_OFFSET_MS, MIN_MS, clampOffset, digitsOnly, fmtOffset, joinOffset, offsetFields, offsetMs,
  parseField, parseOffsetFields, parseOffsetText, simTimeAt, splitOffset,
} from '../src/lib/time-offset';
import { SPEEDS, fmtRateLabel, signedRate, splitRate } from '../src/lib/time-rate';

describe('splitOffset / joinOffset', () => {
  it('splits into sign, days, hours, minutes, seconds', () => {
    const ms = 2 * DAY_MS + 3 * HOUR_MS + 4 * MIN_MS + 5000;
    expect(splitOffset(ms)).toEqual({ sign: 1, days: 2, hours: 3, minutes: 4, seconds: 5 });
    expect(splitOffset(-ms)).toEqual({ sign: -1, days: 2, hours: 3, minutes: 4, seconds: 5 });
  });

  it('rounds to the nearest second and treats zero as positive', () => {
    expect(splitOffset(1499).seconds).toBe(1);
    expect(splitOffset(1500).seconds).toBe(2);
    expect(splitOffset(-300)).toEqual({ sign: 1, days: 0, hours: 0, minutes: 0, seconds: 0 });
    expect(splitOffset(0).sign).toBe(1);
  });

  it('carries 59.6 s into the next minute rather than showing 60', () => {
    expect(splitOffset(59_600)).toMatchObject({ minutes: 1, seconds: 0 });
  });

  it('round-trips whole seconds, including large day counts', () => {
    for (const ms of [0, 1000, -1000, 86_399_000, -86_400_000, 12_345 * DAY_MS + 6_789_000, -(400 * DAY_MS + 61_000)]) {
      expect(joinOffset(splitOffset(ms))).toBe(ms);
    }
  });

  it('joins overflowing fields', () => {
    expect(joinOffset({ sign: 1, days: 0, hours: 0, minutes: 90, seconds: 0 })).toBe(90 * MIN_MS);
    expect(joinOffset({ sign: -1, days: 1, hours: 25, minutes: 61, seconds: 100 })).toBe(-(DAY_MS + 25 * HOUR_MS + 61 * MIN_MS + 100_000));
  });

  it('clamps to about +/- 100 years and survives non-finite input', () => {
    expect(clampOffset(1e18)).toBe(MAX_OFFSET_MS);
    expect(clampOffset(-1e18)).toBe(-MAX_OFFSET_MS);
    expect(clampOffset(NaN)).toBe(0);
    expect(Number.isFinite(new Date(Date.now() + MAX_OFFSET_MS).getTime())).toBe(true);
    expect(splitOffset(1e18).days).toBe(36_500);
  });
});

describe('format and parse fields', () => {
  it('formats +dd:hh:mm:ss', () => {
    expect(fmtOffset(0)).toBe('+00:00:00:00');
    expect(fmtOffset(-(DAY_MS + 2 * HOUR_MS + 3 * MIN_MS + 4000))).toBe('-01:02:03:04');
    expect(fmtOffset(1234 * DAY_MS)).toBe('+1234:00:00:00');
    expect(offsetFields(3 * HOUR_MS)).toEqual({ sign: 1, days: '00', hours: '03', minutes: '00', seconds: '00' });
  });

  it('parses a field: empty and junk are 0, decimals truncate, negatives are not allowed', () => {
    expect(parseField('')).toBe(0);
    expect(parseField('  ')).toBe(0);
    expect(parseField('abc')).toBe(0);
    expect(parseField('07')).toBe(7);
    expect(parseField('12.9')).toBe(12);
    expect(parseField('-5')).toBe(0);
  });

  it('filters input to digits and limits its length', () => {
    expect(digitsOnly('1a2-3:4')).toBe('1234');
    expect(digitsOnly('1234567890', 4)).toBe('1234');
  });

  it('turns the four field texts into an offset (empty = 0, overflow normalised)', () => {
    expect(parseOffsetFields({ sign: 1, days: '', hours: '', minutes: '90', seconds: '' })).toBe(90 * MIN_MS);
    expect(parseOffsetFields({ sign: -1, days: '2', hours: '3', minutes: '4', seconds: '5' })).toBe(-(2 * DAY_MS + 3 * HOUR_MS + 4 * MIN_MS + 5000));
    expect(parseOffsetFields({ sign: -1, days: '', hours: '', minutes: '', seconds: '' })).toBe(0);
    expect(parseOffsetFields({ sign: 1, days: '99999999', hours: '0', minutes: '0', seconds: '0' })).toBe(MAX_OFFSET_MS);
  });

  it('parses pasted offset text right-aligned with an optional sign', () => {
    expect(parseOffsetText('-1:02:03:04')).toBe(-(DAY_MS + 2 * HOUR_MS + 3 * MIN_MS + 4000));
    expect(parseOffsetText('+90:00')).toBe(90 * MIN_MS);
    expect(parseOffsetText('45')).toBe(45_000);
    expect(parseOffsetText('−1:00:00')).toBe(-HOUR_MS);
    expect(parseOffsetText('1:2:3:4:5')).toBeNull();
    expect(parseOffsetText('abc')).toBeNull();
    expect(parseOffsetText('')).toBeNull();
  });
});

describe('offset arithmetic', () => {
  it('offset and target are inverse', () => {
    const wall = Date.parse('2026-10-22T12:00:00Z');
    const off = -3 * DAY_MS + 17 * MIN_MS;
    const sim = simTimeAt(wall, off);
    expect(offsetMs(sim, wall)).toBe(off);
    expect(new Date(sim).toISOString()).toBe('2026-10-19T12:17:00.000Z');
  });

  it('reads the right offset when the sim runs at another rate', () => {
    const wall0 = 1_000_000_000_000;
    // seek to wall + 1 h, run at x600 for 10 wall seconds: sim moved 6000 s
    const sim = simTimeAt(wall0, HOUR_MS) + 10_000 * 600;
    expect(offsetMs(sim, wall0 + 10_000)).toBe(HOUR_MS + 10_000 * 599);
    expect(fmtOffset(offsetMs(sim, wall0 + 10_000))).toBe('+00:02:39:50');
    // the same at x-600 (rewind): 1 h - 6000 s - 10 s
    const back = simTimeAt(wall0, HOUR_MS) - 10_000 * 600;
    expect(fmtOffset(offsetMs(back, wall0 + 10_000))).toBe('-00:00:40:10');
  });
});

describe('rate helpers', () => {
  it('builds and splits signed rates', () => {
    expect(SPEEDS).toEqual([1, 10, 60, 600]);
    expect(signedRate(60, true)).toBe(-60);
    expect(signedRate(60, false)).toBe(60);
    expect(splitRate(-600)).toEqual({ speed: 600, reverse: true });
    expect(splitRate(10)).toEqual({ speed: 10, reverse: false });
    expect(splitRate(0, { speed: 60, reverse: true })).toEqual({ speed: 60, reverse: true });
  });

  it('labels direction', () => {
    expect(fmtRateLabel('live', 1)).toBe('Live');
    expect(fmtRateLabel('paused', 60)).toBe('Paused');
    expect(fmtRateLabel('scrubbed', 60)).toBe('▶ ×60');
    expect(fmtRateLabel('scrubbed', -60)).toBe('◀ ×60');
  });
});

describe('fmtElementAge', () => {
  it('shows days after the epoch and "before epoch" earlier', () => {
    expect(fmtElementAge(2.34)).toBe('2.3 d');
    expect(fmtElementAge(0)).toBe('0.0 d');
    expect(fmtElementAge(-3.25)).toBe('before epoch (3.3 d)');
    expect(fmtElementAge(undefined)).toBe('—');
    expect(fmtElementAge(NaN)).toBe('—');
  });
});
