import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MPCORB_SAMPLE, readContainer } from '@eio/core';
import { bodies } from '../src/engine/connectors/bodies';
import { createLaunchlibrary } from '../src/engine/connectors/launchlibrary';
import { createMinorPlanets } from '../src/engine/connectors/minor-planets';
import { inProcessLock } from '../src/engine/net/lock';
import { MemoryKv } from '../src/engine/store';
import { RPC_METHODS, type FromWorker, type RpcMethod, type ToWorker, type WorkerEvent } from '../src/workers/data.protocol';
import { createDataService, type DataService, type DataServiceOptions } from '../src/workers/data.service';

const ll2 = () => JSON.parse(readFileSync(new URL('../../server/test/fixtures/ll2-launch.json', import.meta.url), 'utf8'));
const LAUNCH_ID = 'f6af629d-39b5-4f86-bc0c-f8776444a858';
const DAY = 86_400_000;

/** a service on a memory store with a fake network, and a way to call it like the page does */
function harness(over: Partial<DataServiceOptions> = {}) {
  const posted: { msg: FromWorker; transfer?: Transferable[] }[] = [];
  const kv = over.kv ?? new MemoryKv();
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [ll2()] }), { status: 200 }));
  const service: DataService = createDataService({
    post: (msg, transfer) => posted.push({ msg, transfer }),
    kv, fetch: over.fetch ?? fetchMock, withLock: inProcessLock(), jitterMs: 0,
    storage: { persist: async () => true, estimate: async () => ({ usage: 1234, quota: 5_000_000 }) },
    connectors: ({ credentials }) => [bodies, createLaunchlibrary(credentials)],
    ...over,
  });
  let n = 0;
  const rpc = async (method: RpcMethod, ...args: unknown[]): Promise<any> => {
    const id = ++n;
    service.handle({ kind: 'rpc', id, method, args } satisfies ToWorker);
    for (let i = 0; i < 400; i++) {
      const r = posted.find((p) => p.msg.kind === 'result' && p.msg.id === id)?.msg;
      if (r && r.kind === 'result') {
        if (!r.ok) throw Object.assign(new Error(r.error.message), r.error);
        return r.value;
      }
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`no answer to ${method}`);
  };
  const events = (): WorkerEvent[] => posted.flatMap((p) => (p.msg.kind === 'event' ? [p.msg.msg] : []));
  return { service, posted, kv, fetchMock, rpc, events };
}

describe('data worker protocol', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T20:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('answers the Api methods from the engine after the first poll', async () => {
    const h = harness();
    await h.service.ready;
    await vi.advanceTimersByTimeAsync(4000); // the Launch Library connector's first run (two requests, spaced by the limiter)
    const launches = await h.rpc('launches');
    expect(launches).toHaveLength(1);
    expect(launches[0].id).toBe(LAUNCH_ID);

    const page = await h.rpc('entities', undefined, { offset: 0, limit: 5 });
    expect(page.entities.length).toBeGreaterThan(0);
    expect(page.total).toBeGreaterThan(5); // bodies plus the launch entities
    expect((await h.rpc('search', 'earth', 3))[0]).toMatchObject({ id: expect.any(String) });
    const match = await h.rpc('match', 'starlink');
    expect(match).toMatchObject({ q: 'starlink', truncated: false });
    expect(match.ids.some((id: string) => id.startsWith('launch-'))).toBe(true);

    const health = await h.rpc('health');
    expect(health.connectors.find((c: { id: string }) => c.id === 'launchlibrary')).toMatchObject({ status: 'ok' });
    expect(health.entityCount).toBe(page.total);
    expect(health.storage).toEqual({ persistent: false, persisted: true, usageBytes: 1234, quotaBytes: 5_000_000 });

    expect(await h.rpc('ascent', LAUNCH_ID)).toMatchObject({ launchId: expect.anything() });
    expect(await h.rpc('ascent', 'no-such-launch')).toBeNull();
    expect(await h.rpc('traverse', 'no-such-rover')).toBeNull();
    expect(await h.rpc('minorPlanetIndex')).toBeNull();
    await expect(h.rpc('describe', 'no-such-entity')).rejects.toThrow(/unknown entity/);
    await expect(h.rpc('archiveImages', 'x', '../bad')).rejects.toThrow(/required/);
    await h.service.stop();
  });

  it('rejects unknown methods and offers no way to write or clear telemetry', async () => {
    const h = harness();
    await expect(h.rpc('ingestTelemetry' as RpcMethod, 'x', {})).rejects.toThrow(/unknown method/);
    expect(RPC_METHODS.filter((m) => /ingest|telemetry/i.test(m))).toEqual([]);
    await h.service.stop();
  });

  it('on start sends hello, health, launches and the minor-planet state, then pushes changes', async () => {
    const h = harness();
    await h.service.ready;
    await vi.advanceTimersByTimeAsync(4000);
    h.service.handle({ kind: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events().map((e) => e.type).slice(0, 4)).toEqual(['hello', 'health', 'launches', 'minorPlanets']);
    const hello = h.events()[0] as Extract<WorkerEvent, { type: 'hello' }>;
    expect(hello.entityCount).toBeGreaterThan(0);

    // the topic gate: nothing for `iss` until subscribed, and the subscription list is bounded
    const before = h.events().length;
    h.service.handle({ kind: 'client', msg: { op: 'subscribe', topics: ['iss'] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events().length).toBe(before); // no fix yet, so nothing to replay
    h.service.handle({ kind: 'stop' });
    await h.service.stop();
  });

  it('throttles health pushes to one per 2 s', async () => {
    const h = harness();
    await h.service.ready;
    h.service.handle({ kind: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    const healthCount = () => h.events().filter((e) => e.type === 'health').length;
    const first = healthCount();
    await vi.advanceTimersByTimeAsync(1500); // the connector's run ends: health changes
    expect(healthCount()).toBe(first); // held back by the throttle
    await vi.advanceTimersByTimeAsync(2100);
    expect(healthCount()).toBe(first + 1);
    await h.service.stop();
  });

  it('keeps credentials write-only and clears them all', async () => {
    const h = harness();
    const after = await h.rpc('saveCredentials', { ll2Token: 'secret-token-123', spacetrackUser: 'me@example.org' });
    expect(JSON.stringify(after)).not.toContain('secret-token-123');
    expect(after.find((c: { key: string }) => c.key === 'll2Token')).toMatchObject({ set: true, secret: true });
    expect(after.find((c: { key: string }) => c.key === 'spacetrackUser')).toMatchObject({ set: true, value: 'me@example.org' });
    expect((await h.kv.get('credential:ll2Token'))?.value).toBe('secret-token-123'); // stored in the browser store, as the UI warns
    await expect(h.rpc('saveCredentials', { nonsense: 'x' })).rejects.toThrow(/unknown credential/);
    const cleared = await h.rpc('clearCredentials');
    expect(cleared.every((c: { set: boolean }) => !c.set)).toBe(true);
    expect(await h.kv.get('credential:ll2Token')).toBeUndefined();
    await h.service.stop();
  });

  it('serves every connector last cached data before any request goes out (offline reload)', async () => {
    const kv = new MemoryKv();
    // a cache from an earlier visit: a day old, long past its TTL
    await kv.put('ll2:upcoming', [ll2()], 5 * 60_000, Date.now() - DAY);
    await kv.put('ll2:previous', [], 5 * 60_000, Date.now() - DAY);
    const offline = vi.fn<typeof fetch>(async () => { throw new TypeError('Failed to fetch'); });
    const h = harness({ kv, fetch: offline });
    await h.service.ready; // the engine is up, no timer has fired yet
    expect(offline).not.toHaveBeenCalled();
    const launches = await h.rpc('launches');
    expect(launches.map((l: { id: string }) => l.id)).toEqual([LAUNCH_ID]);
    expect((await h.rpc('entities')).entities.some((e: { id: string }) => e.id === `launch-${LAUNCH_ID}`)).toBe(true);
    // the pass changed nothing in the store: no failure, gate or block was recorded for a row that merely was old
    expect((await kv.list('backoff:')).length).toBe(0);
    expect((await kv.get('ll2:upcoming'))?.fetchedAt).toBe(Date.now() - DAY);
    // the real run still goes out afterwards and its failure leaves the cached data in place
    await vi.advanceTimersByTimeAsync(1500);
    expect(offline).toHaveBeenCalled();
    expect(await h.rpc('launches')).toHaveLength(1);
    await h.service.stop();
  });
});

describe('minor planets are opt-in', () => {
  const GZ = gzipSync(Buffer.from(MPCORB_SAMPLE, 'latin1'));
  const mpFetch = (log: string[]) => vi.fn<typeof fetch>(async (input, init) => {
    log.push(`${init?.method ?? 'GET'} ${String(input)}`);
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'last-modified': 'Tue, 17 Nov 2026 13:09:02 GMT' } });
    return new Response(GZ, { headers: { 'last-modified': 'Tue, 17 Nov 2026 13:09:02 GMT' } });
  });
  const harnessMp = (fetchMock: typeof fetch) => {
    vi.useRealTimers();
    return harness({ fetch: fetchMock, minOrbits: 10, connectors: ({ withLock }) => [createMinorPlanets({ withLock, fetch: fetchMock, minOrbits: 10 })] });
  };

  it('downloads nothing at startup, only when asked; chunks are handed over as buffers', async () => {
    const log: string[] = [];
    const h = harnessMp(mpFetch(log));
    await h.service.ready;
    expect(await h.rpc('minorPlanetsStatus')).toEqual({ state: 'none' });
    expect(log).toEqual([]);

    h.service.handle({ kind: 'start' });
    const status = await h.rpc('minorPlanetsDownload');
    expect(status).toMatchObject({ state: 'ready', count: 20 });
    expect(log.some((l) => l.startsWith('GET'))).toBe(true);
    const phases = h.events().flatMap((e) => (e.type === 'minorPlanets' && e.status.state === 'downloading' ? [e.status.phase] : []));
    expect(phases.filter((p, i) => p !== phases[i - 1])).toEqual(['downloading', 'storing']);
    expect(h.events().at(-1)).toMatchObject({ type: 'minorPlanets', status: { state: 'ready', count: 20 } });

    const index = await h.rpc('minorPlanetIndex');
    expect(index).toMatchObject({ count: 20, chunks: [{ chunk: 0, count: 20 }] });
    const chunk: Uint8Array = await h.rpc('minorPlanetChunk', 0);
    expect(readContainer(chunk).count).toBe(20);
    const sent = h.posted.at(-1)!;
    expect(sent.transfer).toEqual([chunk.buffer]); // zero-copy hand-over
    await expect(h.rpc('minorPlanetChunk', 9)).rejects.toThrow(/not stored/);

    // fresh data is left alone by a plain request, and a second ask does not download again
    const gets = log.filter((l) => l.startsWith('GET')).length;
    expect(await h.rpc('minorPlanetsDownload')).toMatchObject({ state: 'ready' });
    expect(log.filter((l) => l.startsWith('GET')).length).toBe(gets);
    await h.service.stop();
  });

  it('turning the layer off aborts a download in flight and keeps the state as it was', async () => {
    let signal: AbortSignal | undefined;
    const hang = vi.fn<typeof fetch>(async (_u, init) => {
      signal = init?.signal ?? undefined;
      if (init?.method === 'HEAD') return new Response(null);
      return new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason)); } }));
    });
    const h = harnessMp(hang);
    await h.service.ready;
    const download = h.rpc('minorPlanetsDownload');
    for (let i = 0; i < 50 && !signal; i++) await new Promise((r) => setTimeout(r, 5));
    expect(signal).toBeDefined();
    expect(await h.rpc('minorPlanetsStatus')).toMatchObject({ state: 'downloading' });
    await h.rpc('minorPlanetsCancel');
    expect(await download).toEqual({ state: 'none' }); // aborted, not failed
    expect(signal!.aborted).toBe(true);
    await h.service.stop();
  });
});
