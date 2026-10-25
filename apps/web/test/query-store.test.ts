import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityRecord } from '@eio/core';
import { termWord } from '../src/lib/query';

const rec = (id: string, name: string, kind: string, group: string): EntityRecord => ({ id, name, kind, group, aliases: {}, bodyId: 'EARTH', updatedAt: 0 });
const CATALOG = [
  rec('sat-1', 'ISS (ZARYA)', 'station', 'stations'),
  rec('sat-2', 'STARLINK-1007', 'satellite', 'starlink'),
  rec('sat-3', 'STARLINK-1008', 'satellite', 'starlink'),
  rec('sat-4', 'COSMOS 2251 DEB', 'debris', 'cosmos-2251-debris'),
];

const mem = (init: Record<string, string> = {}) => {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};

const saved = globalThis.localStorage;
const install = (m: unknown) => { (globalThis as { localStorage?: unknown }).localStorage = m; };
/** a fresh store module, as at page load, over this storage */
async function freshStore(storage: ReturnType<typeof mem>) {
  install(storage);
  vi.resetModules();
  return (await import('../src/state/store')).useStore;
}

beforeEach(() => install(undefined));
afterEach(() => install(saved));

describe('query state', () => {
  it('toggles terms, keeps the text term and clears: CLEAR keeps the hidden groups, SHOW ALL keeps the rest', async () => {
    const s = (await freshStore(mem())).getState;
    s().toggleTerm('kind', 'probe');
    s().toggleTerm('cat', 'debris', 'hide');
    s().setText('iss');
    expect(s().query.terms.map(termWord)).toEqual(['kind:probe', 'cat:debris', 'iss']);
    s().toggleTerm('kind', 'probe', 'hide'); // an only term switched by the eye
    expect(s().query.terms.map((t) => t.effect)).toEqual(['hide', 'hide', 'only']);
    s().toggleTerm('kind', 'probe', 'hide'); // and the eye again removes it
    s().clearQuery();
    expect(s().query.terms.map(termWord)).toEqual(['cat:debris']);
    s().setText('x');
    s().showAll();
    expect(s().query.terms.map(termWord)).toEqual(['x']);
    s().clearQuery(true);
    expect(s().query.terms).toEqual([]);
  });

  it('does not touch the state for an equal query', async () => {
    const s = (await freshStore(mem())).getState;
    s().toggleTerm('kind', 'probe');
    const q = s().query;
    s().addTerms([{ key: 'kind', value: 'probe', effect: 'only' }]);
    s().setText('');
    expect(s().query).toBe(q);
  });

  it('looks the text up once per change: ranked hits and their ids, following the catalog', async () => {
    const store = await freshStore(mem());
    const s = store.getState;
    store.setState({ entities: new Map(CATALOG.map((r) => [r.id, r])) });
    expect(s().textHits).toBeNull();
    s().setText('starlink');
    expect(s().textHits?.map((h) => h.id)).toEqual(['sat-2', 'sat-3']);
    expect([...s().textIds!]).toEqual(['sat-2', 'sat-3']);
    s().setText('starlink'); // same text: same lookup
    const hits = s().textHits;
    s().toggleTerm('kind', 'probe');
    expect(s().textHits).toBe(hits);
    s().upsertEntities([rec('sat-5', 'STARLINK-1009', 'satellite', 'starlink')]);
    expect(s().textHits?.map((h) => h.id)).toEqual(['sat-2', 'sat-3', 'sat-5']);
    s().setText('');
    expect(s().textHits).toBeNull();
    expect(s().textIds).toBeNull();
  });

  it('remembers the tag terms and their effects in eio.query, not the text', async () => {
    const storage = mem();
    const s = (await freshStore(storage)).getState;
    s().toggleTerm('group', 'starlink');
    s().toggleTerm('cat', 'debris', 'hide');
    s().setText('iss');
    expect(JSON.parse(storage.data.get('eio.query')!).terms).toEqual([
      { key: 'group', value: 'starlink', effect: 'only' },
      { key: 'cat', value: 'debris', effect: 'hide' },
    ]);
    const back = (await freshStore(storage)).getState();
    expect(back.query.terms.map((t) => `${termWord(t)}/${t.effect}`)).toEqual(['group:starlink/only', 'cat:debris/hide']);
  });

  it('turns a stored eio.hidden into hide terms once and deletes the key', async () => {
    const storage = mem({ 'eio.hidden': '{"cat":["debris"],"group":["starlink"]}' });
    const s = (await freshStore(storage)).getState();
    expect(s.query.terms.map((t) => `${termWord(t)}/${t.effect}`)).toEqual(['group:starlink/hide', 'cat:debris/hide']);
    expect(storage.data.has('eio.hidden')).toBe(false);
    expect(JSON.parse(storage.data.get('eio.query')!).terms).toHaveLength(2);
    // the terms are merged into an existing query; a malformed old value just disappears
    const both = mem({ 'eio.query': '{"terms":[{"key":"kind","value":"probe","effect":"only"}]}', 'eio.hidden': 'garbage' });
    const t = (await freshStore(both)).getState();
    expect(t.query.terms.map(termWord)).toEqual(['kind:probe']);
    expect(both.data.has('eio.hidden')).toBe(false);
  });

  it('survives blocked storage', async () => {
    const blocked = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('y'); }, removeItem: () => { throw new Error('z'); } };
    install(blocked);
    vi.resetModules();
    const store = (await import('../src/state/store')).useStore;
    expect(store.getState().query.terms).toEqual([]);
    expect(() => { store.getState().toggleTerm('kind', 'probe'); store.getState().setHighlight(true); }).not.toThrow();
  });
});

describe('HIGHLIGHT', () => {
  it('is off by default, switches and is remembered', async () => {
    const storage = mem();
    const store = await freshStore(storage);
    expect(store.getState().highlight).toBe(false);
    store.getState().setHighlight(true);
    expect(store.getState().highlight).toBe(true);
    expect(storage.data.get('eio.highlight')).toBe('on');
    expect((await freshStore(storage)).getState().highlight).toBe(true);
    (await freshStore(storage)).getState().setHighlight(false);
    expect(storage.data.get('eio.highlight')).toBe('off');
  });
});
