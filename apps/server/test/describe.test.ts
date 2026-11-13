import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyFeed, composeFallback, isTrustedDescribeUrl, type EntityRecord } from '@eio/core';
import { Credentials } from '../src/credentials';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerApi } from '../src/api';
import { loadConfig } from '../src/config';
import { DescribeService, ERROR_TTL_MS, HIT_TTL_MS, MAX_QUEUE, MISS_TTL_MS } from '../src/describe/service';
import {
  discosUrl, parseDiscos, parseWikidataEntities, parseWikidataNameSearch, parseWikidataSearch, parseWikipediaSummary, pickWikidataItem,
  uniqueSpaceCandidate, wikidataEntitiesUrl, wikidataSearchUrl, wikipediaSummaryUrl,
} from '../src/describe/sources';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { Store } from '../src/store';

const fx = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const SEARCH = fx('wikidata-search-p377-25544.json');
const MISS = fx('wikidata-search-miss.json');
const ENTITIES = fx('wikidata-entities-iss.json');
const SUMMARY = fx('wikipedia-summary-iss.json');
const NAME_SEARCH = fx('wikidata-wbsearch-voyager-1.json');
const DISCOS = fx('discos-object-docs-shape.json');

const DAY = 86_400_000;

const iss: EntityRecord = {
  id: 'sat-25544', name: 'ISS (ZARYA)', kind: 'station', bodyId: 'EARTH', group: 'stations', updatedAt: 0,
  aliases: { norad: '25544', cospar: '1998-067A', common: 'ISS' },
};

describe('describe parsers (fixtures: real Wikidata and Wikipedia responses)', () => {
  it('reads item ids from the P377 search, and an empty list for a miss', () => {
    expect(parseWikidataSearch(SEARCH)).toEqual(['Q25271', 'Q331785']);
    expect(parseWikidataSearch(MISS)).toEqual([]);
    expect(wikidataSearchUrl(25544)).toContain('haswbstatement%3AP377%3D25544');
  });

  it('reads label, English article and catalogue ids from wbgetentities', () => {
    const items = parseWikidataEntities(ENTITIES);
    expect(items.find((i) => i.id === 'Q25271')).toMatchObject({
      label: 'International Space Station', enwiki: 'International Space Station', norad: ['25544'], cospar: ['1998-067A'],
    });
    expect(items.find((i) => i.id === 'Q331785')).toMatchObject({ enwiki: 'Zarya (ISS module)', cospar: [] });
    expect(wikidataEntitiesUrl(['Q1', 'Q2'])).toContain('ids=Q1|Q2');
  });

  it('picks the ISS over its Zarya module by COSPAR id, and refuses to guess otherwise', () => {
    const items = parseWikidataEntities(ENTITIES);
    expect(pickWikidataItem(items, { name: 'ISS (ZARYA)', cospar: '1998-067A', norad: 25544 })?.id).toBe('Q25271');
    expect(pickWikidataItem(items, { name: 'Zarya', norad: 25544 })?.id).toBe('Q331785');
    expect(pickWikidataItem(items, { name: 'ISS (ZARYA)', norad: 25544 })).toBeNull();
    expect(pickWikidataItem(items.slice(0, 1), { name: 'whatever', norad: 25544 })?.id).toBe('Q25271');
  });

  it('finds the one spacecraft among same-named Wikidata items (Voyager 1 is also an EP, a comic and a game)', () => {
    const cands = parseWikidataNameSearch(NAME_SEARCH);
    expect(cands.length).toBe(5);
    expect(uniqueSpaceCandidate(cands, 'Voyager 1')?.id).toBe('Q48469');
    expect(uniqueSpaceCandidate(cands, 'Voyager 2')).toBeNull();
    expect(uniqueSpaceCandidate([...cands, { ...cands[1], id: 'Q1' }], 'Voyager 1')).toBeNull();
  });

  it('reads the Wikipedia summary: text, page link, blurb and a small https thumbnail', () => {
    const s = parseWikipediaSummary(SUMMARY)!;
    expect(s.title).toBe('International Space Station');
    expect(s.text).toMatch(/^The International Space Station \(ISS\) is a space station/);
    expect(s.url).toBe('https://en.wikipedia.org/wiki/International_Space_Station');
    expect(s.blurb).toBe('Modular space station in low Earth orbit');
    expect(s.thumbnail).toMatchObject({ width: 330, height: 219 });
    expect(s.thumbnail!.url).toMatch(/^https:\/\//);
    expect(wikipediaSummaryUrl('Zarya (ISS module)')).toBe('https://en.wikipedia.org/api/rest_v1/page/summary/Zarya_(ISS_module)');
  });

  it('drops disambiguation pages and rejects wrong shapes with a classifiable message', () => {
    expect(parseWikipediaSummary(JSON.stringify({ type: 'disambiguation', title: 'Io', extract: 'Io may refer to:' }))).toBeNull();
    expect(() => parseWikipediaSummary('{}')).toThrow(/unexpected Wikipedia summary response/);
    expect(() => parseWikidataSearch('[]')).toThrow(/unexpected Wikidata search response/);
    expect(() => parseWikidataEntities('<html>')).toThrow(/unexpected Wikidata entities response/);
    expect(() => parseDiscos('{"errors":[]}')).toThrow(/unexpected DISCOS response/);
  });

  it('reads DISCOS facts from the documented JSON:API shape (docs-shaped fixture, not a live answer)', () => {
    const o = parseDiscos(DISCOS)!;
    const facts = Object.fromEntries(o.facts.map((f) => [f.label, f.value]));
    expect(facts).toMatchObject({
      'Object class': 'Payload', Mass: '1234.5 kg', Shape: 'Box + 2 Sol Pnl', Size: '2 m x 3 m x 1.5 m', Span: '12.5 m', Operator: 'Fixture Space Agency',
      Status: 'active', 'First epoch': '2099-01-02',
    });
    expect(facts['Predicted decay']).toBeUndefined();
    expect(o.url).toBe('https://discosweb.esoc.esa.int/objects/99001');
    expect(parseDiscos('{"data":[]}')).toBeNull();
    expect(discosUrl(25544)).toBe('https://discosweb.esoc.esa.int/api/objects?filter=eq(satno%2C25544)&include=operators');
  });
});

describe('URL allow-list', () => {
  it('accepts https on the Wikimedia and DISCOS hosts only', () => {
    expect(isTrustedDescribeUrl('https://en.wikipedia.org/wiki/X')).toBe(true);
    expect(isTrustedDescribeUrl('https://upload.wikimedia.org/a.jpg')).toBe(true);
    expect(isTrustedDescribeUrl('https://discosweb.esoc.esa.int/objects/1')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'http://en.wikipedia.org/x', 'https://evil.example/x', 'https://wikipedia.org.evil.example/x', 'https://user:pw@en.wikipedia.org/x', 'data:text/html,x', 'nope', undefined]) {
      expect(isTrustedDescribeUrl(bad), String(bad)).toBe(false);
    }
  });

  it('drops a foreign thumbnail and replaces a foreign page link in the Wikipedia parser', () => {
    const j = JSON.parse(SUMMARY);
    j.thumbnail.source = 'https://evil.example/x.png';
    j.content_urls.desktop.page = 'javascript:alert(1)';
    const s = parseWikipediaSummary(JSON.stringify(j))!;
    expect(s.thumbnail).toBeUndefined();
    expect(s.url).toBe('https://en.wikipedia.org/wiki/International_Space_Station');
  });
});

describe('composeFallback', () => {
  it('uses only what the entity carries', () => {
    expect(composeFallback(iss)).toBe('ISS (ZARYA) is a station in the "stations" group, launched in 1998. International designator 1998-067A, NORAD catalogue number 25544.');
  });
  it('copes with an object that has no ids', () => {
    const odd: EntityRecord = { id: 'x', name: 'Odd', kind: 'launch_vehicle', bodyId: 'EARTH', aliases: {}, updatedAt: 0 };
    expect(composeFallback(odd)).toBe('Odd is a launch vehicle.');
  });
});

describe('DescribeService', () => {
  let now: number;
  let store: Store;
  let hub: Hub;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let routes: Record<string, () => Response>;

  const reply = (body: string, status = 200) => () => new Response(body, { status });
  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  const make = (env: NodeJS.ProcessEnv = {}) => {
    const config = loadConfig(env);
    const http = new Http(store, { fetch: fetchMock, offline: config.offline });
    const svc = new DescribeService({ store, http, config, hub }, { spacingMs: { wikipedia: 0, discos: 0 }, sleep: async () => {}, now: () => now });
    return { config, svc };
  };

  beforeEach(() => {
    now = 1_800_000_000_000;
    store = new Store(':memory:');
    hub = new Hub(0);
    routes = {
      'list=search': reply(SEARCH),
      wbgetentities: reply(ENTITIES),
      'page/summary/International_Space_Station': reply(SUMMARY),
      'discosweb.esoc.esa.int': reply(DISCOS),
    };
    fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const key = Object.keys(routes).find((k) => url.includes(k));
      return key ? routes[key]() : new Response('not found', { status: 404 });
    });
  });

  it('chains Wikidata (P377) to the Wikipedia summary, skips DISCOS without a token, and says so in health', async () => {
    const { svc } = make();
    const d = await svc.describe(iss);
    expect(urls()).toHaveLength(3);
    expect(d.wikidata).toMatchObject({ id: 'Q25271', url: 'https://www.wikidata.org/wiki/Q25271' });
    expect(d.summary?.title).toBe('International Space Station');
    expect(d.sources).toEqual({ wikidata: 'ok', wikipedia: 'ok', discos: 'off' });
    expect(d.discos).toBeUndefined();
    expect(d.fallback).toContain('NORAD catalogue number 25544');
    expect(d.searchUrl).toBe('https://en.wikipedia.org/w/index.php?search=ISS%20(ZARYA)');
    const byId = Object.fromEntries(hub.healthList().map((h) => [h.id, h]));
    expect(byId.discos.feed).toMatchObject({ level: 'off', reason: 'no-credentials' });
    expect(byId.wikipedia.feed).toMatchObject({ level: 'ok' });
  });

  it('adds DISCOS facts with a bearer token and re-asks once when a token appears after a cached answer', async () => {
    const { svc, config } = make();
    await svc.describe(iss);
    expect(urls().some((u) => u.includes('discosweb'))).toBe(false);
    config.discosToken = 'secret-token';
    svc.syncHealth();
    expect(hub.healthOf('discos').status).toBe('idle');
    fetchMock.mockClear();
    const d = await svc.describe(iss);
    expect(d.sources.discos).toBe('ok');
    expect(d.discos?.facts.find((f) => f.label === 'Mass')?.value).toBe('1234.5 kg');
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('discosweb'))!;
    const headers = call[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-token');
    expect(headers['discosweb-api-version']).toBe('2');
    fetchMock.mockClear();
    expect((await svc.describe(iss)).fromCache).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves a hit from the cache for 30 days, then asks again', async () => {
    const { svc } = make();
    await svc.describe(iss);
    fetchMock.mockClear();
    now += HIT_TTL_MS - DAY;
    expect((await svc.describe(iss)).fromCache).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    now += 2 * DAY;
    await svc.describe(iss);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('caches a miss for 7 days (no repeated lookups for an unknown object)', async () => {
    routes['list=search'] = reply(MISS);
    const { svc } = make();
    const unknown: EntityRecord = { ...iss, id: 'sat-99999', aliases: { norad: '99999' } };
    const d = await svc.describe(unknown);
    expect(d.summary).toBeUndefined();
    expect(d.sources.wikidata).toBe('miss');
    expect(urls()).toHaveLength(1);
    fetchMock.mockClear();
    now += MISS_TTL_MS - DAY;
    await svc.describe(unknown);
    expect(fetchMock).not.toHaveBeenCalled();
    now += 2 * DAY;
    await svc.describe(unknown);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a 404 article as a miss, not an error', async () => {
    delete routes['page/summary/International_Space_Station'];
    routes['page/summary'] = reply('{"title":"Not found."}', 404);
    const { svc } = make();
    const d = await svc.describe(iss);
    expect(d.sources.wikipedia).toBe('miss');
    expect(hub.healthOf('wikipedia').status).toBe('ok');
  });

  it('shares one lookup between concurrent requests for the same object', async () => {
    const { svc } = make();
    const [a, b, c] = await Promise.all([svc.describe(iss), svc.describe(iss), svc.describe(iss)]);
    expect(urls()).toHaveLength(3);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('spaces requests to one source', async () => {
    const sleeps: number[] = [];
    const config = loadConfig({});
    const http = new Http(store, { fetch: fetchMock });
    const svc = new DescribeService({ store, http, config, hub }, { spacingMs: { wikipedia: 600, discos: 0 }, sleep: async (ms) => void sleeps.push(ms), now: () => now });
    await svc.describe(iss);
    expect(sleeps.length).toBe(2);
    expect(sleeps.every((ms) => ms === 600)).toBe(true);
  });

  it('keeps a source error out of the long cache, reports it in health, and closes the gate after a 429', async () => {
    routes['list=search'] = reply('slow down', 429);
    const { svc } = make();
    const d = await svc.describe(iss);
    expect(d.sources.wikidata).toBe('error');
    expect(d.fallback).toBeTruthy();
    expect(hub.healthOf('wikipedia')).toMatchObject({ status: 'error', failures: 1 });
    expect(classifyFeed(hub.healthOf('wikipedia')).reason).toBe('rate-limited');
    fetchMock.mockClear();
    now += ERROR_TTL_MS + 1000; // the short error cache expired, the persistent gate (hours) has not
    const e = await svc.describe(iss);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(e.sources.wikidata).toBe('error');
    expect(hub.healthOf('wikipedia').lastError).toMatch(/waiting until \d\d:\d\dZ/);
  });

  it('reports a malformed answer as invalid', async () => {
    routes['list=search'] = reply('{"nope":1}');
    const { svc } = make();
    await svc.describe(iss);
    expect(classifyFeed(hub.healthOf('wikipedia')).reason).toBe('invalid');
  });

  it('finds a probe without a catalogue number by its unique spacecraft label', async () => {
    routes.wbsearchentities = reply(NAME_SEARCH);
    const { svc } = make();
    const probe: EntityRecord = { id: 'dsn-VGR1', name: 'Voyager 1', kind: 'probe', bodyId: 'EARTH', aliases: { dsn: 'VGR1' }, updatedAt: 0 };
    await svc.describe(probe);
    expect(urls()[0]).toContain('wbsearchentities');
    expect(urls()[1]).toContain('ids=Q48469');
  });

  it('never searches by name for an object that is neither catalogued nor a probe, and uses a body name as the article title', async () => {
    const { svc } = make();
    const stage: EntityRecord = { id: 'launch-x-booster', name: 'Falcon 9 (booster)', kind: 'stage', bodyId: 'EARTH', aliases: {}, updatedAt: 0 };
    const d = await svc.describe(stage);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(d.fallback).toBe('Falcon 9 (booster) is a stage.');
    routes['page/summary/Mars'] = reply(SUMMARY);
    await svc.describe({ id: 'body-mars', name: 'Mars', kind: 'planet', bodyId: 'SUN', aliases: {}, updatedAt: 0 });
    expect(urls()).toEqual([wikipediaSummaryUrl('Mars')]);
  });

  it('does not cache an OFFLINE answer: back online the same object is looked up for real', async () => {
    const config = loadConfig({ OFFLINE: '1' });
    const off = new DescribeService({ store, http: new Http(store, { fetch: fetchMock, offline: true }), config, hub }, { spacingMs: { wikipedia: 0, discos: 0 }, sleep: async () => {}, now: () => now });
    expect((await off.describe(iss)).sources.wikipedia).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
    const { svc } = make();
    const d = await svc.describe(iss);
    expect(d.summary?.title).toBe('International Space Station');
    expect(d.fromCache).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('asks DISCOS again after a credential change: gate cleared, cached error and off re-asked', async () => {
    routes['discosweb.esoc.esa.int'] = reply('denied', 401);
    const { svc, config } = make({ DISCOS_TOKEN: 'bad' });
    const creds = new Credentials(config, store);
    expect((await svc.describe(iss)).sources.discos).toBe('error');
    fetchMock.mockClear();
    now += 1000;
    expect((await svc.describe(iss)).fromCache).toBe(true); // same token: the short error cache holds
    expect(fetchMock).not.toHaveBeenCalled();
    routes['discosweb.esoc.esa.int'] = reply(DISCOS);
    creds.update({ discosToken: 'good' });
    svc.syncHealth();
    now += 1000;
    const d = await svc.describe(iss);
    expect(d.sources.discos).toBe('ok');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('discosweb'))).toBe(true);
  });

  it('answers "error" without caching when a source queue is full, and re-checks the gate for queued requests', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    routes['list=search'] = () => new Response(SEARCH);
    fetchMock.mockImplementation(async (input) => {
      await hold;
      const url = String(input);
      const key = Object.keys(routes).find((k) => url.includes(k));
      return key ? routes[key]() : new Response('x', { status: 404 });
    });
    const { svc } = make();
    const recs = Array.from({ length: MAX_QUEUE + 5 }, (_, i): EntityRecord => ({ ...iss, id: `sat-${70000 + i}`, aliases: { norad: String(70000 + i) } }));
    const all = recs.map((r) => svc.describe(r));
    await new Promise((r) => setTimeout(r, 0));
    release();
    const done = await Promise.all(all);
    const busy = done.filter((d) => d.sources.wikidata === 'error');
    expect(busy.length).toBeGreaterThan(0);
    for (const d of busy) expect(store.get(`describe:v1:${d.entityId}`)).toBeUndefined();
    expect(hub.healthOf('wikipedia').status).not.toBe('error');
  });

  it('under OFFLINE=1 serves the fallback with no request', async () => {
    const { svc } = make({ OFFLINE: '1' });
    const d = await svc.describe(iss);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(d.sources).toEqual({ wikidata: 'off', wikipedia: 'off', discos: 'off' });
    expect(d.fallback).toBeTruthy();
  });
});

describe('GET /api/describe/:entityId', () => {
  it('describes a known entity, 404s an unknown one', async () => {
    const store = new Store(':memory:');
    const hub = new Hub(0);
    hub.upsert({ id: 'sat-25544', name: 'ISS (ZARYA)', kind: 'station', bodyId: 'EARTH', aliases: { norad: '25544', cospar: '1998-067A' }, group: 'stations' });
    hub.flush();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const u = String(input);
      return new Response(u.includes('list=search') ? SEARCH : u.includes('wbgetentities') ? ENTITIES : SUMMARY);
    });
    const config = loadConfig({});
    const http = new Http(store, { fetch: fetchMock });
    const svc = new DescribeService({ store, http, config, hub }, { spacingMs: { wikipedia: 0, discos: 0 }, sleep: async () => {} });
    const app = Fastify();
    registerApi(app, hub, http, store, undefined, undefined, svc);
    const ok = await app.inject({ url: '/api/describe/sat-25544' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ entityId: 'sat-25544', norad: 25544, summary: { title: 'International Space Station' } });
    const nope = await app.inject({ url: '/api/describe/sat-1' });
    expect(nope.statusCode).toBe(404);
    await app.close();
  });
});
