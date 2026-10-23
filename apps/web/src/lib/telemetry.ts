import {
  CompositeProvider, DEG, Sgp4Provider, norm, stateToGeodetic, type EntityGraph, type EntityRecord,
} from '@eio/core';
import { SHELL_THRESHOLD_KM } from './deepspace';
import { orbitPeriodSec } from './orbit';
import type { RefBody } from './ref-body';

export interface Telemetry {
  /** geocentric distance, km */
  rangeKm: number;
  latDeg?: number;
  lonDeg?: number;
  altKm?: number;
  speedKmS?: number;
  periodSec?: number;
  confidence?: number;
  phase?: string;
  /** drawn on the compressed deep-space shell */
  shell: boolean;
  /** SGP4 element age, days */
  elementAgeDays?: number;
  /** distance and speed relative to the reference body, when that is not the Earth */
  refRangeKm?: number;
  refSpeedKmS?: number;
}

/** Live state of an entity from the shared graph at sim time `t`, in display-ready units. */
export function computeTelemetry(graph: EntityGraph, rec: EntityRecord, t: number, ref: RefBody = 'EARTH'): Telemetry | null {
  const s = graph.stateOf(rec.id, t);
  if (!s) return null;
  const inertial = graph.stateIn(rec.id, t, 'EARTH:inertial');
  const rangeKm = inertial ? norm(inertial.r) : NaN;
  const shell = rangeKm > SHELL_THRESHOLD_KM;
  const out: Telemetry = { rangeKm, shell, confidence: s.confidence, speedKmS: inertial?.v ? norm(inertial.v) : undefined };

  if (ref !== 'EARTH') {
    // the frame hop in core re-expresses the state relative to the Moon or the Sun
    const rel = graph.stateIn(rec.id, t, `${ref}:inertial`);
    if (rel) {
      out.refRangeKm = norm(rel.r);
      out.refSpeedKmS = rel.v ? norm(rel.v) : undefined;
    }
  }

  // surface coordinates only make sense near the owning body
  if (!shell || rec.bodyId !== 'EARTH') {
    try {
      const g = stateToGeodetic(s, t, rec.bodyId);
      out.latDeg = g.lat / DEG;
      out.lonDeg = g.lon / DEG;
      out.altKm = g.alt;
    } catch {
      /* unknown body */
    }
  }
  const provider = graph.provider(rec.id);
  if (inertial && !shell && rec.bodyId === 'EARTH') out.periodSec = orbitPeriodSec(graph, rec, inertial) ?? undefined;
  if (provider instanceof Sgp4Provider && rec.provider?.type === 'sgp4') {
    out.elementAgeDays = (t - Date.parse(rec.provider.omm.EPOCH.endsWith('Z') ? rec.provider.omm.EPOCH : `${rec.provider.omm.EPOCH}Z`)) / 86_400_000;
  }
  out.phase = provider instanceof CompositeProvider ? provider.segmentAt(t)?.phase ?? rec.phase : rec.phase;
  return out;
}
