import { describe, expect, it } from 'vitest';
import { MOCK_DEFAULT_SATS, MOCK_MAX_SATS, clampMockCount, mockSatellites } from '../src/mock/generators';

const NOW = Date.parse('2026-10-22T12:00:00Z');

describe('mock scale (?mock=1&n=)', () => {
  it('clamps the requested count', () => {
    expect(clampMockCount(NaN)).toBeUndefined();
    expect(clampMockCount(0)).toBeUndefined();
    expect(clampMockCount(-5)).toBeUndefined();
    expect(clampMockCount(1500.9)).toBe(1500);
    expect(clampMockCount(5_000_000)).toBe(MOCK_MAX_SATS);
    expect(MOCK_MAX_SATS).toBe(2_000_000);
  });

  it('produces exactly n unique orbiters, deterministically', () => {
    const a = mockSatellites(NOW, 20_000);
    const b = mockSatellites(NOW, 20_000);
    expect(a).toHaveLength(20_000);
    expect(new Set(a.map((e) => e.id)).size).toBe(20_000);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    expect(a[12_345]).toEqual(b[12_345]);
    expect(mockSatellites(NOW)).toHaveLength(MOCK_DEFAULT_SATS);
  });

  it('spreads over LEO, MEO and GEO', () => {
    const sats = mockSatellites(NOW, 20_000);
    const mm = sats.map((e) => (e.provider?.type === 'sgp4' ? e.provider.omm.MEAN_MOTION : 0));
    expect(mm.filter((m) => m > 11).length).toBeGreaterThan(10_000); // LEO
    expect(mm.filter((m) => m > 1.8 && m < 2.1).length).toBeGreaterThan(500); // MEO / GPS and Molniya
    expect(mm.filter((m) => m > 0.99 && m < 1.01).length).toBeGreaterThan(300); // GEO
  });
});
