import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ISS_CHANNELS } from '@eio/core';
import { loadConfig } from '../src/config';
import { BGA_CHANNELS_COVERED, ISS_ITEMS, ISS_VERIFIED, buildIssArrays, decodeUpdate, issTimestampMs, telemetryPoint, type IssSample } from '../src/connectors/iss-live';
import { Hub } from '../src/hub';

interface Snap {
  isoTime: string;
  items: Record<string, { hours: number; value: number }>;
}
const recorded = JSON.parse(readFileSync(new URL('./fixtures/iss-live-recorded.json', import.meta.url), 'utf8')) as { snapshots: Snap[] };

function samples(s: Snap): Map<string, IssSample> {
  const now = Date.parse(s.isoTime);
  return new Map(Object.entries(s.items).map(([id, x]) => [id, { v: x.value, t: issTimestampMs(x.hours, now) }]));
}

describe('ISS item table', () => {
  it('has unique ids and a label for each, and every BGA channel is covered once', () => {
    const ids = ISS_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BGA_CHANNELS_COVERED).toBe(true);
    expect(ISS_ITEMS.filter((i) => i.role.kind === 'bga')).toHaveLength(ISS_CHANNELS.length);
    expect(ISS_ITEMS.every((i) => i.label.length > 5)).toBe(true);
  });

  it('maps the Mimic-documented ids to the right sides and channels', () => {
    const role = (id: string) => ISS_ITEMS.find((i) => i.id === id)!.role;
    expect(role('S0000003')).toEqual({ kind: 'sarj', side: 'starboard' });
    expect(role('S0000004')).toEqual({ kind: 'sarj', side: 'port' });
    expect(role('P4000007')).toEqual({ kind: 'bga', channel: '2A' });
    expect(role('P4000008')).toEqual({ kind: 'bga', channel: '4A' });
    expect(role('P6000007')).toEqual({ kind: 'bga', channel: '4B' });
    expect(role('P6000008')).toEqual({ kind: 'bga', channel: '2B' });
    expect(role('S4000007')).toEqual({ kind: 'bga', channel: '1A' });
    expect(role('S4000008')).toEqual({ kind: 'bga', channel: '3A' });
    expect(role('S6000007')).toEqual({ kind: 'bga', channel: '3B' });
    expect(role('S6000008')).toEqual({ kind: 'bga', channel: '1B' });
    expect(role('USLAB000018')).toEqual({ kind: 'att', comp: 'w' });
    expect(role('USLAB000021')).toEqual({ kind: 'att', comp: 'z' });
  });

  it('labels BGA items unverified and flags verification per item', () => {
    for (const i of ISS_ITEMS) {
      if (i.role.kind === 'bga') {
        expect(i.verified).toBe(false);
        expect(i.label).toMatch(/unverified/);
      }
      if (i.role.kind === 'sarj') expect(i.verified).toBe(true);
    }
    expect(ISS_VERIFIED).toEqual({ sarj: true, bga: false, attitude: true });
    const p = telemetryPoint('P4000007', ['7103', '42.96'], Date.parse('2026-10-22T23:30:00Z'))!;
    expect(p.verified).toBe(false);
    expect(telemetryPoint('S0000003', ['7103', '92.4'], Date.parse('2026-10-22T23:30:00Z'))!.verified).toBe(true);
  });
});

describe('buildIssArrays', () => {
  it('builds the structured message from recorded live values', () => {
    const a = buildIssArrays(samples(recorded.snapshots[0]))!;
    const it0 = recorded.snapshots[0].items;
    expect(a.sarj.starboard).toBeCloseTo(it0.S0000003.value, 9);
    expect(a.sarj.port).toBeCloseTo(it0.S0000004.value, 9);
    expect(a.sarj.starboard! + a.sarj.port!).toBeCloseTo(360, 0);
    expect(Object.keys(a.bga).sort()).toEqual([...ISS_CHANNELS].sort());
    expect(a.bga['2A']).toBeCloseTo(it0.P4000007.value, 9);
    expect(a.bga['4B']).toBeCloseTo(it0.P6000007.value, 9);
    expect(a.bga['1B']).toBeCloseTo(it0.S6000008.value, 9);
    expect(a.verified).toEqual({ sarj: true, bga: false, attitude: true });
    expect(a.attitude).toHaveLength(4);
    expect(Math.hypot(...a.attitude!)).toBeCloseTo(1, 12);
    expect(a.attitude![0]).toBeGreaterThan(0.99);
    // t is the newest SARJ sample time
    expect(a.t).toBe(Math.max(issTimestampMs(it0.S0000003.hours, Date.parse(recorded.snapshots[0].isoTime)), issTimestampMs(it0.S0000004.hours, Date.parse(recorded.snapshots[0].isoTime))));
  });

  it('is undefined without any SARJ value, and partial otherwise', () => {
    expect(buildIssArrays(new Map())).toBeUndefined();
    expect(buildIssArrays(new Map([['P4000007', { v: 43, t: 1 }]]))).toBeUndefined();
    const a = buildIssArrays(new Map([['S0000004', { v: -5, t: 1000 }]]))!;
    expect(a.sarj).toEqual({ port: 355 });
    expect(a.bga).toEqual({});
    expect(a.attitude).toBeUndefined();
    expect(a.t).toBe(1000);
  });

  it('wraps angles into 0..360 and drops a bad quaternion', () => {
    const m = new Map<string, IssSample>([
      ['S0000003', { v: 725, t: 1 }], ['P6000008', { v: -46.2, t: 1 }],
      ['USLAB000018', { v: 2, t: 1 }], ['USLAB000019', { v: 0, t: 1 }], ['USLAB000020', { v: 0, t: 1 }], ['USLAB000021', { v: 0, t: 1 }],
    ]);
    const a = buildIssArrays(m)!;
    expect(a.sarj.starboard).toBe(5);
    expect(a.bga['2B']).toBeCloseTo(313.8, 9);
    expect(a.attitude).toBeUndefined(); // norm 2, not a unit quaternion
    m.set('USLAB000018', { v: 0.9998, t: 1 });
    m.set('USLAB000019', { v: 0.01, t: 1 });
    expect(buildIssArrays(m)!.attitude![0]).toBeCloseTo(0.9998 / Math.hypot(0.9998, 0.01), 9);
  });

  it('ignores non-numeric values', () => {
    expect(buildIssArrays(new Map([['S0000003', { v: Number.NaN, t: 1 }]]))).toBeUndefined();
  });

  it('decodes a recorded-style update stream into the same values', () => {
    // TLCP delta decoding feeding the builder, as the connector does
    let fields: (string | null)[] = [null, null];
    fields = decodeUpdate(fields, '7103.23266|92.41573333740234375');
    fields = decodeUpdate(fields, '7103.23294|^1');
    const p = telemetryPoint('S0000003', fields, Date.parse('2026-10-22T23:30:00Z'))!;
    expect(Number(p.value)).toBeCloseTo(92.4157, 4);
    expect(p.t).toBe(issTimestampMs(7103.23294, Date.parse('2026-10-22T23:30:00Z')));
  });
});

describe('hub and config', () => {
  it('stores and announces the arrays', () => {
    const hub = new Hub();
    const seen: unknown[] = [];
    hub.on('iss.arrays', (a) => seen.push(a));
    const a = buildIssArrays(samples(recorded.snapshots[1]))!;
    hub.setArrays(a);
    expect(hub.issArrays).toBe(a);
    expect(seen).toEqual([a]);
  });

  it('DISABLED_CONNECTORS lists connector ids, normalised', () => {
    expect(loadConfig({}).disabledConnectors).toEqual([]);
    expect(loadConfig({ DISABLED_CONNECTORS: ' CelesTrak, launchlibrary ,,snapi' }).disabledConnectors).toEqual(['celestrak', 'launchlibrary', 'snapi']);
  });
});
