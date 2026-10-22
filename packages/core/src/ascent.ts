import { DEG, Vec3 } from './math';
import type { Sample } from './types';
import { Body } from './bodies';
import { geodeticToFixed } from './frames';

/** Point reached from (latDeg, lonDeg) travelling `distKm` along the great circle at `azimuthDeg`. */
export function destinationPoint(
  latDeg: number, lonDeg: number, azimuthDeg: number, distKm: number, radiusKm: number,
): { latDeg: number; lonDeg: number } {
  const d = distKm / radiusKm;
  const lat1 = latDeg * DEG, lon1 = lonDeg * DEG, az = azimuthDeg * DEG;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(az));
  const lon2 = lon1 + Math.atan2(Math.sin(az) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { latDeg: lat2 / DEG, lonDeg: ((lon2 / DEG + 540) % 360) - 180 };
}

/**
 * Downrange displacement over a time step from speed and altitude rate (reference doc, section 2):
 *   ds = sqrt(max(0, v^2 - (dh/dt)^2)) * dt   (v in km/s, dhdt in km/s, dt in s)
 */
export function downrangeStepKm(speedKmS: number, dhdtKmS: number, dtSec: number): number {
  return Math.sqrt(Math.max(0, speedKmS * speedKmS - dhdtKmS * dhdtKmS)) * dtSec;
}

export interface TelemetryRow {
  /** seconds since liftoff */
  tSec: number;
  altKm: number;
  speedKmS: number;
}

/** Reconstruct downrange distance by integrating OCR/webcast telemetry rows. */
export function reconstructDownrange(rows: TelemetryRow[]): { tSec: number; altKm: number; downrangeKm: number }[] {
  const out: { tSec: number; altKm: number; downrangeKm: number }[] = [];
  let s = 0;
  rows.forEach((row, i) => {
    if (i > 0) {
      const prev = rows[i - 1];
      const dt = row.tSec - prev.tSec;
      if (dt > 0) s += downrangeStepKm((row.speedKmS + prev.speedKmS) / 2, (row.altKm - prev.altKm) / dt, dt);
    }
    out.push({ tSec: row.tSec, altKm: row.altKm, downrangeKm: s });
  });
  return out;
}

/**
 * Turn a (time, altitude, downrange) profile into body-fixed samples along a launch azimuth.
 * `liftoffMs` anchors the profile in absolute time.
 */
export function profileToFixedSamples(
  body: Body,
  pad: { latDeg: number; lonDeg: number },
  azimuthDeg: number,
  liftoffMs: number,
  rows: { tSec: number; altKm: number; downrangeKm: number }[],
): Sample[] {
  return rows.map((row) => {
    const p = destinationPoint(pad.latDeg, pad.lonDeg, azimuthDeg, row.downrangeKm, body.radiusKm);
    const r: Vec3 = geodeticToFixed({ lat: p.latDeg * DEG, lon: p.lonDeg * DEG, alt: row.altKm }, body);
    return [liftoffMs + row.tSec * 1000, r[0], r[1], r[2]];
  });
}
