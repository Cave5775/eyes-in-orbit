import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issLive } from '../../../src/engine/connectors/iss-live';
import { systemClock } from '../../../src/engine/clock';
import { engineConfig } from '../../../src/engine/config';
import { Hub } from '../../../src/engine/hub';
import { Limiter } from '../../../src/engine/net/limiter';
import { LIMITS } from '../../../src/engine/net/limits';
import type { ConnectorContext } from '../../../src/engine/scheduler';
import { MemoryKv } from '../../../src/engine/store';

/** A browser WebSocket stand-in: tests fire its events by hand. */
class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string, readonly protocol: string) {
    super();
    FakeSocket.all.push(this);
  }
  send(data: string): void { this.sent.push(data); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // like a browser: closing a socket fires `close` (asynchronously)
    queueMicrotask(() => this.fire('close'));
  }
  fire(type: string, init: { data?: string } = {}): void {
    const ev = Object.assign(new Event(type), init);
    this.dispatchEvent(ev);
  }
  message(...lines: string[]): void { this.fire('message', { data: lines.join('\r\n') }); }
}

function setup() {
  const hub = new Hub(0);
  const limiter = new Limiter(new MemoryKv(), { limits: LIMITS });
  const report = vi.spyOn(limiter, 'report');
  const ctx = { hub, health: {}, config: engineConfig(), clock: systemClock, http: { limiter }, log() {} } as unknown as ConnectorContext;
  /** start a run and wait until its socket exists */
  const start = async () => {
    const run = issLive.run!(ctx).then(() => 'ok' as const, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(0);
    return { run, ws: FakeSocket.all[FakeSocket.all.length - 1] };
  };
  return { hub, limiter, report, ctx, start };
}

const failures = (report: { mock: { calls: unknown[][] } }): number => report.mock.calls.filter((c) => (c[1] as { networkError?: boolean }).networkError).length;

describe('iss-live over a browser WebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connects with the Lightstreamer URL and protocol, creates the session on open and subscribes on CONOK', async () => {
    const { start } = setup();
    const { run, ws } = await start();
    expect(ws.url).toBe('wss://push.lightstreamer.com/lightstreamer');
    expect(ws.protocol).toBe('TLCP-2.5.0.lightstreamer.com');
    ws.fire('open');
    expect(ws.sent[0]).toMatch(/^create_session\r\nLS_adapter_set=ISSLIVE/);
    ws.message('CONOK,session1,50000,5000,*');
    expect(ws.sent[1]).toMatch(/^control\r\nLS_reqId=1&LS_op=add.*LS_group=S0000003%20S0000004/);
    ws.message('END,41');
    expect(await run).toBe('ok');
  });

  it('publishes telemetry and arrays at the 1 s flush', async () => {
    const { start, hub } = setup();
    const { run, ws } = await start();
    ws.fire('open');
    ws.message('CONOK,s,1,1,*');
    ws.message('U,1,1,7103.23266|92.4', 'U,1,2,7103.23266|267.6');
    expect(hub.telemetry.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(hub.telemetry.get('S0000003')?.value).toBe('92.4');
    expect(hub.issArrays?.sarj.starboard).toBeCloseTo(92.4, 6);
    expect(hub.issArrays?.sarj.port).toBeCloseTo(267.6, 6);
    ws.message('LOOP,0');
    expect(await run).toBe('ok');
  });

  it('an error before open ends the run with an error and counts as a failed connect', async () => {
    const { start, report } = setup();
    const { run, ws } = await start();
    ws.fire('error');
    ws.fire('close');
    expect(await run).toMatchObject({ message: 'WebSocket error' });
    expect(failures(report)).toBe(1); // reported once, by the socket's own close handler
  });

  it('a close before CONOK is an error naming it', async () => {
    const { start, report } = setup();
    const { run, ws } = await start();
    ws.fire('open');
    ws.fire('close');
    expect(await run).toMatchObject({ message: 'socket closed before session was created' });
    expect(failures(report)).toBe(0); // it had opened: not a failed connect
  });

  it('a handshake that never answers times out after 10 s and closes the socket as a failure', async () => {
    const { start, report } = setup();
    const { run, ws } = await start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(ws.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await run).toMatchObject({ message: 'Lightstreamer handshake timed out' });
    expect(ws.closed).toBe(true);
    expect(failures(report)).toBe(1);
  });

  it('after CONOK, 20 s without data ends the run', async () => {
    const { start } = setup();
    const { run, ws } = await start();
    ws.fire('open');
    ws.message('CONOK,s,1,1,*');
    ws.message('SYNC,1'); // the first message after the handshake arms the 20 s watchdog (CONOK itself re-arms the 10 s one)
    await vi.advanceTimersByTimeAsync(19_000);
    ws.message('PROBE');
    await vi.advanceTimersByTimeAsync(19_000);
    expect(ws.closed).toBe(false); // the probe reset the watchdog
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await run).toMatchObject({ message: 'no data from Lightstreamer for 20 s' });
  });

  it('once ended, late messages and a second end change nothing', async () => {
    const { start, hub } = setup();
    const { run, ws } = await start();
    ws.fire('open');
    ws.message('CONOK,s,1,1,*');
    ws.message('CONERR,1,bad');
    expect(await run).toMatchObject({ message: 'CONERR 1,bad' });
    const sent = ws.sent.length;
    ws.message('U,1,1,7103.2|92.4', 'CONOK,s,1,1,*');
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ws.sent.length).toBe(sent);
    expect(hub.telemetry.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // watchdog and flush timers are gone
  });

  it('the last subscriber leaving ends the run quietly, also before the socket opened, and is not a failed connect', async () => {
    const { start, hub, report } = setup();
    hub.subscribe('iss');
    const { run, ws } = await start();
    hub.unsubscribe('iss');
    expect(await run).toBe('ok');
    expect(ws.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(0); // the close event arrives
    expect(failures(report)).toBe(0);
    expect(hub.subscribers('iss')).toBe(0);
  });

  it('an unrelated topic changing does not end the run', async () => {
    const { start, hub } = setup();
    const { run, ws } = await start();
    ws.fire('open');
    hub.subscribe('other');
    hub.unsubscribe('other');
    expect(ws.closed).toBe(false);
    ws.message('END,41');
    expect(await run).toBe('ok');
  });
});
