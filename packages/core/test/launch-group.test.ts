import { describe, expect, it } from 'vitest';
import { baseObjectName, launchGroupLabel, launchIdFromCospar, parseCospar } from '../src';

describe('launch id from COSPAR', () => {
  it('extracts YYYY-NNN from payload and piece designators', () => {
    expect(launchIdFromCospar('1993-036A')).toBe('1993-036');
    expect(launchIdFromCospar('1993-036BQ')).toBe('1993-036');
    expect(launchIdFromCospar('2007-006AAA')).toBe('2007-006');
    expect(launchIdFromCospar('1998-067')).toBe('1998-067');
    expect(launchIdFromCospar(' 1993-036a ')).toBe('1993-036');
  });

  it('gives no group for missing or odd designators', () => {
    for (const v of [undefined, null, '', '   ', 'abc', '93-036A', '1993036A', '1993-36A', '1993-036ABCD', '1993-000A', '1850-001A', '1993-036 A']) {
      expect(launchIdFromCospar(v)).toBeUndefined();
    }
    expect(launchIdFromCospar(42 as unknown as string)).toBeUndefined();
  });

  it('exposes the piece letters', () => {
    expect(parseCospar('1993-036BQ')).toEqual({ launchId: '1993-036', piece: 'BQ' });
    expect(parseCospar('1993-036')).toEqual({ launchId: '1993-036', piece: '' });
  });
});

describe('launch group label', () => {
  it('strips DEB and R/B suffixes', () => {
    expect(baseObjectName('COSMOS 2251 DEB')).toBe('COSMOS 2251');
    expect(baseObjectName('SL-8 R/B')).toBe('SL-8');
    expect(baseObjectName('DEBRIS 1')).toBe('DEBRIS 1');
  });

  it('prefers the A piece', () => {
    const label = launchGroupLabel([
      { name: 'COSMOS 2251 DEB', cospar: '1993-036BQ' },
      { name: 'COSMOS 2251', cospar: '1993-036A' },
      { name: 'COSMOS 2251 DEB', cospar: '1993-036C' },
    ]);
    expect(label).toBe('COSMOS 2251');
  });

  it('falls back to the most common stripped name', () => {
    const label = launchGroupLabel([
      { name: 'COSMOS 2251 DEB', cospar: '1993-036BQ' },
      { name: 'COSMOS 2251 DEB', cospar: '1993-036C' },
      { name: 'COSMOS 2251 R/B', cospar: '1993-036D' },
      { name: 'FREGAT DEB', cospar: '1993-036E' },
    ]);
    expect(label).toBe('COSMOS 2251');
  });

  it('falls back to the launch id for empty input', () => {
    expect(launchGroupLabel([], '1993-036')).toBe('1993-036');
    expect(launchGroupLabel([{ name: ' DEB', cospar: '1993-036B' }])).toBe('1993-036');
  });
});
