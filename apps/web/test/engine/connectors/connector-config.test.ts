import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineConfig } from '../../../src/engine/config';
import { dsn } from '../../../src/engine/connectors/dsn';
import { Http } from '../../../src/engine/http';
import { Hub } from '../../../src/engine/hub';
import { Limiter } from '../../../src/engine/net/limiter';
import { LIMITS } from '../../../src/engine/net/limits';
import { Scheduler } from '../../../src/engine/scheduler';
import { MemoryKv } from '../../../src/engine/store';
import { readFileSync } from 'node:fs';

describe('engineConfig normalisation (as the server config did)', () => {
  it('strips trailing slashes from the LL2 base and falls back to the default when it is empty', () => {
    expect(engineConfig({ ll2Base: 'https://example.test/ll///' }).ll2Base).toBe('https://example.test/ll');
    expect(engineConfig({ ll2Base: '' }).ll2Base).toBe('https://ll.thespacedevs.com/2.3.0');
    expect(engineConfig({ ll2Base: '/' }).ll2Base).toBe('https://ll.thespacedevs.com/2.3.0');
    expect(engineConfig().ll2Base).toBe('https://ll.thespacedevs.com/2.3.0');
  });

  it('an empty DSN URL list falls back to the two default URLs', () => {
    const defaults = ['https://eyes.nasa.gov/dsn/data/dsn.xml', 'https://eyes.nasa.gov/dsn/dsn.xml'];
    expect(engineConfig().dsnUrls).toEqual(defaults);
    expect(engineConfig({ dsnUrls: [] }).dsnUrls).toEqual(defaults);
    expect(engineConfig({ dsnUrls: ['https://x.test/dsn.xml'] }).dsnUrls).toEqual(['https://x.test/dsn.xml']);
  });
});

describe('dsn with an empty URL list in the config', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls the default URL instead of throwing on every run', async () => {
    const hub = new Hub(0), store = new MemoryKv();
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (u) => (calls.push(String(u)), new Response(readFileSync(new URL('../../fixtures/dsn.xml', import.meta.url), 'utf8'))));
    const config = engineConfig({ dsnUrls: [] });
    const http = new Http(store, { fetch: fetchMock, limiter: new Limiter(store, { limits: LIMITS }) });
    const scheduler = new Scheduler({ hub, config, store, http }, [dsn], 0);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.stop();
    expect(calls[0]).toMatch(/^https:\/\/eyes\.nasa\.gov\/dsn\/data\/dsn\.xml\?r=/);
    expect(hub.healthOf('dsn').status).toBe('ok');
  });
});

describe('flightclub bundle', () => {
  it('leaves out the git-ignored private *.local.* trajectory files (negative glob in the source)', () => {
    const src = readFileSync(new URL('../../../src/engine/connectors/flightclub.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/import\.meta\.glob\(\[[^\]]*'!\.\.\/[./]*data\/trajectories\/\*\.local\.\*'\]/);
    expect(readFileSync(new URL('../../../../../.gitignore', import.meta.url), 'utf8')).toContain('data/trajectories/*.local.*');
  });
});
