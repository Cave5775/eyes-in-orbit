import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerApi } from '../src/api';
import { recordFailure, readBackoff } from '../src/backoff';
import { loadConfig } from '../src/config';
import { Scheduler } from '../src/connector';
import { spacetrack } from '../src/connectors/spacetrack';
import { CredentialError, Credentials } from '../src/credentials';
import { Http } from '../src/http';
import { Hub } from '../src/hub';
import { Store } from '../src/store';

const make = (env: NodeJS.ProcessEnv = {}) => {
  const store = new Store(':memory:');
  const config = loadConfig(env);
  return { store, config, creds: new Credentials(config, store) };
};

describe('Credentials', () => {
  it('describes what is set without ever returning a secret', () => {
    const { creds } = make({ SPACETRACK_USER: 'me@example.com', SPACETRACK_PASSWORD: 'hunter2' });
    const list = creds.describe();
    expect(list.find((c) => c.key === 'spacetrackUser')).toMatchObject({ set: true, source: 'env', value: 'me@example.com', secret: false });
    expect(list.find((c) => c.key === 'spacetrackPassword')).toMatchObject({ set: true, source: 'env', secret: true });
    expect(JSON.stringify(list)).not.toContain('hunter2');
    expect(list.find((c) => c.key === 'll2Token')).toMatchObject({ set: false, source: null });
  });

  it('sets values into the shared config, overriding the environment, and falls back when cleared', () => {
    const { creds, config } = make({ LL2_TOKEN: 'from-env' });
    expect(creds.update({ ll2Token: '  from-ui  ' })).toEqual({ changed: ['ll2Token'], connectors: ['launchlibrary'] });
    expect(config.ll2Token).toBe('from-ui');
    expect(creds.describe().find((c) => c.key === 'll2Token')!.source).toBe('ui');
    expect(creds.update({ ll2Token: null }).changed).toEqual(['ll2Token']);
    expect(config.ll2Token).toBe('from-env');
    expect(creds.describe().find((c) => c.key === 'll2Token')!.source).toBe('env');
  });

  it('keeps the ESA DISCOS token as a secret read by the discos feed', () => {
    const { creds, config } = make({ DISCOS_TOKEN: 'tok' });
    expect(creds.describe().find((c) => c.key === 'discosToken')).toMatchObject({ connector: 'discos', secret: true, set: true, source: 'env' });
    expect(creds.update({ discosToken: 'ui-tok' })).toEqual({ changed: ['discosToken'], connectors: ['discos'] });
    expect(config.discosToken).toBe('ui-tok');
  });

  it('reports nothing changed when the value is the same', () => {
    const { creds } = make();
    creds.update({ ll2Token: 'abc' });
    expect(creds.update({ ll2Token: 'abc' })).toEqual({ changed: [], connectors: [] });
  });

  it('survives a restart: a new instance on the same store loads the saved values', () => {
    const { creds, store } = make();
    creds.update({ spacetrackUser: 'u', spacetrackPassword: 'p' });
    const config = loadConfig({});
    new Credentials(config, store);
    expect(config).toMatchObject({ spacetrackUser: 'u', spacetrackPassword: 'p' });
  });

  it('validates the whole patch before changing anything', () => {
    const { creds, config } = make();
    expect(() => creds.update({ ll2Token: 'ok', nope: 'x' })).toThrow(/unknown credential "nope"/);
    expect(config.ll2Token).toBeUndefined();
    expect(() => creds.update({ ll2Token: 5 })).toThrow(CredentialError);
    expect(() => creds.update({ ll2Token: 'a\nb' })).toThrow(/control characters/);
    expect(() => creds.update({ ll2Token: 'x'.repeat(257) })).toThrow(/longer than/);
    expect(() => creds.update([])).toThrow(/object/);
    expect(config.ll2Token).toBeUndefined();
  });

  it('drops the Space-Track cache and retry gate when its login changes, so the new login is tried at once', () => {
    const { creds, store } = make();
    store.set('spacetrack:starlink', [], 1000);
    recordFailure(store, 'spacetrack', new Error('Space-Track login failed'));
    creds.update({ spacetrackPassword: 'new' });
    expect(store.get('spacetrack:starlink')).toBeUndefined();
    expect(readBackoff(store, 'spacetrack')).toBeUndefined();
  });
});

describe('credentials API', () => {
  function setup() {
    const { creds, store } = make();
    const app = Fastify();
    const changed: string[][] = [];
    registerApi(app, new Hub(0), new Http(store, { offline: true }), store, { credentials: creds, onChanged: (c) => changed.push(c) });
    return { app, changed, creds };
  }
  const put = (app: ReturnType<typeof setup>['app'], values: unknown, headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') =>
    app.inject({ method: 'PUT', url: '/api/credentials', payload: { values }, headers, remoteAddress });

  it('saves from localhost, answers with the new state and tells the scheduler which connectors moved', async () => {
    const { app, changed } = setup();
    const res = await put(app, { spacetrackUser: 'u', spacetrackPassword: 'secret-pw' }, { origin: 'http://localhost:5173' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, changed: ['spacetrackUser', 'spacetrackPassword'] });
    expect(res.body).not.toContain('secret-pw');
    expect(changed).toEqual([['spacetrack']]);
    const get = await app.inject({ method: 'GET', url: '/api/credentials', remoteAddress: '127.0.0.1' });
    expect(get.json().credentials.find((c: { key: string }) => c.key === 'spacetrackPassword')).toMatchObject({ set: true, source: 'ui' });
    expect(get.body).not.toContain('secret-pw');
  });

  it('refuses foreign origins and non-loopback clients', async () => {
    const { app, creds } = setup();
    expect((await put(app, { ll2Token: 'x' }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await put(app, { ll2Token: 'x' }, {}, '10.0.0.5')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/credentials', remoteAddress: '10.0.0.5' })).statusCode).toBe(403);
    expect(creds.describe().every((c) => !c.set)).toBe(true);
  });

  it('answers 400 for invalid input', async () => {
    const { app, changed } = setup();
    const res = await put(app, { bogus: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown credential/);
    expect(changed).toEqual([]);
  });
});

describe('Scheduler.refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('turns the spacetrack stub into a running connector once credentials exist, and back again', async () => {
    const hub = new Hub(0);
    const { store, config, creds } = make();
    let runs = 0;
    const connector = { ...spacetrack, run: async () => void runs++ };
    const scheduler = new Scheduler({ hub, config, store, http: new Http(store, { offline: true }) }, [connector], 0);
    await scheduler.start();
    expect(hub.healthOf('spacetrack')).toMatchObject({ status: 'stub' });

    creds.update({ spacetrackUser: 'u', spacetrackPassword: 'p' });
    await scheduler.refresh('spacetrack');
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    expect(hub.healthOf('spacetrack').status).toBe('ok');

    creds.update({ spacetrackPassword: null });
    await scheduler.refresh('spacetrack');
    expect(hub.healthOf('spacetrack').status).toBe('stub');
    scheduler.stop();
  });
});
