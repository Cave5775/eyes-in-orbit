import { describe, expect, it } from 'vitest';
import { engineConfig } from '../../../src/engine/config';
import { createFlightclub, flightclub, loadTrajectories } from '../../../src/engine/connectors/flightclub';
import { Hub } from '../../../src/engine/hub';
import { matchTrajectory, parseTrajectory, trajectorySamples } from '../../../src/engine/trajectory';
import type { ConnectorContext } from '../../../src/engine/scheduler';

// ported from the server's trajectory-file cases (the files are bundled with the build instead of read from disk)
const json = {
  id: 'j', azimuthDeg: 90, match: { nameContains: 'Starlink' },
  rows: [{ tSec: 10, altKm: 1, speedKmS: 0.3 }, { tSec: 0, altKm: 0, speedKmS: 0 }, { tSec: 20, altKm: 4, speedKmS: 0.6 }],
};

describe('trajectory files', () => {
  it('parses JSON, sorts rows and integrates downrange from speed', () => {
    const t = parseTrajectory(JSON.stringify(json), 'j.json');
    expect(t.rows.map((r) => r.tSec)).toEqual([0, 10, 20]);
    expect(t.rows[0].downrangeKm).toBe(0);
    expect(t.rows[2].downrangeKm).toBeGreaterThan(t.rows[1].downrangeKm);
  });

  it('parses CSV with metadata comments and explicit downrange', () => {
    const t = parseTrajectory('# id: c\n# azimuthDeg: 45\n# launchId: L1\ntSec,altKm,speedKmS,downrangeKm\n0,0,0,0\n10,2,0.3,1.5\n', 'c.csv');
    expect(t).toMatchObject({ id: 'c', azimuthDeg: 45, match: { launchId: 'L1' } });
    expect(t.rows[1]).toEqual({ tSec: 10, altKm: 2, downrangeKm: 1.5 });
  });

  it('rejects incomplete files', () => {
    expect(() => parseTrajectory('{"rows":[]}', 'x.json')).toThrow(/rows/);
    expect(() => parseTrajectory(JSON.stringify({ ...json, match: {} }), 'x.json')).toThrow(/match/);
    expect(() => parseTrajectory(JSON.stringify({ ...json, rows: [{ tSec: 0, altKm: 0 }, { tSec: 1, altKm: 1 }] }), 'x.json')).toThrow(/downrangeKm or speedKmS/);
    expect(() => parseTrajectory('x', 'x.txt')).toThrow(/unsupported/);
  });

  it('matches launches by id first, then by name fragment', () => {
    const a = parseTrajectory(JSON.stringify(json), 'a.json');
    const b = parseTrajectory(JSON.stringify({ ...json, id: 'b', match: { launchId: 'L9' } }), 'b.json');
    expect(matchTrajectory([a, b], { id: 'L9', name: 'Starlink 1' })).toBe(b);
    expect(matchTrajectory([a, b], { id: 'L1', name: 'falcon 9 | starlink 1' })).toBe(a);
    expect(matchTrajectory([a, b], { id: 'L1', name: 'Electron' })).toBeUndefined();
  });

  it('anchors samples at liftoff', () => {
    const t = parseTrajectory(JSON.stringify(json), 'j.json');
    const s = trajectorySamples(t, { latDeg: 28.5, lonDeg: -80.6 }, 1_000_000);
    expect(s.map((x) => x[0])).toEqual([1_000_000, 1_010_000, 1_020_000]);
  });
});

describe('flightclub connector', () => {
  it('loads files given as path -> text in file-name order, reports broken ones, ignores other extensions', () => {
    const loaded = loadTrajectories({
      'dir/b.json': JSON.stringify({ ...json, id: 'b' }), 'dir/a.json': JSON.stringify({ ...json, id: 'a' }),
      'dir/bad.json': '{"rows": 3}', 'dir/notes.txt': 'x',
    });
    expect(loaded.trajectories.map((x) => x.id)).toEqual(['a', 'b']);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.signature).toBe(`a.json:${JSON.stringify({ ...json, id: 'a' }).length}|b.json:${JSON.stringify({ ...json, id: 'b' }).length}|bad.json:11`);
  });

  it('the bundled data/trajectories files (import.meta.glob) include the shipped example and all parse', async () => {
    const hub = new Hub(0);
    const health = { note: undefined as string | undefined };
    await flightclub.run!({ hub, health, config: engineConfig() } as unknown as ConnectorContext);
    expect(health.note).toMatch(/^\d+ trajectory file\(s\)$/);
    expect(hub.trajectories.map((x) => x.id)).toContain('example-leo-ascent');
  });

  it('applies the trajectories once, and again only when the files change', async () => {
    const hub = new Hub(0);
    const ctx = { hub, health: {}, config: engineConfig() } as unknown as ConnectorContext;
    const c = createFlightclub({ 'a.json': JSON.stringify(json) });
    await c.run!(ctx);
    const first = hub.trajectories;
    expect(first.map((x) => x.id)).toEqual(['j']);
    await c.run!(ctx);
    expect(hub.trajectories).toBe(first);
    expect(c.network).toBe(false);
    expect(c.intervalMs).toBe(30_000);
  });
});
