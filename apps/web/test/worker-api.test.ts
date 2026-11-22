import { describe, expect, it, vi } from 'vitest';
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
