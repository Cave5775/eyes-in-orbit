import {
  ascentCompositeSegments, ascentEntityEvents, modeledAscentForLaunch, modeledAscentSegments, reconstructDownrange,
  sampleAscentRows, type AscentEvent, type AscentRow, type AscentSeries, type AscentSegmentBoundary, type CompositeSegment,
  type EntityEvent, type Launch, type LiveAscent, type ModeledAscent, type TrajectorySource,
} from '@eio/core';
import { trajectorySamples, type Trajectory } from './trajectory';

const DAY_MS = 86_400_000;

/**
 * Ascent telemetry ingest + trajectory selection.
 *
 * Source precedence for a launch entity's path: live (posted rows) > file (data/trajectories) >
 * modeled (nominal Falcon 9 model, `@eio/core` ascent-model) > pad only.
 *
 * Ingest format (`POST /api/telemetry/:launchId`, application/json), either a bare array
 *   [{ "tSec": 62, "altKm": 9.8, "speedKmS": 0.41 }, ...]
 * or an object
 *   { "rows": [...], "events": [{ "name": "MECO", "tSec": 151 }], "azimuthDeg": 158, "source": "webcast OCR", "replace": false }
 * `tSec` is seconds since liftoff (the launch NET is T+0), `speedKmS` is the Earth-relative speed
 * shown on the webcast (convert km/h / 3600, m/s / 1000 first). Rows merge into what is stored (same
 * `tSec` replaces), `replace: true` starts over. Downrange is integrated from speed and altitude rate.
 */

export const LIMITS = {
  maxRowsPerRequest: 2000,
  maxRowsStored: 7200,
  tSecMax: 7200,
  altKmMin: -0.5,
  altKmMax: 2000,
  speedKmSMax: 15,
  maxEvents: 32,
} as const;

export const BOOSTER_EVENTS = new Set(['BOOSTBACK', 'ENTRY_BURN', 'LANDING_BURN', 'LANDING']);
const EVENT_LABELS: Record<string, string> = {
  MAX_Q: 'MAX-Q', STAGE_SEP: 'SEP', FAIRING_SEP: 'FAIRING', LANDING_BURN: 'LAND BURN', ENTRY_BURN: 'ENTRY',
};

export interface TelemetryInput {
  rows: { tSec: number; altKm: number; speedKmS: number }[];
  events: { name: string; tSec: number }[];
  azimuthDeg?: number;
  source?: string;
  replace: boolean;
}

export type Validation = { ok: true; input: TelemetryInput } | { ok: false; error: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate a POST body. Collects the first problem into a message that names the offending row. */
export function validateTelemetryBody(body: unknown): Validation {
  const obj = Array.isArray(body) ? { rows: body } : body;
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'body must be an array of rows or an object with "rows"' };
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.rows) || o.rows.length === 0) return { ok: false, error: '"rows" must be a non-empty array' };
  if (o.rows.length > LIMITS.maxRowsPerRequest) return { ok: false, error: `at most ${LIMITS.maxRowsPerRequest} rows per request` };

  const byT = new Map<number, { tSec: number; altKm: number; speedKmS: number }>();
  for (let i = 0; i < o.rows.length; i++) {
    const r = o.rows[i] as Record<string, unknown> | null;
    const at = `row ${i}`;
    if (!r || typeof r !== 'object') return { ok: false, error: `${at}: not an object` };
    if (!isNum(r.tSec) || !isNum(r.altKm) || !isNum(r.speedKmS)) return { ok: false, error: `${at}: tSec, altKm and speedKmS must be finite numbers` };
    if (r.tSec < 0 || r.tSec > LIMITS.tSecMax) return { ok: false, error: `${at}: tSec must be within 0..${LIMITS.tSecMax} (seconds since liftoff)` };
    if (r.altKm < LIMITS.altKmMin || r.altKm > LIMITS.altKmMax) return { ok: false, error: `${at}: altKm must be within ${LIMITS.altKmMin}..${LIMITS.altKmMax} (kilometres)` };
    if (r.speedKmS < 0 || r.speedKmS > LIMITS.speedKmSMax) return { ok: false, error: `${at}: speedKmS must be within 0..${LIMITS.speedKmSMax} (km/s, not km/h)` };
    byT.set(r.tSec, { tSec: r.tSec, altKm: Math.max(0, r.altKm), speedKmS: r.speedKmS });
  }

  const events: TelemetryInput['events'] = [];
  if (o.events !== undefined) {
    if (!Array.isArray(o.events) || o.events.length > LIMITS.maxEvents) return { ok: false, error: `"events" must be an array of at most ${LIMITS.maxEvents}` };
    for (let i = 0; i < o.events.length; i++) {
      const e = o.events[i] as Record<string, unknown> | null;
      if (!e || typeof e.name !== 'string' || !/^[A-Z0-9_]{2,24}$/.test(e.name) || !isNum(e.tSec) || e.tSec < 0 || e.tSec > LIMITS.tSecMax) {
        return { ok: false, error: `event ${i}: needs name (A-Z, 0-9, _; 2-24 chars) and tSec within 0..${LIMITS.tSecMax}` };
      }
      events.push({ name: e.name, tSec: e.tSec });
    }
  }
  if (o.azimuthDeg !== undefined && (!isNum(o.azimuthDeg) || o.azimuthDeg < 0 || o.azimuthDeg >= 360)) return { ok: false, error: '"azimuthDeg" must be a number in [0, 360)' };
  if (o.source !== undefined && (typeof o.source !== 'string' || o.source.length > 80)) return { ok: false, error: '"source" must be a string of at most 80 characters' };
  if (o.replace !== undefined && typeof o.replace !== 'boolean') return { ok: false, error: '"replace" must be a boolean' };

  return {
    ok: true,
    input: {
      rows: [...byT.values()].sort((a, b) => a.tSec - b.tSec), events,
      azimuthDeg: o.azimuthDeg as number | undefined, source: o.source as string | undefined, replace: o.replace === true,
    },
  };
}

/** Merge validated input into the stored live series (or start a new one). Throws when the stored size cap would be exceeded. */
export function mergeLive(prev: LiveAscent | undefined, input: TelemetryInput, nowMs: number): LiveAscent {
  const byT = new Map<number, { tSec: number; altKm: number; speedKmS: number }>();
  if (prev && !input.replace) for (const r of prev.rows) byT.set(r.tSec, r);
  for (const r of input.rows) byT.set(r.tSec, r);
  if (byT.size > LIMITS.maxRowsStored) throw new Error(`stored rows would exceed ${LIMITS.maxRowsStored}; post with "replace": true`);
  const sorted = [...byT.values()].sort((a, b) => a.tSec - b.tSec);
  const dr = reconstructDownrange(sorted);
  const rows: AscentRow[] = sorted.map((r, i) => ({ ...r, downrangeKm: dr[i].downrangeKm }));

  const events = new Map<string, AscentEvent>();
  if (prev && !input.replace) for (const e of prev.events) events.set(e.name, e);
  for (const e of input.events) {
    events.set(e.name, {
      name: e.name, label: EVENT_LABELS[e.name] ?? e.name, tSec: e.tSec,
      track: BOOSTER_EVENTS.has(e.name) ? 'booster' : 'vehicle', reported: true,
    });
  }
  return {
    rows, events: [...events.values()].sort((a, b) => a.tSec - b.tSec), updatedAt: nowMs,
    source: input.source ?? (input.replace ? undefined : prev?.source),
    azimuthDeg: input.azimuthDeg ?? (input.replace ? undefined : prev?.azimuthDeg),
  };
}

/** Modeled events with any reported ones (same name) replacing them. */
export function mergeEvents(modeled: AscentEvent[], live: AscentEvent[]): AscentEvent[] {
  const names = new Set(live.map((e) => e.name));
  return [...modeled.filter((e) => !names.has(e.name)), ...live].sort((a, b) => a.tSec - b.tSec);
}

export interface AscentPlan {
  /** null: the launch has neither live data, a file nor a modeled ascent (stays at the pad) */
  source: TrajectorySource | null;
  segments: CompositeSegment[] | undefined;
  events: EntityEvent[] | undefined;
  modeled: ModeledAscent | null;
  /** live series reached its last row; the path continues on the modeled curve from here */
  extrapolatedFromSec: number | null;
  azimuthDeg: number | undefined;
}

const HOLD_SEC = 600;

/** Live rows, a modeled lead-in before the first row and a modeled (offset) continuation after the last one. */
export function liveSegments(netMs: number, pad: { latDeg: number; lonDeg: number }, live: LiveAscent, modeled: ModeledAscent | null, fileAzimuth?: number): {
  segments: CompositeSegment[]; extrapolatedFromSec: number | null; azimuthDeg: number;
} {
  const azimuthDeg = live.azimuthDeg ?? modeled?.azimuthDeg ?? fileAzimuth ?? 90;
  const first = live.rows[0], last = live.rows[live.rows.length - 1];
  const rows: { tSec: number; altKm: number; downrangeKm: number }[] = [];
  const bounds: AscentSegmentBoundary[] = [];

  if (first.tSec > 0) {
    // ramp the modeled lead-in onto the first measured point so the path has no jump
    const m0 = modeled ? sampleAscentRows(modeled.rows, first.tSec)! : { altKm: 0, downrangeKm: 0 };
    const dAlt = first.altKm - m0.altKm, dDr = first.downrangeKm - m0.downrangeKm;
    const lead = modeled ? modeled.rows.filter((r) => r.tSec < first.tSec) : [{ tSec: 0, altKm: 0, downrangeKm: 0 }];
    for (const r of lead) {
      const k = r.tSec / first.tSec;
      rows.push({ tSec: r.tSec, altKm: Math.max(0, r.altKm + dAlt * k), downrangeKm: r.downrangeKm + dDr * k });
    }
    bounds.push({ phase: modeled ? 'lead-in (modeled)' : 'lead-in', fromSec: 0, confidence: 0.4 });
  }
  rows.push(...live.rows.map((r) => ({ tSec: r.tSec, altKm: r.altKm, downrangeKm: r.downrangeKm })));
  bounds.push({ phase: 'ascent (live)', fromSec: first.tSec });

  let extrapolatedFromSec: number | null = null;
  const modeledEnd = modeled ? modeled.rows[modeled.rows.length - 1].tSec : 0;
  if (modeled && last.tSec < modeledEnd) {
    const m1 = sampleAscentRows(modeled.rows, last.tSec)!;
    for (const r of modeled.rows) {
      if (r.tSec <= last.tSec) continue;
      rows.push({ tSec: r.tSec, altKm: Math.max(0, last.altKm + (r.altKm - m1.altKm)), downrangeKm: last.downrangeKm + (r.downrangeKm - m1.downrangeKm) });
    }
    bounds.push({ phase: 'extrapolated (modeled)', fromSec: last.tSec, confidence: 0.4 });
    extrapolatedFromSec = last.tSec;
  } else if (!modeled) {
    rows.push({ tSec: last.tSec + HOLD_SEC, altKm: last.altKm, downrangeKm: last.downrangeKm });
    bounds.push({ phase: 'last fix (held)', fromSec: last.tSec, confidence: 0.3 });
    extrapolatedFromSec = last.tSec;
  }
  return { segments: ascentCompositeSegments(netMs, pad, azimuthDeg, rows, bounds, { trailingPad: true }), extrapolatedFromSec, azimuthDeg };
}

/** Decide the trajectory source for a launch and build its composite segments and events. */
export function planAscent(launch: Launch, trajectory?: Trajectory, live?: LiveAscent): AscentPlan {
  const netMs = Date.parse(launch.net);
  const modeled = modeledAscentForLaunch(launch);
  const none: AscentPlan = { source: null, segments: undefined, events: undefined, modeled, extrapolatedFromSec: null, azimuthDeg: undefined };
  if (!launch.pad || !Number.isFinite(netMs)) return none;
  const pad = { latDeg: launch.pad.latitude, lonDeg: launch.pad.longitude };

  if (live && live.rows.length) {
    const { segments, extrapolatedFromSec, azimuthDeg } = liveSegments(netMs, pad, live, modeled, trajectory?.azimuthDeg);
    return { source: 'live', segments, events: ascentEntityEvents(mergeEvents(modeled?.events ?? [], live.events), netMs), modeled, extrapolatedFromSec, azimuthDeg };
  }
  if (trajectory) {
    const samples = trajectorySamples(trajectory, pad, netMs);
    const segments: CompositeSegment[] = [
      { fromMs: netMs - 30 * DAY_MS, toMs: netMs - 1, phase: 'pad', spec: { type: 'geodetic', bodyId: 'EARTH', latDeg: pad.latDeg, lonDeg: pad.lonDeg, altKm: 0 } },
      { fromMs: netMs, toMs: samples[samples.length - 1][0], phase: 'ascent', spec: { type: 'sampled', frame: 'EARTH:fixed', samples } },
    ];
    return { source: 'file', segments, events: undefined, modeled, extrapolatedFromSec: null, azimuthDeg: trajectory.azimuthDeg };
  }
  if (modeled) {
    const segments = modeledAscentSegments(netMs, pad, modeled);
    return { source: 'modeled', segments, events: ascentEntityEvents(modeled.events, netMs), modeled, extrapolatedFromSec: null, azimuthDeg: modeled.azimuthDeg };
  }
  return none;
}

/** `GET /api/telemetry/:launchId` payload. */
export function buildSeries(launch: Launch, trajectory: Trajectory | undefined, live: LiveAscent | undefined): AscentSeries {
  const plan = planAscent(launch, trajectory, live);
  const lastLive = live?.rows[live.rows.length - 1];
  return {
    launchId: launch.id,
    entityId: launch.entityId,
    liftoffMs: Date.parse(launch.net),
    source: plan.source,
    modeled: plan.modeled,
    file: trajectory ? { id: trajectory.id, source: trajectory.source, rows: trajectory.rows } : null,
    live: live && lastLive ? { ...live, lastTSec: lastLive.tSec, extrapolatedFromSec: plan.extrapolatedFromSec } : null,
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True when a request comes from this machine (socket address, and Origin when a browser sends one). */
export function isLocalRequest(remoteAddress: string | undefined, origin?: string): boolean {
  if (!remoteAddress || !LOOPBACK.has(remoteAddress)) return false;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}
