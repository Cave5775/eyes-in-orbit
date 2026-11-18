import { OrbitBuilder, readMpcorb, sliceOrbits, readContainer } from '@eio/core';
import type { MinorPlanetIndex } from '../api/types';
import { MPCORB_SAMPLE } from './fixtures/mpcorb-sample';

/** Mock mode (`?mock=1`, no server): the 20 real MPCORB lines of the fixture, packed in the browser like the server packs the file. */
let packed: Promise<Uint8Array> | null = null;
const pack = (): Promise<Uint8Array> => (packed ??= (async () => {
  const b = new OrbitBuilder();
  const s = await readMpcorb(MPCORB_SAMPLE.split('\n'), b);
  return b.finish({ skipped: s.skipped, source: 'mock: a sample of MPCORB.DAT' });
})());

export async function mockMinorPlanetIndex(nowMs: number): Promise<MinorPlanetIndex> {
  const u = readContainer(await pack());
  return {
    count: u.count, chunkSize: 65536, chunks: [{ chunk: 0, count: u.count, hFirst: u.meta.hMin ?? null, hLast: u.meta.hMax ?? null }],
    fetchedAt: nowMs, stale: false, skipped: 0, epochMin: u.meta.epochMin ?? null, epochMax: u.meta.epochMax ?? null,
    credit: 'Minor Planet Center (IAU), https://www.minorplanetcenter.net/iau/MPCORB.html',
  };
}

export async function mockMinorPlanetChunk(k: number): Promise<Uint8Array> {
  const u = readContainer(await pack());
  return k === 0 ? sliceOrbits(u, 0, u.count) : sliceOrbits(u, u.count, u.count);
}
