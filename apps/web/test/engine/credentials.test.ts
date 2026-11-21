import { describe, expect, it } from 'vitest';
import { recordFailure, readBackoff } from '../../src/engine/backoff';
import { CredentialError, Credentials, type CredentialSource } from '../../src/engine/credentials';
import { Limiter } from '../../src/engine/net/limiter';
import { LIMITS } from '../../src/engine/net/limits';
import { MemoryKv } from '../../src/engine/store';

const make = () => {
  const store = new MemoryKv();
  return { store, creds: new Credentials({ store, limiter: new Limiter(store, { limits: {} }) }) };
};

describe('Credentials', () => {
  it('has the CredentialSource shape services read', async () => {
    const { creds } = make();
    const source: CredentialSource = creds;
    expect(await source.get('ll2Token')).toBeUndefined();
    await creds.set('ll2Token', 'abc');
    expect(await source.get('ll2Token')).toBe('abc');
    expect(await source.get('nope')).toBeUndefined();
  });

  it('describes what is set without ever returning a secret', async () => {
    const { creds } = make();
    await creds.update({ spacetrackUser: 'me@example.com', spacetrackPassword: 'hunter2' });
    const list = await creds.status();
    expect(list.find((c) => c.key === 'spacetrackUser')).toMatchObject({ set: true, source: 'ui', value: 'me@example.com', secret: false });
    expect(list.find((c) => c.key === 'spacetrackPassword')).toMatchObject({ set: true, source: 'ui', secret: true });
    expect(JSON.stringify(list)).not.toContain('hunter2');
    expect(list.find((c) => c.key === 'll2Token')).toMatchObject({ set: false, source: null });
    expect(list.map((c) => c.key)).toEqual(['spacetrackUser', 'spacetrackPassword', 'll2Token', 'discosToken']);
  });

  it('stores plain text under credential:<key> and removes the row when cleared', async () => {
    const { creds, store } = make();
    expect(await creds.set('ll2Token', '  from-ui  ')).toEqual({ changed: ['ll2Token'], connectors: ['launchlibrary'], errors: [] });
    expect((await store.get('credential:ll2Token'))?.value).toBe('from-ui');
    expect(await creds.clear('ll2Token')).toEqual({ changed: ['ll2Token'], connectors: ['launchlibrary'], errors: [] });
    expect(await store.get('credential:ll2Token')).toBeUndefined();
    expect(await creds.get('ll2Token')).toBeUndefined();
    expect((await creds.update({ ll2Token: '' })).changed).toEqual([]);
  });

  it('keeps the ESA DISCOS token as a secret read by the discos feed', async () => {
    const { creds } = make();
    expect(await creds.set('discosToken', 'ui-tok')).toEqual({ changed: ['discosToken'], connectors: ['discos'], errors: [] });
    expect((await creds.status()).find((c) => c.key === 'discosToken')).toMatchObject({ connector: 'discos', secret: true, set: true, source: 'ui' });
  });

  it('reports nothing changed when the value is the same', async () => {
    const { creds } = make();
    await creds.update({ ll2Token: 'abc' });
    expect(await creds.update({ ll2Token: 'abc' })).toEqual({ changed: [], connectors: [], errors: [] });
  });

  it('survives a restart: a new instance on the same store reads the saved values', async () => {
    const { creds, store } = make();
    await creds.update({ spacetrackUser: 'u', spacetrackPassword: 'p' });
    const again = new Credentials({ store, limiter: new Limiter(store, { limits: {} }) });
    expect(await again.get('spacetrackUser')).toBe('u');
    expect(await again.get('spacetrackPassword')).toBe('p');
  });

  it('validates the whole patch before changing anything', async () => {
    const { creds } = make();
    await expect(creds.update({ ll2Token: 'ok', nope: 'x' })).rejects.toThrow(/unknown credential "nope"/);
    expect(await creds.get('ll2Token')).toBeUndefined();
    await expect(creds.update({ ll2Token: 5 })).rejects.toThrow(CredentialError);
    await expect(creds.update({ ll2Token: 'a\nb' })).rejects.toThrow(/control characters/);
    await expect(creds.update({ ll2Token: 'x'.repeat(257) })).rejects.toThrow(/longer than/);
    await expect(creds.update([])).rejects.toThrow(/object/);
    expect(await creds.get('ll2Token')).toBeUndefined();
  });

  it('writes every key even when lifting a block fails, reports the failure, and calls onChange once', async () => {
    const store = new MemoryKv();
    const limiter = new Limiter(store, { limits: LIMITS });
    limiter.clearBlock = async () => { throw new Error('lock lost'); };
    const seen: string[][] = [];
    const creds = new Credentials({ store, limiter, onChange: (r) => seen.push(r.changed) });
    const r = await creds.update({ spacetrackUser: 'u', spacetrackPassword: 'p', ll2Token: 't' });
    expect(r.changed).toEqual(['spacetrackUser', 'spacetrackPassword', 'll2Token']);
    expect(r.errors).toHaveLength(4);
    expect(r.errors[0]).toMatch(/limiter spacetrack:login: lock lost/);
    expect(await creds.get('ll2Token')).toBe('t');
    expect(await creds.get('spacetrackPassword')).toBe('p');
    expect(seen).toEqual([['spacetrackUser', 'spacetrackPassword', 'll2Token']]);
    await creds.update({ ll2Token: 't' });
    expect(seen).toHaveLength(1); // nothing changed: no callback
  });

  it('lifts only the Space-Track failure block when its login changes: the cache, the 2 h spacing and the counters stay', async () => {
    const store = new MemoryKv();
    const limiter = new Limiter(store, { limits: LIMITS });
    const creds = new Credentials({ store, limiter });
    await store.put('spacetrack:starlink', [], 1000);
    await recordFailure(store, 'spacetrack', new Error('Space-Track login failed'));
    const before = Date.now();
    await limiter.tryAcquire('spacetrack:login', 'poll', true);
    await limiter.tryAcquire('spacetrack:query', 'poll', true);
    await limiter.block('spacetrack:login', 6 * 3600_000, 'failed login');
    await limiter.block('spacetrack:query', 6 * 3600_000, 'failed login');
    await creds.update({ spacetrackPassword: 'new' });
    expect(await store.get('spacetrack:starlink')).toBeDefined();
    expect(await readBackoff(store, 'spacetrack')).toBeUndefined();
    for (const s of ['spacetrack:login', 'spacetrack:query']) {
      const st = await limiter.state(s);
      expect(st.blockedUntil).toBeUndefined();
      expect((st.hour ?? st.day)?.count).toBe(1);
    }
    expect((await limiter.state('spacetrack:query')).nextAllowedAt).toBeGreaterThan(before + 3600_000); // still inside the 2 h gap
  });
});
