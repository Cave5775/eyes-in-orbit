import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataLink, RpcFailure, type PortLike } from '../src/api/data-link';
import { createWorkerApi } from '../src/api/worker-api';
import { WorkerStream } from '../src/api/worker-stream';
import type { FromWorker, ToWorker } from '../src/workers/data.protocol';

/** a worker port the test plays the engine on */
function fakePort() {
  const sent: ToWorker[] = [];
  const port: PortLike = { postMessage: (m) => void sent.push(m), onmessage: null, onerror: null, terminate: vi.fn() };
  const reply = (m: FromWorker) => port.onmessage!({ data: m });
  return { port, sent, reply };
}

describe('worker api over a port', () => {
  it('turns each Api call into one numbered RPC and resolves with its answer', async () => {
    const { port, sent, reply } = fakePort();
    const api = createWorkerApi(new DataLink(port));
    const a = api.entities(5, { offset: 10, limit: 20 });
    const b = api.launches();
    expect(sent).toEqual([
      { kind: 'rpc', id: 1, method: 'entities', args: [5, { offset: 10, limit: 20 }] },
      { kind: 'rpc', id: 2, method: 'launches', args: [] },
    ]);
    reply({ kind: 'result', id: 2, ok: true, value: [{ id: 'l' }] }); // answers may arrive in any order
    reply({ kind: 'result', id: 1, ok: true, value: { serverTime: 1, entities: [] } });
    expect(await b).toEqual([{ id: 'l' }]);
    expect(await a).toEqual({ serverTime: 1, entities: [] });
  });

  it('rejects with the engine error, keeping the limiter retry time', async () => {
    const { port, reply } = fakePort();
    const api = createWorkerApi(new DataLink(port));
    const p = api.news({ q: 'x' });
    reply({ kind: 'result', id: 1, ok: false, error: { message: 'limited', name: 'LimitedError', limited: true, retryAt: 99 } });
    await expect(p).rejects.toMatchObject({ message: 'limited', detail: { limited: true, retryAt: 99 } });
    await expect(p).rejects.toBeInstanceOf(RpcFailure);
  });

  it('answers null for a missing ascent, traverse or minor-planet index, and builds map tile addresses itself', async () => {
    const { port, sent, reply } = fakePort();
    const api = createWorkerApi(new DataLink(port));
    const ps = [api.ascent('l'), api.traverse('r'), api.minorPlanetIndex()];
    sent.forEach((m) => m.kind === 'rpc' && reply({ kind: 'result', id: m.id, ok: false, error: { message: 'unknown' } }));
    expect(await Promise.all(ps)).toEqual([null, null, null]);
    const before = sent.length;
    api.mapTile({ mission: 'm2020', id: 'x' } as never, 3, 1, 1);
    expect(sent.length).toBe(before); // no message: an address is only built
  });

  it('fails every pending call when the worker dies, and later calls too', async () => {
    const { port } = fakePort();
    const link = new DataLink(port);
    const api = createWorkerApi(link);
    const p = api.health();
    port.onerror!({ message: 'boom' });
    await expect(p).rejects.toThrow('boom');
    await expect(api.dsn()).rejects.toThrow('boom');
    await expect(link.ready).rejects.toThrow('boom');
  });

  it('knows the worker is up from its ready message, and fails on a fatal engine error', async () => {
    const up = fakePort();
    const l1 = new DataLink(up.port);
    up.reply({ kind: 'ready' });
    await expect(l1.ready).resolves.toBeUndefined();
    const bad = fakePort();
    const l2 = new DataLink(bad.port);
    bad.reply({ kind: 'fatal', error: 'no storage' });
    await expect(l2.ready).rejects.toThrow('no storage');
  });
});

describe('worker stream', () => {
  it('delivers pushed events, sends only topic differences and releases on stop', () => {
    const { port, sent, reply } = fakePort();
    const got: unknown[] = [];
    const states: string[] = [];
    const stream = new WorkerStream(new DataLink(port), (m, re) => got.push([m.type, re]), (s) => states.push(s));
    stream.setTopics(new Set(['iss'])); // before start: remembered, not sent
    expect(sent).toEqual([]);
    stream.start();
    expect(states).toEqual(['live']);
    expect(sent).toEqual([{ kind: 'start' }, { kind: 'client', msg: { op: 'subscribe', topics: ['iss'] } }]);
    reply({ kind: 'event', msg: { type: 'hello', serverTime: 1, entityCount: 2 } });
    reply({ kind: 'event', msg: { type: 'minorPlanets', status: { state: 'none' } } });
    expect(got).toEqual([['hello', false], ['minorPlanets', false]]);
    sent.length = 0;
    stream.setTopics(new Set(['iss', 'x']));
    stream.setTopics(new Set(['x']));
    expect(sent).toEqual([
      { kind: 'client', msg: { op: 'subscribe', topics: ['x'] } },
      { kind: 'client', msg: { op: 'unsubscribe', topics: ['iss'] } },
    ]);
    stream.stop();
    reply({ kind: 'event', msg: { type: 'hello', serverTime: 3, entityCount: 4 } });
    expect(got).toHaveLength(2); // nothing after stop
    expect(sent.at(-1)).toEqual({ kind: 'stop' });
  });
});

describe('a worker that dies or misbehaves after start', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a fatal message after start fails what is in flight, tells onDead once, and later calls fail', async () => {
    const { port, reply } = fakePort();
    const link = new DataLink(port);
    const dead = vi.fn();
    link.onDead(dead);
    reply({ kind: 'ready' });
    const p = link.call('launches');
    reply({ kind: 'fatal', error: 'storage failed' });
    await expect(p).rejects.toThrow('storage failed');
    await expect(link.call('dsn')).rejects.toThrow('storage failed');
    expect(dead).toHaveBeenCalledTimes(1);
    expect(dead).toHaveBeenCalledWith('storage failed');
    const late = vi.fn();
    link.onDead(late); // a listener added afterwards hears it at once
    expect(late).toHaveBeenCalledWith('storage failed');
  });

  it('a non-fatal error event after start is logged and the link keeps working', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { port, reply } = fakePort();
    const link = new DataLink(port);
    reply({ kind: 'ready' });
    port.onerror!({ message: 'handler threw' });
    expect(warn).toHaveBeenCalled();
    const p = link.call('launches');
    reply({ kind: 'result', id: 1, ok: true, value: [] });
    await expect(p).resolves.toEqual([]);
  });

  it('a result that cannot be read fails the calls in flight but not the link', async () => {
    const { port, reply } = fakePort();
    const link = new DataLink(port);
    reply({ kind: 'ready' });
    const p = link.call('entities');
    port.onmessageerror!({});
    await expect(p).rejects.toThrow(/could not be read/);
    const q = link.call('launches');
    reply({ kind: 'result', id: 2, ok: true, value: [1] });
    await expect(q).resolves.toEqual([1]);
  });

  it('times a call out by its method, and never the download (it reports through the status)', async () => {
    vi.useFakeTimers();
    const { port, reply } = fakePort();
    const link = new DataLink(port);
    reply({ kind: 'ready' });
    const search = link.call('search', 'x');
    const download = link.call('minorPlanetsDownload');
    let settled = false;
    download.then(() => (settled = true), () => (settled = true));
    const assertion = expect(search).rejects.toThrow(/search did not answer within 8 s/);
    await vi.advanceTimersByTimeAsync(8_001);
    await assertion;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(settled).toBe(false);
    reply({ kind: 'result', id: 2, ok: true, value: { state: 'ready' } });
    await expect(download).resolves.toEqual({ state: 'ready' });
    reply({ kind: 'result', id: 1, ok: true, value: [] }); // the late answer of the timed-out call is ignored
  });

  it('arguments that cannot be cloned fail that call only and leave nothing pending', async () => {
    const { port, reply } = fakePort();
    let n = 0;
    port.postMessage = (m) => { if (n++ === 1) throw new DOMException('could not be cloned', 'DataCloneError'); void m; };
    const link = new DataLink(port);
    reply({ kind: 'ready' });
    const ok = link.call('launches');
    await expect(link.call('news', { q: () => 1 } as never)).rejects.toThrow(/cloned/);
    reply({ kind: 'result', id: 1, ok: true, value: [] });
    await expect(ok).resolves.toEqual([]);
  });
});
