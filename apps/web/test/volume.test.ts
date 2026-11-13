import { describe, expect, it } from 'vitest';
import { barHeights, barsLit, clampVolume, toggleMute, wheelVolume } from '../src/lib/volume';
import { parseWidgetMessage, widgetCommand } from '../src/lib/youtube';

describe('volume arithmetic', () => {
  it('clamps to 0-100', () => {
    expect(clampVolume(140)).toBe(100);
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume(NaN)).toBe(0);
  });
  it('steps by 10 and clamps at both ends', () => {
    let s = { volume: 50, muted: false };
    s = wheelVolume(s, -100);
    expect(s.volume).toBe(60);
    expect(wheelVolume({ volume: 100, muted: false }, -1).volume).toBe(100);
    expect(wheelVolume({ volume: 0, muted: false }, 1).volume).toBe(0);
    expect(wheelVolume(s, 100).volume).toBe(50);
    expect(wheelVolume({ volume: 55, muted: false }, -1).volume).toBe(60);
    expect(wheelVolume({ volume: 55, muted: false }, 1).volume).toBe(50);
    expect(wheelVolume(s, 0)).toEqual(s);
  });
  it('wheel up unmutes, wheel down keeps the mute', () => {
    expect(wheelVolume({ volume: 30, muted: true }, -1)).toEqual({ volume: 40, muted: false });
    expect(wheelVolume({ volume: 30, muted: true }, 1)).toEqual({ volume: 20, muted: true });
  });
  it('bar fill count: muted is empty, else volume / 10', () => {
    expect(barsLit({ volume: 70, muted: false })).toBe(7);
    expect(barsLit({ volume: 70, muted: true })).toBe(0);
    expect(barsLit({ volume: 0, muted: false })).toBe(0);
    expect(barsLit({ volume: 100, muted: false })).toBe(10);
  });
  it('click mutes, remembers the level and restores it', () => {
    const muted = toggleMute({ volume: 60, muted: false });
    expect(muted).toEqual({ volume: 60, muted: true });
    expect(toggleMute(muted)).toEqual({ volume: 60, muted: false });
    expect(toggleMute({ volume: 0, muted: true })).toEqual({ volume: 10, muted: false });
    // wheeled down to silence while unmuted: the click raises it instead of muting nothing
    expect(toggleMute({ volume: 0, muted: false })).toEqual({ volume: 10, muted: false });
  });
  it('bar heights rise to full', () => {
    const h = barHeights();
    expect(h).toHaveLength(10);
    expect(h[0]).toBeCloseTo(0.1);
    expect(h[9]).toBe(1);
  });
});

describe('YouTube volume messages', () => {
  it('builds setVolume with its argument', () => {
    expect(JSON.parse(widgetCommand('setVolume', [40]))).toEqual({ event: 'command', func: 'setVolume', args: [40] });
    expect(JSON.parse(widgetCommand('mute')).args).toEqual([]);
  });
  it('reads volume from infoDelivery', () => {
    expect(parseWidgetMessage({ event: 'infoDelivery', info: { volume: 35, muted: false } })).toEqual({ volume: 35, muted: false });
    expect(parseWidgetMessage({ event: 'infoDelivery', info: { volume: 'x' } })).toEqual({});
  });
});
