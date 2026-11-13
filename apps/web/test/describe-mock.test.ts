import { describe, expect, it } from 'vitest';
import { createMockApi } from '../src/mock/mock-api';

describe('mock About descriptions', () => {
  const api = createMockApi(Date.UTC(2026, 0, 1), 50);

  it('gives the ISS the recorded Wikipedia summary, no invented DISCOS facts', async () => {
    const d = await api.describe('sat-25544');
    expect(d.summary?.text).toMatch(/^The International Space Station/);
    expect(d.summary?.thumbnail?.url).toMatch(/^https:\/\//);
    expect(d.wikidata?.id).toBe('Q25271');
    expect(d.discos).toBeUndefined();
    expect(d.sources.discos).toBe('off');
    expect(d.fallback).toContain('NORAD catalogue number 25544');
  });

  it('gives every other object only the fallback line', async () => {
    expect((await api.describe('dsn-VGR1')).summary).toBeUndefined();
    const other = await api.describe('dsn-JWST');
    expect(other.summary).toBeUndefined();
    expect(other.fallback).toBeTruthy();
    expect(other.searchUrl).toContain('James%20Webb');
  });

  it('rejects an unknown entity', async () => {
    await expect(api.describe('nope')).rejects.toThrow(/unknown entity/);
  });
});
