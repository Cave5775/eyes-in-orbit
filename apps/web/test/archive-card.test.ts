import type { ArchiveImage, ArchiveImagesResult, EntityRecord } from '@eio/core';
import { describe, expect, it, vi } from 'vitest';
import { captionOf, cardBody, cardTitle, cardView, createArchiveCache, dateOf, stepIndex } from '../src/lib/archive-card';
import { createMockApi } from '../src/mock/mock-api';

const body = (id: string, kind: string): Pick<EntityRecord, 'kind' | 'provider'> => ({ kind, provider: { type: 'body', bodyId: id } } as never);

const img: ArchiveImage = {
  id: 'ie8d08wvq', thumbUrl: 't', fullUrl: 'f', pageUrl: 'p', tMs: Date.parse('2020-07-24T08:17:00Z'), instrument: 'WFC3/UVIS', filters: 'F225W', exposureS: 40, program: '16053',
};
const result = (over: Partial<ArchiveImagesResult>): ArchiveImagesResult => ({
  observatoryId: 'sat-20580', observatory: 'HST', body: 'JUPITER', archive: { id: 'mast-hst', label: 'MAST (Hubble)', url: 'https://mast.stsci.edu/' },
  status: 'ok', images: [img], fetchedAt: 0, ...over,
});

describe('cardBody', () => {
  it('opens for the Sun, planets, dwarf planets and the Moon only', () => {
    expect(cardBody(body('JUPITER', 'planet'))).toBe('JUPITER');
    expect(cardBody(body('PLUTO', 'dwarf_planet'))).toBe('PLUTO');
    expect(cardBody(body('SUN', 'star'))).toBe('SUN');
    expect(cardBody(body('MOON', 'moon'))).toBe('MOON');
    expect(cardBody(body('IO', 'moon'))).toBeNull();
    expect(cardBody(body('EARTH', 'planet'))).toBeNull();
    expect(cardBody({ kind: 'satellite', provider: { type: 'sgp4' } } as never)).toBeNull();
    expect(cardBody(undefined)).toBeNull();
  });
});

describe('card text', () => {
  it('titles it "<Body> by <Observatory>"', () => {
    expect(cardTitle('Jupiter', 'HST')).toBe('Jupiter by HST');
  });

  it('has a view for every state', () => {
    expect(cardView('HST', null, null)).toMatchObject({ kind: 'loading' });
    expect(cardView('HST', result({}), null)).toMatchObject({ kind: 'ok', text: '1 image, newest first, from MAST (Hubble)' });
    expect(cardView('HST', result({ images: [img, img] }), null).text).toMatch(/^2 images/);
    expect(cardView('HST', result({ status: 'none', images: [], reason: 'nothing here' }), null)).toEqual({ kind: 'none', text: 'nothing here' });
    expect(cardView('Paranal', result({ status: 'unsupported', images: [], reason: 'x' }), null)).toEqual({
      kind: 'unsupported', text: "Paranal's archive has no public preview service here.",
    });
    expect(cardView('HST', result({ status: 'error', images: [], reason: 'HTTP 503', limitedUntil: Date.parse('2026-11-16T14:30:00Z') }), null).text).toBe('HTTP 503 Try again at 14:30Z.');
    expect(cardView('HST', null, 'HTTP 502')).toMatchObject({ kind: 'error' });
  });

  it('captions with date, instrument, filter and exposure', () => {
    expect(dateOf(img.tMs)).toBe('2020-07-24');
    expect(captionOf(img)).toBe('2020-07-24  ·  WFC3/UVIS  ·  F225W  ·  40 s');
    expect(captionOf({ ...img, filters: '', exposureS: 1069.04 })).toBe('2020-07-24  ·  WFC3/UVIS  ·  1069 s');
    expect(captionOf({ ...img, exposureS: undefined })).toBe('2020-07-24  ·  WFC3/UVIS  ·  F225W');
  });

  it('steps the lightbox with wrap-around and stays closed when closed', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(-1, 3, 1)).toBe(-1);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe('createArchiveCache', () => {
  it('shares one request per observatory and body, and forgets an error answer or a failure', async () => {
    let t = 0;
    const load = vi.fn(async (_o: string, _b: string) => result({}));
    const c = createArchiveCache(load, { now: () => t, reuseMs: 1000 });
    await Promise.all([c.get('a', 'JUPITER'), c.get('a', 'JUPITER')]);
    expect(load).toHaveBeenCalledTimes(1);
    await c.get('a', 'SATURN');
    expect(load).toHaveBeenCalledTimes(2);
    t = 2000;
    await c.get('a', 'JUPITER');
    expect(load).toHaveBeenCalledTimes(3);

    load.mockResolvedValueOnce(result({ status: 'error', images: [] }));
    await c.get('b', 'MARS');
    await Promise.resolve();
    await c.get('b', 'MARS');
    expect(load).toHaveBeenCalledTimes(5);
    load.mockRejectedValueOnce(new Error('down'));
    await expect(c.get('c', 'MARS')).rejects.toThrow('down');
    await c.get('c', 'MARS');
    expect(load).toHaveBeenCalledTimes(7);
  });
});

describe('mock archive images', () => {
  const api = createMockApi(Date.parse('2026-11-16T12:00:00Z'), 50);

  it('serves Hubble and JWST images of Jupiter from the real fixtures, newest first', async () => {
    for (const id of ['sat-20580', 'dsn-JWST']) {
      const r = await api.archiveImages(id, 'JUPITER');
      expect(r.status).toBe('ok');
      expect(r.images.length).toBeGreaterThan(5);
      expect(r.images[0].thumbUrl).toMatch(/^https:\/\/mast\.stsci\.edu\//);
      for (let i = 1; i < r.images.length; i++) expect(r.images[i - 1].tMs).toBeGreaterThanOrEqual(r.images[i].tMs);
    }
    expect((await api.archiveImages('sat-20580', 'JUPITER')).archive?.id).toBe('mast-hst');
    expect((await api.archiveImages('dsn-JWST', 'JUPITER')).archive?.id).toBe('mast-jwst');
  });

  it('answers unsupported for a ground site and Chandra, none for other bodies, and rejects an unknown observatory', async () => {
    expect((await api.archiveImages('obs-paranal', 'JUPITER')).status).toBe('unsupported');
    expect((await api.archiveImages('obs-rubin', 'JUPITER')).archive).toBeNull();
    expect((await api.archiveImages('dsn-CHDR', 'SATURN')).status).toBe('unsupported');
    expect((await api.archiveImages('sat-20580', 'MOON')).status).toBe('none');
    expect((await api.archiveImages('sat-20580', 'SATURN')).status).toBe('none');
    await expect(api.archiveImages('nope', 'JUPITER')).rejects.toThrow(/unknown entity/);
  });
});
