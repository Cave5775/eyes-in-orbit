const p2 = (n: number) => String(n).padStart(2, '0');
const DASH = '—';

/** `2026-10-22 14:03:05` in UTC. */
export function fmtUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

export function fmtShortUtc(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}Z`;
}

export function fmtNum(n: number | undefined | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** camelCase / snake_case key -> spaced words. */
export function humanize(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

/** Latitude, always 3 decimals (`12.345° N`). */
export function fmtLat(deg: number | undefined | null): string {
  if (deg == null || !Number.isFinite(deg)) return DASH;
  return `${Math.abs(deg).toFixed(3)}° ${deg >= 0 ? 'N' : 'S'}`;
}

/** Longitude, always 3 decimals (`123.456° E`). */
export function fmtLon(deg: number | undefined | null): string {
  if (deg == null || !Number.isFinite(deg)) return DASH;
  return `${Math.abs(deg).toFixed(3)}° ${deg >= 0 ? 'E' : 'W'}`;
}

/** Altitude / generic kilometre quantity, 1 decimal with thousands separators. */
export function fmtKm(km: number | undefined | null, digits = 1): string {
  return km == null || !Number.isFinite(km) ? DASH : `${fmtNum(km, digits)} km`;
}

/** Speed in km/s, 3 decimals. */
export function fmtSpeedKmS(v: number | undefined | null): string {
  return v == null || !Number.isFinite(v) ? DASH : `${fmtNum(v, 3)} km/s`;
}

/** Speed in km/h, whole numbers. */
export function fmtSpeedKmh(v: number | undefined | null): string {
  return v == null || !Number.isFinite(v) ? DASH : `${fmtNum(v, 0)} km/h`;
}

/** Orbital period given in seconds, shown in minutes with 1 decimal. */
export function fmtPeriod(sec: number | undefined | null): string {
  return sec == null || !Number.isFinite(sec) || sec <= 0 ? DASH : `${fmtNum(sec / 60, 1)} min`;
}

/** Angle in degrees, 1 decimal. */
export function fmtDeg(deg: number | undefined | null, digits = 1): string {
  return deg == null || !Number.isFinite(deg) ? DASH : `${fmtNum(deg, digits)}°`;
}

/** Fraction 0..1 as a whole percent. */
export function fmtPercent(frac: number | undefined | null): string {
  return frac == null || !Number.isFinite(frac) ? DASH : `${Math.round(frac * 100)}%`;
}

/** Days with 1 decimal. */
export function fmtDays(d: number | undefined | null): string {
  return d == null || !Number.isFinite(d) ? DASH : `${fmtNum(d, 1)} d`;
}

/** Distance: AU / million km / km, with a fixed number of decimals per band. */
export function fmtDist(km: number | undefined | null): string {
  if (km == null || !Number.isFinite(km)) return DASH;
  if (km >= 1.5e8) return `${(km / 1.495978707e8).toFixed(2)} AU`;
  if (km >= 1e6) return `${(km / 1e6).toFixed(2)} Mkm`;
  return `${fmtNum(km, km < 100 ? 2 : 0)} km`;
}

export function fmtDuration(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return DASH;
  const s = Math.round(Math.abs(sec));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.floor(s / 60)}m ${p2(s % 60)}s`;
  if (s < 172800) return `${Math.floor(s / 3600)}h ${p2(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function fmtAgo(ms: number | undefined, nowMs = Date.now()): string {
  return ms == null ? DASH : `${fmtDuration((nowMs - ms) / 1000)} ago`;
}

/** One-way or round-trip light time: seconds with 1 decimal below 100 s, otherwise a coarse duration. */
export function fmtLightTime(sec: number | undefined | null): string {
  if (sec == null || !Number.isFinite(sec)) return DASH;
  return Math.abs(sec) < 100 ? `${fmtNum(sec, 1)} s` : fmtDuration(sec);
}

/** Data rate with unit scaling (b/s, kb/s, Mb/s, Gb/s) and at most 2 decimals. */
export function fmtBitrate(bps: number | undefined | null): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return DASH;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gb/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mb/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} kb/s`;
  return `${Math.round(bps)} b/s`;
}

const LONG_FLOAT = /(?<![\d.:])(-?\d+)\.(\d{4,})(?![\d.])/g;

/**
 * Round every long decimal (4+ fractional digits) found in free-form text to 3 decimals and drop
 * trailing zeros. Leaves ISO timestamps, version-like `1.2.3` strings and short decimals alone.
 */
export function roundLongFloats(text: string, digits = 3): string {
  return text.replace(LONG_FLOAT, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n)) return m;
    const out = n.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return out === '-0' ? '0' : out;
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Display form of one server `attrs` value. Known keys get unit-aware formatting, other numbers a
 * fixed 0 (integers) or 2 decimals, strings have long decimals rounded, ISO timestamps become UTC.
 */
export function fmtAttr(key: string, v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') {
    if (ISO_DATE.test(v)) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return `${fmtUtc(t)} UTC`;
    }
    return roundLongFloats(v);
  }
  if (!Number.isFinite(v)) return DASH;
  switch (key) {
    case 'rangeKm': return fmtDist(v);
    case 'rtltSec': case 'owltSec': return fmtLightTime(v);
    case 'dataRate': case 'dataRateBps': case 'downlinkRate': case 'uplinkRate': return fmtBitrate(v);
    case 'speedKmS': return fmtSpeedKmS(v);
    case 'speedKmh': return fmtSpeedKmh(v);
    case 'latDeg': case 'latitude': return fmtLat(v);
    case 'lonDeg': case 'longitude': return fmtLon(v);
  }
  if (/Km$/.test(key)) return fmtKm(v);
  if (/Deg$/.test(key)) return fmtDeg(v);
  if (/Sec$/.test(key)) return fmtLightTime(v);
  return fmtNum(v, Number.isInteger(v) ? 0 : 2);
}

/** Telemetry-feed string value (already a string on the wire): long decimals are rounded, the rest is kept. */
export function fmtTelemetryValue(value: string): string {
  return roundLongFloats(value.trim());
}
