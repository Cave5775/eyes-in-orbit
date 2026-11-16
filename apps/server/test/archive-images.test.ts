import { readFileSync } from 'node:fs';
import { ARCHIVE_IMAGE_CAP, archiveOf, mastTargetOf } from '@eio/core';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerApi } from '../src/api';
import {
  ArchiveImagesService, PER_DAY_CAP, TTL_MS, WINDOW_YEARS, mastUrl, mjdToMs, msToMjd, parseMast, portalUrl, previewUrl, selectImages, type MastRow,
} from '../src/archive-images';
import { isBackedOff, readBackoff } from '../src/backoff';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { sourceForUrl } from '../src/net/limits';
import { Store } from '../src/store';

const fx = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// real Mast.Caom.Filtered answers captured 2026-11-16 with the shipped query (mastUrl: JUPITER, t_min >= MJD 59899, i.e. now minus 4 years), whole records deleted to ~60
const HST = fx('mast-caom-hst-jupiter.json');
const JWST = fx('mast-caom-jwst-jupiter.json');

const hubble = { id: 'sat-20580', name: 'HST', aliases: { norad: '20580' } };
const jwst = { id: 'dsn-JWST', name: 'James Webb Space Telescope', aliases: { dsn: 'JWST', horizons: '-170' } };
const chandra = { id: 'dsn-CHDR', name: 'Chandra X-ray Observatory', aliases: { dsn: 'CHDR' } };
const paranal = { id: 'obs-paranal', name: 'Paranal Observatory (VLT)', aliases: { observatory: 'paranal' } };
const rubin = { id: 'obs-rubin', name: 'Vera C. Rubin Observatory', aliases: { observatory: 'rubin' } };

describe('archive table and target names', () => {
  it('maps observatories to archives by stable attributes', () => {
    expect(archiveOf(hubble)?.mastCollection).toBe('HST');
    expect(archiveOf(jwst)?.mastCollection).toBe('JWST');
    expect(archiveOf(chandra)?.id).toBe('chandra');
    expect(archiveOf(chandra)?.mastCollection).toBeUndefined();
    expect(archiveOf({ aliases: { dsn: 'TESS' } })?.id).toBe('tess');
    expect(archiveOf(paranal)?.id).toBe('eso');
    expect(archiveOf(rubin)).toBeNull();
    expect(archiveOf({})).toBeNull();
    expect(archiveOf({ aliases: { norad: '25544' } })).toBeNull();
  });

  it('knows the bodies MAST files images under', () => {
    for (const b of ['JUPITER', 'jupiter', 'SATURN', 'MARS', 'URANUS', 'NEPTUNE', 'PLUTO', 'CERES', 'ERIS', 'HAUMEA', 'MAKEMAKE']) expect(mastTargetOf(b)).toBe(b.toUpperCase());
    for (const b of ['MOON', 'SUN', 'VENUS', 'MERCURY', 'EARTH', '']) expect(mastTargetOf(b)).toBeNull();
  });
});

describe('MAST request and response parsing', () => {
  it('builds a Mast.Caom.Filtered GET with the collection, target and a time window in MJD', () => {
    const since = Date.parse('2022-11-16T00:00:00Z');
    const u = new URL(mastUrl('HST', 'JUPITER', since));
    expect(u.origin + u.pathname).toBe('https://mast.stsci.edu/api/v0/invoke');
    const req = JSON.parse(u.searchParams.get('request')!);
    expect(req.service).toBe('Mast.Caom.Filtered');
    const f = Object.fromEntries(req.params.filters.map((x: { paramName: string; values: unknown[] }) => [x.paramName, x.values]));
    expect(f.obs_collection).toEqual(['HST']);
    expect(f.dataproduct_type).toEqual(['image']);
    expect(f.target_name).toEqual(['JUPITER']);
    expect(f.t_min).toEqual([{ min: 59899, max: 99999 }]);
    expect(sourceForUrl(u.toString())).toBe('mast');
  });

  it('converts MJD to ms', () => {
    expect(mjdToMs(40587)).toBe(0);
    expect(mjdToMs(60321.5)).toBe(Date.parse('2024-01-12T12:00:00Z'));
    expect(msToMjd(Date.parse('2024-01-12T12:00:00Z'))).toBeCloseTo(60321.5, 6);
  });

  it('parses the real HST fixture into preview rows', () => {
    const p = parseMast(HST);
    expect(p.total).toBe(56);
    expect(p.rows.length).toBe(56);
    const r = p.rows[0];
    expect(r.id).toBe('if9i06o0q');
    expect(r.thumbUrl).toBe(previewUrl('mast:HST/product/if9i06o0q_flt.jpg'));
    expect(r.thumbUrl).toBe('https://mast.stsci.edu/api/v0.1/Download/file?uri=mast%3AHST%2Fproduct%2Fif9i06o0q_flt.jpg');
    expect(r.pageUrl).toBe(portalUrl('if9i06o0q'));
    expect(r.instrument).toBe('WFC3/UVIS');
    expect(r.filters).toBe('F502N');
    expect(r.exposureS).toBe(4);
    expect(r.program).toBe('17495');
    expect(new Date(r.tMs).toISOString().slice(0, 10)).toBe('2023-12-10');
  });

  it('rejects a wrong shape, a non-COMPLETE status and non-JSON', () => {
    expect(() => parseMast('<html>oops</html>')).toThrow(/non-JSON/);
    expect(() => parseMast('{"status":"ERROR","msg":"bad filter","data":[]}')).toThrow(/unexpected status ERROR: bad filter/);
    expect(() => parseMast('{"status":"COMPLETE","data":{}}')).toThrow(/unexpected status/);
    expect(parseMast('{"status":"COMPLETE","data":[{"obs_id":"x","t_min":1}]}').rows).toEqual([]); // no jpegURL: not an image row
  });
});

describe('selecting images', () => {
  it('sorts newest first, caps the list and keeps one row per day, instrument and filter', () => {
    const rows = parseMast(HST).rows;
    const out = selectImages(rows);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(ARCHIVE_IMAGE_CAP);
    for (let i = 1; i < out.length; i++) expect(out[i - 1].tMs).toBeGreaterThanOrEqual(out[i].tMs);
    const keys = out.map((r) => `${Math.floor(r.tMs / 86_400_000)}|${r.instrument}|${r.filters}`);
    expect(new Set(keys).size).toBe(keys.length);
    const perDay = new Map<number, number>();
    for (const r of out) perDay.set(Math.floor(r.tMs / 86_400_000), (perDay.get(Math.floor(r.tMs / 86_400_000)) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(PER_DAY_CAP);
    expect(Math.floor(out[0].tMs / 86_400_000)).toBe(Math.floor(Math.max(...rows.map((r) => r.tMs)) / 86_400_000));
    expect(selectImages(rows, 3)).toHaveLength(3);
  });

  it('prefers the combined product over the raw one of the same day, instrument and filter (JWST fixture)', () => {
    const rows = parseMast(JWST).rows;
    const out = selectImages(rows);
    expect(out.length).toBeGreaterThan(0);
    // the newest exposure group has an uncalibrated (level 1) and a combined (level 3) preview of F277W/F150W: a level 3 row wins where both exist
    const cal = new Map(rows.map((r) => [r.id, r.calib]));
    const keyOf = (r: { tMs: number; instrument: string; filters: string }) => `${Math.floor(r.tMs / 86_400_000)}|${r.instrument}|${r.filters}`;
    for (const o of out) {
      const rivals = rows.filter((r) => keyOf(r) === keyOf(o));
      expect(cal.get(o.id)).toBe(Math.max(...rivals.map((r) => r.calib)));
    }
  });

  it('breaks a calibration and exposure tie by the longer exposure, and removes only exact duplicates of the key', () => {
    const base: MastRow = { id: 'a', thumbUrl: 't', fullUrl: 't', pageUrl: 'p', tMs: Date.parse('2025-01-01T01:00:00Z'), instrument: 'I', filters: 'F1', exposureS: 10, calib: 2 };
    const out = selectImages([
      base, { ...base, id: 'b', exposureS: 50 }, { ...base, id: 'c', filters: 'F2' }, { ...base, id: 'd', tMs: base.tMs + 86_400_000 },
    ]);
    expect(out.map((r) => r.id)).toEqual(['d', 'b', 'c']);
  });
});

function setup(responses: Record<string, string | Response> = {}) {
  const store = new Store(':memory:');
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const key = url.includes('JWST') ? 'JWST' : 'HST';
    const r = responses[key] ?? (key === 'JWST' ? JWST : HST);
    return r instanceof Response ? r.clone() : new Response(r, { status: 200 });
  });
  const http = new Http(store, { fetch: fetchMock });
  let now = Date.parse('2026-11-16T12:00:00Z');
  const svc = new ArchiveImagesService({ store, http }, { now: () => now });
  return { store, fetchMock, http, svc, advance: (ms: number) => { now += ms; } };
}

describe('ArchiveImagesService', () => {
  it('returns Hubble images of Jupiter and serves the second ask from the cache without a request', async () => {
    const { svc, fetchMock } = setup();
    const a = await svc.get(hubble, 'JUPITER');
    expect(a.status).toBe('ok');
    expect(a.archive).toMatchObject({ id: 'mast-hst', label: 'MAST (Hubble)' });
    expect(a.observatoryId).toBe('sat-20580');
    expect(a.body).toBe('JUPITER');
    expect(a.images.length).toBeGreaterThan(0);
    expect(a.total).toBe(56);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const b = await svc.get(hubble, 'jupiter');
    expect(b.fromCache).toBe(true);
    expect(b.images).toEqual(a.images);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = new URL(String(fetchMock.mock.calls[0][0]));
    expect(JSON.parse(sent.searchParams.get('request')!).params.filters[0]).toEqual({ paramName: 'obs_collection', values: ['HST'] });
    expect(WINDOW_YEARS).toBe(4);
  });

  it('asks JWST for the JWST collection', async () => {
    const { svc, fetchMock } = setup();
    const r = await svc.get(jwst, 'JUPITER');
    expect(r.status).toBe('ok');
    expect(r.archive?.id).toBe('mast-jwst');
    expect(String(fetchMock.mock.calls[0][0])).toContain('JWST');
  });

  it('says unsupported with a reason, and sends no request, for Chandra, TESS, Paranal and an unmapped site', async () => {
    const { svc, fetchMock } = setup();
    for (const o of [chandra, paranal, rubin, { id: 'dsn-TESS', name: 'TESS', aliases: { dsn: 'TESS' } }]) {
      const r = await svc.get(o, 'JUPITER');
      expect(r.status).toBe('unsupported');
      expect(r.images).toEqual([]);
      expect(r.reason).toBeTruthy();
    }
    expect((await svc.get(rubin, 'JUPITER')).archive).toBeNull();
    expect((await svc.get(chandra, 'JUPITER')).archive?.id).toBe('chandra');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers none, without a request, for a body MAST holds no images of', async () => {
    const { svc, fetchMock } = setup();
    const r = await svc.get(hubble, 'MOON');
    expect(r).toMatchObject({ status: 'none', images: [] });
    expect(r.reason).toMatch(/Moon/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers none with a reason when the archive returns no rows', async () => {
    const { svc } = setup({ HST: '{"status":"COMPLETE","msg":"","data":[],"paging":{"rowsFiltered":0}}' });
    const r = await svc.get(hubble, 'NEPTUNE');
    expect(r.status).toBe('none');
    expect(r.reason).toMatch(/no preview images of Neptune/);
  });

  it('reports an error, gates the source, and does not send again while the gate is closed', async () => {
    const { svc, fetchMock, store } = setup({ HST: new Response('slow down', { status: 429 }) });
    const a = await svc.get(hubble, 'SATURN');
    expect(a.status).toBe('error');
    expect(a.reason).toMatch(/HTTP 429/);
    expect(isBackedOff(readBackoff(store, 'archive-images:mast'), Date.parse('2026-11-16T12:00:00Z'))).toBe(true);
    const calls = fetchMock.mock.calls.length;
    const b = await svc.get(hubble, 'URANUS');
    expect(b.status).toBe('error');
    expect(b.reason).toMatch(/next attempt/);
    expect(b.limitedUntil).toBeGreaterThan(Date.parse('2026-11-16T12:00:00Z'));
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('serves the stale list when the refresh fails after the TTL', async () => {
    const { svc, fetchMock, store } = setup();
    const first = await svc.get(hubble, 'JUPITER');
    expect(first.status).toBe('ok');
    // age the cache row past its TTL
    const key = 'archive-images:v1:HST:JUPITER:4y';
    store.set(key, store.get(key)!.value, TTL_MS, Date.now() - TTL_MS - 1000);
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }));
    const again = await svc.get(hubble, 'JUPITER');
    expect(again.images).toEqual(first.images);
  });

  it('with the gate closed serves the stale list and sends no request (the gate is not bypassed by a cached row)', async () => {
    const { svc, fetchMock, store } = setup();
    await svc.get(hubble, 'JUPITER');
    const key = 'archive-images:v1:HST:JUPITER:4y';
    store.set(key, store.get(key)!.value, TTL_MS, Date.now() - TTL_MS - 1000);
    fetchMock.mockImplementation(async () => new Response('slow down', { status: 429 }));
    await svc.get(hubble, 'JUPITER'); // stale: refresh fails, gate closes
    const calls = fetchMock.mock.calls.length;
    const again = await svc.get(hubble, 'JUPITER');
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(again.status).toBe('ok');
    expect(again.images.length).toBeGreaterThan(0);
    expect(again.fromCache).toBe(true);
    expect(again.limitedUntil).toBeGreaterThan(Date.parse('2026-11-16T12:00:00Z'));
    expect(again.reason).toMatch(/next attempt/);
  });

  it('OFFLINE never closes the failure gate', async () => {
    const store = new Store(':memory:');
    const svc = new ArchiveImagesService({ store, http: new Http(store, { offline: true }) });
    await svc.get(hubble, 'JUPITER');
    expect(readBackoff(store, 'archive-images:mast')).toBeUndefined();
  });

  it('OFFLINE with nothing cached is an error answer, not a thrown one', async () => {
    const store = new Store(':memory:');
    const svc = new ArchiveImagesService({ store, http: new Http(store, { offline: true }) });
    const r = await svc.get(hubble, 'JUPITER');
    expect(r.status).toBe('error');
    expect(r.reason).toMatch(/offline/);
  });
});

describe('GET /api/archive-images', () => {
  async function app(responses?: Record<string, string>) {
    const s = setup(responses);
    const hub = new Hub();
    hub.upsert({ id: 'sat-20580', name: 'HST', kind: 'satellite', bodyId: 'EARTH', aliases: { norad: '20580' }, group: 'active', render: { colorKey: 'satellite' } });
    const server = Fastify();
    registerApi(server, hub, s.http, undefined, undefined, undefined, undefined, s.svc);
    return { server, ...s };
  }

  it('answers images for a known observatory and body', async () => {
    const { server } = await app();
    const res = await server.inject({ url: '/api/archive-images?observatory=sat-20580&body=JUPITER' });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j).toMatchObject({ observatoryId: 'sat-20580', body: 'JUPITER', status: 'ok' });
    expect(j.images[0].thumbUrl).toMatch(/^https:\/\/mast\.stsci\.edu\/api\/v0\.1\/Download\/file\?uri=/);
  });

  it('400 without parameters or with a malformed body, 404 for an unknown observatory', async () => {
    const { server } = await app();
    expect((await server.inject({ url: '/api/archive-images' })).statusCode).toBe(400);
    expect((await server.inject({ url: '/api/archive-images?observatory=sat-20580&body=../x' })).statusCode).toBe(400);
    expect((await server.inject({ url: '/api/archive-images?observatory=nope&body=JUPITER' })).statusCode).toBe(404);
  });
});
