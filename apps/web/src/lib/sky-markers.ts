import { DEG, type EntityRecord } from '@eio/core';
import type { V3 } from './camera';
import { fmtDist } from './format';
import { groundObserver, type SkyMarker, type SkyObserver } from './sky-annotations';
import { precessFromJ2000, raDecToAzEl, raDecToDir, dirToRaDec, type AzEl, type RaDec } from './sky-frame';

/**
 * The pure parts of the marker layer of the Sky view (ui/SkyMarkers.tsx): the observer, the text of the hover tooltip, what a
 * click on a marker does and the path of the turn toward a body. The sky maths itself is lib/sky-annotations.ts.
 */

/** A click lands on a marker when it is within this many px of its ring. */
export const MARKER_HIT_PX = 12;
/** A press that moves farther than this before it is released is a drag (Aladin pans), not a click, px. */
export const CLICK_DRAG_PX = 4;
/** The turn toward a clicked body, ms: Aladin 3.8.2 has no animation call that keeps the rotation and field of view (see lib/aladin.ts). */
export const TURN_MS = 400;

/** Is the pointer movement between press and release too long for a click? */
export const isDragMove = (dx: number, dy: number): boolean => Math.hypot(dx, dy) > CLICK_DRAG_PX;

/** What a click does. `turn`: select the body and turn the view to it. `leave`: select it and leave the sky view. */
export type MarkerClick = { kind: 'turn' | 'leave'; id: string };

/**
 * A completed click (no drag) on a marker or on empty sky. `hitId` is the marker under it (`nearestMarker`), `detail` the click
 * count the browser reports (1, or 2 for the second click within the system's double-click interval), `lastId` the marker the
 * previous click of this series turned to. A second click on that same marker leaves; a second click on another one is a
 * first click of its own. Empty sky does nothing.
 */
export function markerClick(hitId: string | null, detail: number, lastId: string | null): MarkerClick | null {
  if (hitId === null) return null;
  return { kind: detail >= 2 && hitId === lastId ? 'leave' : 'turn', id: hitId };
}

/**
 * The observer of the first-person site: a ground site (geodetic provider on the Earth) as `groundObserver`, anything else (a
 * space telescope) at its Earth-inertial position from `stateIn`, the scene's own path (`graph.stateIn(id, t, 'EARTH:inertial')`).
 * Null when the position is not known.
 */
export function observerFor(rec: Pick<EntityRecord, 'id' | 'provider'>, tMs: number, stateIn: (id: string, tMs: number) => { r: V3 } | null | undefined): SkyObserver | null {
  const p = rec.provider;
  if (p && p.type === 'geodetic' && p.bodyId === 'EARTH') return groundObserver(p.latDeg, p.lonDeg, p.altKm, tMs);
  const s = stateIn(rec.id, tMs);
  if (!s || !Number.isFinite(s.r[0] + s.r[1] + s.r[2])) return null;
  return { r: [s.r[0], s.r[1], s.r[2]], bodyId: 'EARTH' };
}

/** Altitude and azimuth of a marker seen from a ground site (geometric, no refraction): its J2000 position is precessed to the date first. */
export function markerAzEl(m: Pick<SkyMarker, 'raDeg' | 'decDeg'>, tMs: number, latDeg: number, lonDeg: number): AzEl {
  const d = precessFromJ2000(m.raDeg, m.decDeg, tMs);
  return raDecToAzEl(d.raDeg, d.decDeg, tMs, latDeg, lonDeg);
}

const two = (n: number): string => (n < 10 ? '0' : '') + n;

/** Right ascension as `12h 34m 56.7s` (RA in degrees; rounded to 0.1 s, never `60.0s`). */
export function fmtRa(raDeg: number): string {
  let tenths = Math.round((((raDeg % 360) + 360) % 360) / 15 * 36000); // 0.1 s of time
  tenths %= 864000;
  const h = Math.floor(tenths / 36000), m = Math.floor((tenths % 36000) / 600), s = (tenths % 600) / 10;
  return `${two(h)}h ${two(m)}m ${s < 10 ? '0' : ''}${s.toFixed(1)}s`;
}

/** Declination as `-12° 34' 56"` (rounded to the arcsecond). */
export function fmtDecl(decDeg: number): string {
  const total = Math.round(Math.abs(decDeg) * 3600);
  const d = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${decDeg < 0 && total > 0 ? '-' : '+'}${two(d)}° ${two(m)}' ${two(s)}"`;
}

/** Why a marker is dimmed, for its tooltip; null for a visible one. */
export function hiddenReason(m: Pick<SkyMarker, 'hidden'>, ground: boolean): string | null {
  return !m.hidden ? null : ground ? 'Below the horizon' : 'Behind the Earth';
}

/**
 * The hover tooltip lines of a marker: name and kind, RA/Dec (J2000), altitude and azimuth for a ground site, the distance, why
 * it is dimmed, and `approximate position` when the position is a rough one.
 */
export function markerTip(m: SkyMarker, azEl: AzEl | null): string[] {
  const lines = [`${m.name}  ·  ${m.kind.replace(/_/g, ' ')}`, `RA ${fmtRa(m.raDeg)}  Dec ${fmtDecl(m.decDeg)} (J2000)`];
  if (azEl) lines.push(`Alt ${azEl.elDeg.toFixed(1)}°  Az ${azEl.azDeg.toFixed(1)}°`);
  lines.push(`Distance ${fmtDist(m.distKm)}`);
  const why = hiddenReason(m, azEl !== null);
  if (why) lines.push(why);
  if (m.approx) lines.push('approximate position');
  return lines;
}

/** Smooth start and end (cubic), 0..1 in and out. */
export const easeInOut = (p: number): number => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

const A: V3 = [0, 0, 0];
const B: V3 = [0, 0, 0];

/**
 * The point `p` (0..1) of the way from one RA/Dec to another along the great circle between them (J2000 degrees), written into
 * `out`. Equal or opposite points stay at `from` for every p < 1 (no path is defined for opposite ones), and p = 1 is `to`.
 */
export function slerpRaDec(from: RaDec, to: RaDec, p: number, out: RaDec = { raDeg: 0, decDeg: 0 }): RaDec {
  if (p >= 1) { out.raDeg = to.raDeg; out.decDeg = to.decDeg; return out; }
  raDecToDir(from.raDeg, from.decDeg, A);
  raDecToDir(to.raDeg, to.decDeg, B);
  const dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const w = Math.acos(dot), sw = Math.sin(w);
  if (!(sw > 1e-9) || p <= 0) { out.raDeg = from.raDeg; out.decDeg = from.decDeg; return out; }
  const ka = Math.sin((1 - p) * w) / sw, kb = Math.sin(p * w) / sw;
  const r = dirToRaDec([ka * A[0] + kb * B[0], ka * A[1] + kb * B[1], ka * A[2] + kb * B[2]]);
  out.raDeg = r.raDeg;
  out.decDeg = r.decDeg;
  return out;
}

/** Angular separation of two RA/Dec positions, degrees. */
export function separationDeg(a: RaDec, b: RaDec): number {
  const sd = Math.sin((a.decDeg - b.decDeg) * DEG / 2), sr = Math.sin((a.raDeg - b.raDeg) * DEG / 2);
  const h = sd * sd + Math.cos(a.decDeg * DEG) * Math.cos(b.decDeg * DEG) * sr * sr;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / DEG;
}
