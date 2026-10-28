import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCelestrak, loadGroupFileStamped, parseOmmJson } from '../src/connectors/celestrak';
import { SEED_MAX_AGE_MS, seedGroups } from '../src/connectors/celestrak-seed';
import { Store } from '../src/store';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const tmp = () => mkdtempSync(join(tmpdir(), 'eio-seed-'));
const noWait = { sleep: async () => {}, spacingMs: () => 0 };

/** A fetch that answers per group from `answers` (a body, or an Error to throw, or a number for an HTTP status). */
function fakeFetch(answers: Record<string, string | number | Error>) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const group = new URL(url).searchParams.get('GROUP')!;
    const a = answers[group];
    if (a instanceof Error) throw a;
    if (typeof a === 'number') return new Response('denied', { status: a, headers: { server: 'cloudflare', 'retry-after': '3600' } });
    return new Response(a ?? '[]', { status: 200 });
  }) as typeof fetch;
  return { impl, urls };
}

const connectTimeout = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });

describe('celestrak seed', () => {
  it('saves each group as the file the connector reads, byte for byte', async () => {
    const dir = tmp();
    const body = fixture('celestrak-starlink.json');
    const f = fakeFetch({ stations: fixture('celestrak-stations.json'), starlink: body });
    const r = await seedGroups({ dir, groups: ['stations', 'starlink'], fetchImpl: f.impl, ...noWait });
    expect(r).toMatchObject({ saved: ['stations', 'starlink'], fresh: [], skipped: [] });
    expect(r.failed).toBeUndefined();
    expect(readFileSync(join(dir, 'starlink.json'), 'utf8')).toBe(body);
    expect(f.urls[0]).toBe('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json');
    expect(loadGroupFileStamped(dir, 'stations')!.omms[0].OBJECT_NAME).toBe('ISS (ZARYA)');
  });

  it('keeps a recent file and downloads an old one, or any with force', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'stations.json'), fixture('celestrak-stations.json'));
    const old = join(dir, 'starlink.json');
    writeFileSync(old, fixture('celestrak-starlink.json'));
    const tenHoursAgo = new Date(Date.now() - 10 * 3600_000);
    utimesSync(old, tenHoursAgo, tenHoursAgo);
    const f = fakeFetch({ stations: fixture('celestrak-stations.json'), starlink: fixture('celestrak-starlink.json') });
    const r = await seedGroups({ dir, groups: ['stations', 'starlink'], fetchImpl: f.impl, ...noWait });
    expect(r.fresh).toEqual(['stations']);
    expect(r.saved).toEqual(['starlink']);
    expect(f.urls).toHaveLength(1);
    const forced = fakeFetch({ stations: fixture('celestrak-stations.json') });
    const r2 = await seedGroups({ dir, groups: ['stations'], force: true, fetchImpl: forced.impl, ...noWait });
    expect(r2.saved).toEqual(['stations']);
    expect(SEED_MAX_AGE_MS).toBe(3 * 3600_000);
  });

  it('stops at the first failure, names the cause code and tries nothing else', async () => {
    const dir = tmp();
    const f = fakeFetch({ stations: connectTimeout() });
    const r = await seedGroups({ dir, groups: ['stations', 'starlink', 'active'], fetchImpl: f.impl, ...noWait });
    expect(r.failed).toMatchObject({ group: 'stations' });
    expect(r.failed!.error).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(r.skipped).toEqual(['starlink', 'active']);
    expect(f.urls).toHaveLength(1);
    expect(existsSync(join(dir, 'stations.json'))).toBe(false);
  });

  it('reports an HTTP block with its headers and keeps the good file', async () => {
    const dir = tmp();
    const good = fixture('celestrak-stations.json');
    writeFileSync(join(dir, 'stations.json'), good);
    const f = fakeFetch({ stations: 403 });
    const r = await seedGroups({ dir, groups: ['stations'], force: true, fetchImpl: f.impl, ...noWait });
    expect(r.failed!.error).toMatch(/HTTP 403/);
    expect(r.failed!.error).toContain('retry-after=3600');
    expect(readFileSync(join(dir, 'stations.json'), 'utf8')).toBe(good);
  });

  it('never replaces a file with a response that is not OMM JSON or is empty', async () => {
    const dir = tmp();
    const good = fixture('celestrak-stations.json');
    writeFileSync(join(dir, 'stations.json'), good);
    const text = await seedGroups({ dir, groups: ['stations'], force: true, fetchImpl: fakeFetch({ stations: 'GP data has not updated' }).impl, ...noWait });
    expect(text.failed).toBeDefined();
    const empty = await seedGroups({ dir, groups: ['stations'], force: true, fetchImpl: fakeFetch({ stations: '[]' }).impl, ...noWait });
    expect(empty.failed!.error).toMatch(/no objects/);
    expect(readFileSync(join(dir, 'stations.json'), 'utf8')).toBe(good);
    expect(existsSync(join(dir, 'stations.json.tmp'))).toBe(false);
  });

  it('spaces the downloads', async () => {
    const waits: number[] = [];
    const f = fakeFetch({ stations: fixture('celestrak-stations.json'), starlink: fixture('celestrak-starlink.json'), active: fixture('celestrak-active.json') });
    await seedGroups({ dir: tmp(), groups: ['stations', 'starlink', 'active'], fetchImpl: f.impl, spacingMs: () => 1500, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([1500, 1500]);
  });
});

describe('celestrak connector with saved files', () => {
  const fast = createCelestrak({ spacingMs: () => 0, sleep: async () => {} });
  const issOnly = parseOmmJson(fixture('celestrak-stations.json'));
  // a different object under the same group, so the cache (the ISS) and the file can be told apart
const otherOnly = [{ ...issOnly[0], NORAD_CAT_ID: 99999, OBJECT_NAME: 'FROM THE FILE' }];

  /** every download fails as it does from a blocked network; `stale` mimics cachedFetch serving the old cache entry */
  function ctxWith(opts: { cacheAgeMs?: number; fileAgeMs?: number; stale?: boolean }) {
    const dataDir = tmp();
    const store = new Store(':memory:');
    const now = Date.now();
    if (opts.cacheAgeMs !== undefined) store.set('celestrak:stations', issOnly, 3 * 3600_000, now - opts.cacheAgeMs);
    if (opts.fileAgeMs !== undefined) {
      mkdirSync(join(dataDir, 'celestrak'), { recursive: true });
      const path = join(dataDir, 'celestrak', 'stations.json');
      writeFileSync(path, JSON.stringify(otherOnly));
      const at = new Date(now - opts.fileAgeMs);
      utimesSync(path, at, at);
    }
    const upserted: string[] = [];
    const err = 'fetch failed (UND_ERR_CONNECT_TIMEOUT)';
    return {
      upserted, store,
      config: { dataDir },
      health: {} as { note?: string },
      log: () => {},
      hub: { graph: { size: 0 }, upsert: (...r: { id: string }[]) => (upserted.push(...r.map((e) => e.id)), r.length) },
      softFail: () => {},
      cachedFetch: async () => {
        if (opts.stale) return { value: issOnly, fromCache: true, stale: true, error: err };
        throw new Error(err);
      },
    };
  }

  it('uses a saved file that is newer than the cache when the download fails', async () => {
    const ctx = ctxWith({ cacheAgeMs: 10 * 3600_000, fileAgeMs: 60_000 });
    await fast.run!(ctx as never);
    expect(ctx.upserted).toContain('sat-99999'); // from the file
    expect(ctx.upserted).not.toContain('sat-25544'); // not the old cache's ISS
    expect(ctx.health.note).toContain('data file');
  });

  it('uses the cache when it is newer than the file', async () => {
    const ctx = ctxWith({ cacheAgeMs: 60_000, fileAgeMs: 10 * 3600_000 });
    await fast.run!(ctx as never);
    expect(ctx.upserted).toContain('sat-25544');
    expect(ctx.health.note).toContain('using cache');
  });

  it('prefers the newer file also when cachedFetch itself fell back to the stale cache', async () => {
    const ctx = ctxWith({ cacheAgeMs: 10 * 3600_000, fileAgeMs: 60_000, stale: true });
    await fast.run!(ctx as never);
    expect(ctx.upserted).toContain('sat-99999');
    expect(ctx.upserted).not.toContain('sat-25544');
    expect(ctx.health.note).toContain('data file');
  });

  it('reads a file when there is no cache at all (the original escape hatch)', async () => {
    const ctx = ctxWith({ fileAgeMs: 60_000 });
    await fast.run!(ctx as never);
    expect(ctx.upserted).toContain('sat-99999');
  });
});
