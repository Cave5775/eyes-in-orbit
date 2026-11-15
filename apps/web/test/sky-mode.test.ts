import { describe, expect, it } from 'vitest';
import { SKY_OFF, skyBusy, skyCoversScene, skyReduce, type SkyEvent, type SkyModeState, type SkyPhase } from '../src/lib/sky-mode';

const st = (phase: SkyPhase, over: Partial<SkyModeState> = {}): SkyModeState => ({ phase, obsId: phase === 'off' ? null : 'obs-a', ready: false, error: null, ...over });
const ev = {
  request: { type: 'request', obsId: 'obs-a' } as SkyEvent,
  settled: { type: 'settled' } as SkyEvent,
  ready: { type: 'ready' } as SkyEvent,
  failed: { type: 'failed', message: 'no network' } as SkyEvent,
  entered: { type: 'entered' } as SkyEvent,
  leave: { type: 'leave' } as SkyEvent,
  left: { type: 'left' } as SkyEvent,
  fpEnded: { type: 'fpEnded' } as SkyEvent,
  clearError: { type: 'clearError' } as SkyEvent,
};

describe('sky phase machine', () => {
  // [from, event, expected phase]; every cell of the phase x event table that matters
  const table: [SkyModeState, keyof typeof ev, SkyPhase][] = [
    [st('off'), 'request', 'flying'],
    [st('flying'), 'request', 'flying'],
    [st('on'), 'request', 'on'],
    [st('flying'), 'settled', 'loading'],
    [st('flying', { ready: true }), 'settled', 'entering'],
    [st('off'), 'settled', 'off'],
    [st('loading'), 'settled', 'loading'],
    [st('flying'), 'ready', 'flying'],
    [st('loading'), 'ready', 'entering'],
    [st('entering'), 'ready', 'entering'],
    [st('off'), 'ready', 'off'],
    [st('on'), 'ready', 'on'],
    [st('flying'), 'failed', 'off'],
    [st('loading'), 'failed', 'off'],
    [st('entering'), 'failed', 'off'],
    [st('on'), 'failed', 'on'],
    [st('leaving'), 'failed', 'leaving'],
    [st('off'), 'failed', 'off'],
    [st('entering'), 'entered', 'on'],
    [st('loading'), 'entered', 'loading'],
    [st('on'), 'entered', 'on'],
    [st('flying'), 'leave', 'off'],
    [st('loading'), 'leave', 'off'],
    [st('entering'), 'leave', 'leaving'],
    [st('on'), 'leave', 'leaving'],
    [st('leaving'), 'leave', 'leaving'],
    [st('off'), 'leave', 'off'],
    [st('leaving'), 'left', 'off'],
    [st('on'), 'left', 'on'],
    [st('off'), 'left', 'off'],
    // the first-person view ended by another route forces off from any phase, except while leaving (the leave itself ends it)
    [st('flying'), 'fpEnded', 'off'],
    [st('flying', { ready: true }), 'fpEnded', 'off'],
    [st('loading'), 'fpEnded', 'off'],
    [st('entering'), 'fpEnded', 'off'],
    [st('on'), 'fpEnded', 'off'],
    [st('leaving'), 'fpEnded', 'leaving'],
    [st('off'), 'fpEnded', 'off'],
  ];
  it.each(table)('%j + %s -> %s', (from, event, phase) => {
    expect(skyReduce(from, ev[event]).phase).toBe(phase);
  });

  it('a request starts clean: observatory set, not ready, no old error', () => {
    expect(skyReduce(st('off', { error: 'old' }), ev.request)).toEqual({ phase: 'flying', obsId: 'obs-a', ready: false, error: null });
  });

  it('ready before settled is remembered, ready after settled enters', () => {
    let s = skyReduce(st('off'), ev.request);
    s = skyReduce(s, ev.ready);
    expect(s).toMatchObject({ phase: 'flying', ready: true });
    expect(skyReduce(s, ev.settled).phase).toBe('entering');
    const slow = skyReduce(skyReduce(st('off'), ev.request), ev.settled);
    expect(slow.phase).toBe('loading');
    expect(skyReduce(slow, ev.ready)).toMatchObject({ phase: 'entering', ready: true });
  });

  it('a failure goes off with its message and forgets the observatory; leaving and fpEnded clear it', () => {
    const s = skyReduce(st('loading'), ev.failed);
    expect(s).toEqual({ phase: 'off', obsId: null, ready: false, error: 'no network' });
    expect(skyReduce(s, ev.clearError).error).toBeNull();
    expect(skyReduce(s, ev.fpEnded)).toEqual(SKY_OFF);
    expect(skyReduce(s, ev.request).error).toBeNull();
  });

  it('the full happy path runs off, flying, loading, entering, on, leaving, off', () => {
    const phases: SkyPhase[] = [];
    let s = SKY_OFF;
    for (const e of [ev.request, ev.settled, ev.ready, ev.entered, ev.leave, ev.fpEnded, ev.left]) {
      s = skyReduce(s, e);
      phases.push(s.phase);
    }
    expect(phases).toEqual(['flying', 'loading', 'entering', 'on', 'leaving', 'leaving', 'off']);
  });

  it('returns the same object when an event does nothing', () => {
    const s = st('on');
    expect(skyReduce(s, ev.request)).toBe(s);
    expect(skyReduce(SKY_OFF, ev.left)).toBe(SKY_OFF);
    expect(skyReduce(SKY_OFF, ev.fpEnded)).toBe(SKY_OFF);
  });

  it('helpers: the scene is covered while entering and on; busy in every phase but off', () => {
    const phases: SkyPhase[] = ['off', 'flying', 'loading', 'entering', 'on', 'leaving'];
    expect(phases.filter(skyCoversScene)).toEqual(['entering', 'on']);
    expect(phases.filter(skyBusy)).toEqual(['flying', 'loading', 'entering', 'on', 'leaving']);
  });
});
