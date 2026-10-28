/**
 * Signed offset of simulation time from the wall clock, as the four top-bar fields
 * (days, hours, minutes, seconds) plus a sign. Pure helpers; no clock access.
 */

export const SEC_MS = 1000;
export const MIN_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** Largest offset the fields can reach (about 100 years), keeps every Date in range. */
export const MAX_OFFSET_MS = 36_500 * DAY_MS;

export type Sign = 1 | -1;

export interface OffsetParts {
  sign: Sign;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** The text of the four fields while the user edits them (digits only, may be empty or overflowing). */
export interface OffsetFields {
  sign: Sign;
  days: string;
  hours: string;
  minutes: string;
  seconds: string;
}

/** Offset of sim time from wall time, ms (positive = sim is ahead of the wall clock). */
export function offsetMs(simMs: number, wallMs: number): number {
  return simMs - wallMs;
}

/** Sim time for a given wall time and offset. */
export function simTimeAt(wallMs: number, offset: number): number {
  return wallMs + offset;
}

export function clampOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, ms));
}

/** Split an offset into sign and whole d/h/m/s, rounded to the nearest second. Zero is positive. */
export function splitOffset(ms: number): OffsetParts {
  const total = Math.round(Math.abs(clampOffset(ms)) / SEC_MS);
  const sign: Sign = ms < 0 && total > 0 ? -1 : 1;
  return {
    sign,
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

/** Inverse of splitOffset; fields may overflow (90 minutes, 100 seconds) and are normalised by the arithmetic. */
export function joinOffset(p: { sign: Sign; days: number; hours: number; minutes: number; seconds: number }): number {
  const mag = p.days * DAY_MS + p.hours * HOUR_MS + p.minutes * MIN_MS + p.seconds * SEC_MS;
  return clampOffset(p.sign * mag) || 0; // `|| 0` turns -0 into 0
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Field texts for display: days unpadded-to-2, the rest two digits. */
export function offsetFields(ms: number): OffsetFields {
  const p = splitOffset(ms);
  return { sign: p.sign, days: pad2(p.days), hours: pad2(p.hours), minutes: pad2(p.minutes), seconds: pad2(p.seconds) };
}

/** `+dd:hh:mm:ss` text form of an offset. */
export function fmtOffset(ms: number): string {
  const f = offsetFields(ms);
  return `${f.sign < 0 ? '-' : '+'}${f.days}:${f.hours}:${f.minutes}:${f.seconds}`;
}

/** One field's text to a non-negative integer: empty or non-numeric is 0, a decimal point is truncated. */
export function parseField(text: string): number {
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Keep digits only; used as the input filter for each field. */
export function digitsOnly(text: string, maxLen = 6): string {
  return text.replace(/\D/g, '').slice(0, maxLen);
}

/** Offset in ms from the four field texts. Empty fields count as 0; large values are clamped. */
export function parseOffsetFields(f: OffsetFields): number {
  return joinOffset({
    sign: f.sign, days: parseField(f.days), hours: parseField(f.hours),
    minutes: parseField(f.minutes), seconds: parseField(f.seconds),
  });
}

/**
 * Parse a pasted/typed offset such as `-1:02:03:04`, `+90:00` or `45` (right-aligned: the last part is
 * seconds, then minutes, hours, days). A leading `+` or `-` sets the sign. Returns null when the text
 * is not of that shape.
 */
export function parseOffsetText(text: string): number | null {
  const m = /^\s*([+-]|−)?\s*(\d+(?::\d+){0,3})\s*$/.exec(text);
  if (!m) return null;
  const nums = m[2].split(':').map((x) => parseField(x));
  while (nums.length < 4) nums.unshift(0);
  const [days, hours, minutes, seconds] = nums;
  return joinOffset({ sign: m[1] === '-' || m[1] === '−' ? -1 : 1, days, hours, minutes, seconds });
}
