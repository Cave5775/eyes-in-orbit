import { describe, expect, it } from 'vitest';
import {
  fmtAttr, fmtBitrate, fmtPathWindow, fmtDays, fmtDeg, fmtDist, fmtKm, fmtLat, fmtLightTime, fmtLon, fmtNum, fmtPercent, fmtPeriod,
  fmtSpeedKmS, fmtSpeedKmh, fmtTelemetryValue, roundLongFloats,
} from '../src/lib/format';

describe('fixed-decimal helpers', () => {
  it('lat/lon use 3 decimals and hemisphere letters', () => {
    expect(fmtLat(12.3456789)).toBe('12.346° N');
    expect(fmtLat(-0.5)).toBe('0.500° S');
    expect(fmtLon(-122.123456)).toBe('122.123° W');
    expect(fmtLon(179.9999)).toBe('180.000° E');
    expect(fmtLat(NaN)).toBe('—');
  });

  it('always yields the same number of decimals', () => {
    for (const v of [1, 1.5, 1.123456789, 1234.5678]) {
      expect(fmtKm(v)).toMatch(/\.\d km$/);
      expect(fmtSpeedKmS(v)).toMatch(/\.\d{3} km\/s$/);
    }
  });

  it('altitude km 1 decimal, speed km/s 3, km/h 0', () => {
    expect(fmtKm(417.84321)).toBe('417.8 km');
    expect(fmtKm(1234.56)).toBe('1,234.6 km');
    expect(fmtSpeedKmS(7.660123456)).toBe('7.660 km/s');
    expect(fmtSpeedKmh(27578.4)).toBe('27,578 km/h');
    expect(fmtKm(undefined)).toBe('—');
  });

  it('period in minutes with 1 decimal', () => {
    expect(fmtPeriod(5560.4)).toBe('92.7 min');
    expect(fmtPeriod(86164)).toBe('1,436.1 min');
    expect(fmtPeriod(0)).toBe('—');
  });

  it('light time: seconds with 1 decimal below 100 s, durations above', () => {
    expect(fmtLightTime(9.987654)).toBe('10.0 s');
    expect(fmtLightTime(1.23)).toBe('1.2 s');
    expect(fmtLightTime(1470)).toBe('24m 30s');
    expect(fmtLightTime(undefined)).toBe('—');
  });

  it('data rates scale units and cap decimals', () => {
    expect(fmtBitrate(160)).toBe('160 b/s');
    expect(fmtBitrate(160.123)).toBe('160 b/s');
    expect(fmtBitrate(28_123)).toBe('28.1 kb/s');
    expect(fmtBitrate(2_000_000)).toBe('2.00 Mb/s');
    expect(fmtBitrate(1_234_567_890)).toBe('1.23 Gb/s');
    expect(fmtBitrate(0)).toBe('—');
  });

  it('misc units', () => {
    expect(fmtDeg(123.456)).toBe('123.5°');
    expect(fmtPercent(0.8349)).toBe('83%');
    expect(fmtDays(2.345)).toBe('2.3 d');
    expect(fmtNum(1234.5678, 2)).toBe('1,234.57');
  });

  it('distances switch unit with fixed decimals per band', () => {
    expect(fmtDist(42.123)).toBe('42.12 km');
    expect(fmtDist(6778.137)).toBe('6,778 km');
    expect(fmtDist(384_400)).toBe('384,400 km');
    expect(fmtDist(2.5e7)).toBe('25.00 Mkm');
    expect(fmtDist(2.5e10)).toBe('167.11 AU');
  });
});

describe('roundLongFloats', () => {
  it('rounds long decimals and trims trailing zeros', () => {
    expect(roundLongFloats('range 1234.56789123 km')).toBe('range 1234.568 km');
    expect(roundLongFloats('0.123456')).toBe('0.123');
    expect(roundLongFloats('100.0000001')).toBe('100');
    expect(roundLongFloats('-0.00001')).toBe('0');
    expect(roundLongFloats('12.50001')).toBe('12.5');
  });

  it('leaves short decimals, versions, integers and timestamps alone', () => {
    expect(roundLongFloats('14.7 psia')).toBe('14.7 psia');
    expect(roundLongFloats('v1.2.3')).toBe('v1.2.3');
    expect(roundLongFloats('1.2.3.4567')).toBe('1.2.3.4567');
    expect(roundLongFloats('2026-10-22T12:00:00.123456Z')).toBe('2026-10-22T12:00:00.123456Z');
    expect(roundLongFloats('NORAD 25544')).toBe('NORAD 25544');
  });

  it('handles several numbers in one string', () => {
    expect(roundLongFloats('a=1.234567, b=2.000001')).toBe('a=1.235, b=2');
  });
});

describe('fmtAttr', () => {
  it('formats known keys by unit', () => {
    expect(fmtAttr('rangeKm', 2.5e10)).toBe('167.11 AU');
    expect(fmtAttr('rangeKm', 1.512345e6)).toBe('1.51 Mkm');
    expect(fmtAttr('rtltSec', 1470.4321)).toBe('24m 30s');
    expect(fmtAttr('rtltSec', 8.77123)).toBe('8.8 s');
    expect(fmtAttr('dataRateBps', 2_048_000.5)).toBe('2.05 Mb/s');
    expect(fmtAttr('dataRate', 160)).toBe('160 b/s');
  });

  it('formats unknown numbers with fixed decimals', () => {
    expect(fmtAttr('cycleSec', 600)).toBe('10m 00s');
    expect(fmtAttr('count', 12)).toBe('12');
    expect(fmtAttr('ratio', 0.123456789)).toBe('0.12');
    expect(fmtAttr('apogeeKm', 421.98765)).toBe('422.0 km');
    expect(fmtAttr('incDeg', 51.64161)).toBe('51.6°');
    expect(fmtAttr('x', NaN)).toBe('—');
  });

  it('rounds long floats inside strings, formats ISO timestamps, booleans', () => {
    expect(fmtAttr('note', 'drifting at 12.34567891 km/s')).toBe('drifting at 12.346 km/s');
    expect(fmtAttr('net', '2026-10-22T12:00:00.000Z')).toBe('2026-10-22 12:00:00 UTC');
    expect(fmtAttr('hold', false)).toBe('no');
    expect(fmtAttr('downlinkActive', true)).toBe('yes');
    expect(fmtAttr('dish', 'DSS-14, DSS-24')).toBe('DSS-14, DSS-24');
  });
});

describe('fmtTelemetryValue', () => {
  it('rounds long numeric strings only', () => {
    expect(fmtTelemetryValue('14.70123456')).toBe('14.701');
    expect(fmtTelemetryValue('14.70')).toBe('14.70');
    expect(fmtTelemetryValue(' 6600 ')).toBe('6600');
    expect(fmtTelemetryValue('NOMINAL')).toBe('NOMINAL');
  });
});

describe('fmtPathWindow', () => {
  it('shows past and future around now, and a planned or finished path by when it is', () => {
    expect(fmtPathWindow(-300_000, 600_000)).toBe('-5m 00s / +10m 00s');
    expect(fmtPathWindow(2 * 86_400_000, 2 * 86_400_000 + 600_000)).toBe('starts in 2d 0h, lasts 10m 00s');
    expect(fmtPathWindow(-14_400_000, -10_800_000)).toBe('ended 3h 00m ago');
  });
});
