import { defaultBodies, profileToFixedSamples, reconstructDownrange, type Launch, type Sample } from '@eio/core';

/**
 * Ascent trajectory file format (`data/trajectories/*.json|csv`, example in data/trajectories/example.json).
 *
 * JSON: { "id", "source"?, "azimuthDeg"?, "match": { "launchId"?, "nameContains"? }, "rows": [...] }
 * CSV:  `# key: value` comment lines (id, source, azimuthDeg, launchId, nameContains), then a header
 *       `tSec,altKm,speedKmS[,downrangeKm]` and one row per sample.
 *
 * Rows are { tSec (since liftoff), altKm, speedKmS?, downrangeKm? }. When any row lacks `downrangeKm`
 * it is integrated from speed and altitude rate (`reconstructDownrange`, reference doc section 2).
 * `azimuthDeg` defaults to 90 (due east). A trajectory attaches to a launch by LL2 id or by a
 * case-insensitive substring of the launch name; liftoff is anchored at the launch NET.
 */
export interface Trajectory {
  id: string;
  source?: string;
  azimuthDeg: number;
  match: { launchId?: string; nameContains?: string };
  rows: { tSec: number; altKm: number; downrangeKm: number }[];
}

interface RawRow {
  tSec: number;
  altKm: number;
  speedKmS?: number;
  downrangeKm?: number;
}

export function parseTrajectory(text: string, filename: string): Trajectory {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) return fromJson(JSON.parse(text), filename);
  if (lower.endsWith('.csv')) return fromCsv(text, filename);
  throw new Error(`unsupported trajectory file ${filename}`);
}

function fromJson(j: any, filename: string): Trajectory {
  if (!Array.isArray(j?.rows)) throw new Error(`${filename}: missing "rows" array`);
  return build(
    String(j.id ?? filename.replace(/\.\w+$/, '')), j.source, j.azimuthDeg, j.match ?? {},
    j.rows.map((r: any) => ({ tSec: +r.tSec, altKm: +r.altKm, speedKmS: r.speedKmS == null ? undefined : +r.speedKmS, downrangeKm: r.downrangeKm == null ? undefined : +r.downrangeKm })),
    filename,
  );
}

function fromCsv(text: string, filename: string): Trajectory {
  const meta: Record<string, string> = {};
  let header: string[] | undefined;
  const rows: RawRow[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^#\s*(\w+)\s*:\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[2];
    else if (line.startsWith('#')) continue;
    else if (!header) header = line.split(',').map((h) => h.trim());
    else {
      const cells = line.split(',');
      const get = (name: string) => {
        const i = header!.indexOf(name);
        return i < 0 || cells[i]?.trim() === '' ? undefined : Number(cells[i]);
      };
      rows.push({ tSec: get('tSec')!, altKm: get('altKm')!, speedKmS: get('speedKmS'), downrangeKm: get('downrangeKm') });
    }
  }
  return build(
    meta.id ?? filename.replace(/\.\w+$/, ''), meta.source, meta.azimuthDeg == null ? undefined : Number(meta.azimuthDeg),
    { launchId: meta.launchId, nameContains: meta.nameContains }, rows, filename,
  );
}

function build(id: string, source: string | undefined, azimuth: unknown, match: Trajectory['match'], raw: RawRow[], filename: string): Trajectory {
  if (raw.length < 2) throw new Error(`${filename}: need at least 2 rows`);
  if (raw.some((r) => !Number.isFinite(r.tSec) || !Number.isFinite(r.altKm))) throw new Error(`${filename}: rows need numeric tSec and altKm`);
  if (!match.launchId && !match.nameContains) throw new Error(`${filename}: "match" needs launchId or nameContains`);
  const sorted = [...raw].sort((a, b) => a.tSec - b.tSec);
  let rows: Trajectory['rows'];
  if (sorted.every((r) => Number.isFinite(r.downrangeKm))) {
    rows = sorted.map((r) => ({ tSec: r.tSec, altKm: r.altKm, downrangeKm: r.downrangeKm! }));
  } else if (sorted.every((r) => Number.isFinite(r.speedKmS))) {
    rows = reconstructDownrange(sorted.map((r) => ({ tSec: r.tSec, altKm: r.altKm, speedKmS: r.speedKmS! })));
  } else throw new Error(`${filename}: rows need either downrangeKm or speedKmS on every row`);
  return {
    id, source, rows,
    azimuthDeg: Number.isFinite(Number(azimuth)) && azimuth != null ? Number(azimuth) : 90,
    match: { launchId: match.launchId || undefined, nameContains: match.nameContains || undefined },
  };
}

export function matchTrajectory(trajectories: Trajectory[], launch: Pick<Launch, 'id' | 'name'>): Trajectory | undefined {
  const name = launch.name.toLowerCase();
  return trajectories.find((t) => t.match.launchId === launch.id)
    ?? trajectories.find((t) => t.match.nameContains && name.includes(t.match.nameContains.toLowerCase()));
}

/** Body-fixed samples (`EARTH:fixed`) anchored at liftoff. */
export function trajectorySamples(t: Trajectory, pad: { latDeg: number; lonDeg: number }, liftoffMs: number): Sample[] {
  return profileToFixedSamples(defaultBodies.get('EARTH'), pad, t.azimuthDeg, liftoffMs, t.rows);
}
