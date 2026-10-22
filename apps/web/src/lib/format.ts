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

export function fmtLat(deg: number): string {
  return `${Math.abs(deg).toFixed(3)}° ${deg >= 0 ? 'N' : 'S'}`;
}

export function fmtLon(deg: number): string {
  return `${Math.abs(deg).toFixed(3)}° ${deg >= 0 ? 'E' : 'W'}`;
}

export function fmtDist(km: number | undefined): string {
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

export function fmtBitrate(bps: number | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return DASH;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mb/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} kb/s`;
  return `${Math.round(bps)} b/s`;
}
