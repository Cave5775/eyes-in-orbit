import { AU_KM, OBLIQUITY_J2000 } from './ephemeris';
import { DEG, TWO_PI, type Vec3 } from './math';
import type { KeplerElements } from './types';

/**
 * Minor planet orbits from the Minor Planet Center's MPCORB.DAT, and the compact binary layout the server stores and the
 * browser draws as a point cloud. Pure: no network, no DOM.
 *
 * Credit: orbital elements are published by the Minor Planet Center (IAU), https://www.minorplanetcenter.net/iau/MPCORB.html.
 * The file header allows software to include the data "as long as this header is included ... and that proper attribution to the
 * Minor Planet Center is given" and the way to obtain updated copies is stated: new versions are at
 * https://www.minorplanetcenter.org/iau/MPCORB/MPCORB.DAT (and the .gz next to it), updated daily.
 *
 * Line layout (1-based columns, https://www.minorplanetcenter.net/iau/info/MPOrbitFormat.html, read 2026-11-18):
 *    1 -   7  a7     number or provisional designation, packed (https://www.minorplanetcenter.net/iau/info/PackedDes.html)
 *    9 -  13  f5.2   absolute magnitude H (may be blank)
 *   15 -  19  f5.2   slope parameter G
 *   21 -  25  a5     epoch, packed, .0 TT (https://www.minorplanetcenter.net/iau/info/PackedDates.html)
 *   27 -  35  f9.5   mean anomaly at the epoch, degrees
 *   38 -  46  f9.5   argument of perihelion, J2000.0, degrees
 *   49 -  57  f9.5   longitude of the ascending node, J2000.0, degrees
 *   60 -  68  f9.5   inclination to the ecliptic, J2000.0, degrees
 *   71 -  79  f9.7   eccentricity
 *   81 -  91  f11.8  mean daily motion, degrees per day (not stored: n follows from a)
 *   93 - 103  f11.7  semimajor axis, AU
 * The elements are osculating at the epoch and heliocentric, in ecliptic axes of J2000. A line that does not match this layout
 * is not parsed ("never guessed"): `parseMpcorbLine` returns null and the reader counts it.
 */

/** One minor planet orbit as read from a line (degrees and AU as published). */
export interface MpcOrbit {
  /** the packed designation as in the file: 5 characters (numbered) or 7 (provisional, survey) */
  packed: string;
  /** absolute magnitude H, null when the line has none */
  h: number | null;
  /** epoch, ms since 1970 UTC at 0h of the epoch day (the file's epoch is 0h TT: 69 s are ignored) */
  epochMs: number;
  m0Deg: number;
  argpDeg: number;
  nodeDeg: number;
  incDeg: number;
  e: number;
  aAu: number;
}

// ---------------------------------------------------------------- designations

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CENTURY = 'IJK';
/** half-month letters A..Y without I (24); the second letter A..Z without I (25) */
const HALF = 'ABCDEFGHJKLMNOPQRSTUVWXY';
const SECOND = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
const SURVEY = ['PLS', 'T1S', 'T2S', 'T3S'];
const SURVEY_TEXT = ['P-L', 'T-1', 'T-2', 'T-3'];

/**
 * Packed designation to a 32-bit code (0 and null: not understood). Numbered: the number (bit 31 clear; `A0345` = 100345,
 * `~AZaz` = 3140113). Provisional: bit 31 set, bit 30 clear, then century (2 bits), yy (7), half-month letter (5), second letter
 * (5), cycle count (10). Survey (`PLS2040`, `T1S3138`, ...): bits 31 and 30 set, survey (2 bits), number (14). The 12-character
 * comet forms and the extended `_` provisional form are not minor planet rows of MPCORB and return null.
 */
export function designationCode(packed: string): number | null {
  const s = packed.trim();
  if (s.length === 5) {
    if (/^\d{5}$/.test(s)) return Number(s);
    if (s[0] === '~') {
      let v = 0;
      for (const c of s.slice(1)) {
        const d = BASE62.indexOf(c);
        if (d < 0) return null;
        v = v * 62 + d;
      }
      return v + 620_000;
    }
    const hi = BASE62.indexOf(s[0]);
    if (hi < 10 || !/^\d{4}$/.test(s.slice(1))) return null;
    return hi * 10_000 + Number(s.slice(1));
  }
  if (s.length !== 7) return null;
  const sv = SURVEY.indexOf(s.slice(0, 3));
  if (sv >= 0) {
    if (!/^\d{4}$/.test(s.slice(3))) return null;
    return (0xc0000000 | (sv << 28) | Number(s.slice(3))) >>> 0;
  }
  const cent = CENTURY.indexOf(s[0]);
  const half = HALF.indexOf(s[3]);
  const second = SECOND.indexOf(s[6]);
  const c5 = BASE62.indexOf(s[4]);
  if (cent < 0 || half < 0 || second < 0 || c5 < 0 || !/^\d{2}$/.test(s.slice(1, 3)) || !/^\d$/.test(s[5])) return null;
  const cycle = c5 * 10 + Number(s[5]);
  if (cycle > 619) return null;
  return (0x80000000 | (cent << 28) | (Number(s.slice(1, 3)) << 21) | (half << 16) | (second << 11) | cycle) >>> 0;
}

/** The text of a designation code: `(433)` for numbered ones is written `433`, a provisional one `1995 XL1`, a survey one `2040 P-L`. */
export function designationText(code: number): string {
  if (code < 0x80000000) return String(code);
  if (code >= 0xc0000000) return `${code & 0x3fff} ${SURVEY_TEXT[(code >>> 28) & 3]}`;
  const year = (18 + ((code >>> 28) & 3)) * 100 + ((code >>> 21) & 127);
  const half = HALF[(code >>> 16) & 31], second = SECOND[(code >>> 11) & 31];
  const cycle = code & 0x7ff;
  return `${year} ${half}${second}${cycle > 0 ? cycle : ''}`;
}

/**
 * The packed epoch (`K2669` = 2026 June 9): century letter (I 18, J 19, K 20), two year digits, month (1-9, A-C), day (1-9, A-V
 * for 10-31). Null for anything else, including a day the month does not have.
 */
export function packedEpochMs(p: string): number | null {
  if (p.length !== 5) return null;
  const cent = CENTURY.indexOf(p[0]);
  const month = BASE62.indexOf(p[3]), day = BASE62.indexOf(p[4]);
  if (cent < 0 || !/^\d{2}$/.test(p.slice(1, 3)) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = (18 + cent) * 100 + Number(p.slice(1, 3));
  const ms = Date.UTC(year, month - 1, day);
  return new Date(ms).getUTCDate() === day ? ms : null;
}

// ---------------------------------------------------------------- one line

const NUM = /^\s*-?\d+(\.\d+)?\s*$/;
const col = (line: string, from: number, to: number): string => line.slice(from - 1, to);
const num = (line: string, from: number, to: number): number | null => {
  const s = col(line, from, to);
  return NUM.test(s) ? Number(s) : null;
};

/** Shortest line that holds every column used (the semimajor axis ends at column 103). */
export const MPC_MIN_LINE = 103;

/**
 * One data line of MPCORB.DAT. Null when it is not a complete orbit of the documented layout: wrong separators, a field that is
 * not a plain number, a designation or epoch that does not unpack, e outside [0, 1), a <= 0, angles outside their range.
 */
export function parseMpcorbLine(line: string): MpcOrbit | null {
  if (line.length < MPC_MIN_LINE) return null;
  // the blanks between the fields must be blanks: a shifted or foreign line fails here instead of being read with wrong columns
  for (const c of [8, 14, 20, 26, 37, 48, 59, 70, 80, 92]) if (line[c - 1] !== ' ') return null;
  const packed = col(line, 1, 7).trim();
  if (designationCode(packed) === null) return null;
  const hText = col(line, 9, 13);
  let h: number | null = null;
  if (hText.trim() !== '') {
    h = num(line, 9, 13);
    if (h === null || h < -10 || h > 60) return null;
  }
  const epochMs = packedEpochMs(col(line, 21, 25));
  const m0 = num(line, 27, 35), argp = num(line, 38, 46), node = num(line, 49, 57), inc = num(line, 60, 68);
  const e = num(line, 71, 79), a = num(line, 93, 103);
  if (epochMs === null || m0 === null || argp === null || node === null || inc === null || e === null || a === null) return null;
  const angle = (v: number): boolean => v >= 0 && v <= 360;
  if (!angle(m0) || !angle(argp) || !angle(node) || inc < 0 || inc > 180) return null;
  if (!(e >= 0 && e < 1) || !(a > 0 && a < 1e5)) return null;
  return { packed, h, epochMs, m0Deg: m0, argpDeg: argp, nodeDeg: node, incDeg: inc, e, aAu: a };
}

/** The elements as `KeplerElements` in the heliocentric EQUATORIAL J2000 axes of `SUN:inertial` (km, radians), plus the Sun's gm to propagate with. */
export function mpcToKepler(o: MpcOrbit): KeplerElements {
  return keplerFromDegrees(o.aAu, o.e, o.incDeg, o.nodeDeg, o.argpDeg, o.m0Deg, o.epochMs);
}

/**
 * Ecliptic J2000 elements (degrees, AU) as `KeplerElements` in the equatorial J2000 axes the frames use: the orbit plane is
 * rotated by the obliquity of J2000 (`OBLIQUITY_J2000`, the same rotation `eclipticToEquatorial` applies to a vector), so
 * `keplerState` gives the position the propagation of the point cloud gives.
 */
export function keplerFromDegrees(aAu: number, e: number, incDeg: number, nodeDeg: number, argpDeg: number, m0Deg: number, epochMs: number): KeplerElements {
  const i = incDeg * DEG, O = nodeDeg * DEG, w = argpDeg * DEG;
  const cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(i), si = Math.sin(i), cw = Math.cos(w), sw = Math.sin(w);
  // perifocal P (towards perihelion) and the plane normal W in ecliptic axes, rotated by the obliquity about x
  const P: Vec3 = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
  const Q: Vec3 = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
  const W: Vec3 = [sO * si, -cO * si, ci];
  const c = Math.cos(OBLIQUITY_J2000), s = Math.sin(OBLIQUITY_J2000);
  const rot = (v: Vec3): Vec3 => [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
  const p = rot(P), q = rot(Q), wv = rot(W);
  const inc = Math.atan2(Math.hypot(wv[0], wv[1]), wv[2]);
  let raan = 0, argp: number;
  if (Math.hypot(wv[0], wv[1]) > 1e-12) {
    raan = Math.atan2(wv[0], -wv[1]);
    // P.z = sin(argp) sin(i), Q.z = cos(argp) sin(i)
    argp = Math.atan2(p[2], q[2]);
  } else {
    argp = Math.atan2(p[1], p[0]);
  }
  const wrap = (x: number): number => ((x % TWO_PI) + TWO_PI) % TWO_PI;
  return { a: aAu * AU_KM, e, i: inc, raan: wrap(raan), argp: wrap(argp), m0: m0Deg * DEG, epochMs };
}

// ---------------------------------------------------------------- packed layout

/**
 * The compact layout of a set of orbits, sorted by H (brightest first, unknown H last), column by column (planes compress better
 * than records and the browser reads each plane as one typed array). Little endian, every plane 4-byte aligned:
 *
 *   bytes 0-3   magic `MPCB`; byte 4 version (1); bytes 8-11 count n (u32); bytes 12-15 length m of the meta JSON (u32)
 *   16..16+m    meta JSON (UTF-8), zero padded to a multiple of 4
 *   planes      desig u32[n] | h u16[n] | epoch u16[n] | m0 u32[n] | argp u32[n] | node u32[n] | inc u32[n] | ecc u32[n] | a f32[n]
 *
 * desig: `designationCode`. h: round((H + 10) * 100), 65535 = unknown. epoch: whole days since 1900-01-01 UTC (to 2079).
 * Angles: round(degrees / 360 * 2^32), so a step is 8.4e-8 degrees (the file has 1e-5). ecc: round(e * 2^32). a: float32 AU
 * (relative 6e-8). 32 bytes per object.
 */
export const PACKED_VERSION = 1;
export const BYTES_PER_ORBIT = 32;
const MAGIC = 0x4250434d; // 'MPCB' read little endian
const EPOCH0_MS = Date.UTC(1900, 0, 1);
const H_UNKNOWN = 65535;
const TWO32 = 4294967296;
/** Longest epoch the 16-bit day column holds, as ms */
export const MAX_EPOCH_MS = EPOCH0_MS + 65534 * 86_400_000;

export interface PackedMeta {
  /** where it came from and when (the connector fills these in) */
  source?: string;
  etag?: string | null;
  lastModified?: string | null;
  builtAt?: number;
  /** lines of the file that were orbits and were stored */
  parsed: number;
  /** data lines that could not be read (or whose epoch does not fit) and were left out */
  skipped: number;
  /** H range of the stored orbits */
  hMin?: number | null;
  hMax?: number | null;
  /** latest and earliest epoch present, ms */
  epochMin?: number | null;
  epochMax?: number | null;
}

export interface UnpackedOrbits {
  count: number;
  meta: PackedMeta;
  desig: Uint32Array;
  h: Uint16Array;
  epoch: Uint16Array;
  m0: Uint32Array;
  argp: Uint32Array;
  node: Uint32Array;
  inc: Uint32Array;
  ecc: Uint32Array;
  a: Float32Array;
}

const angleCode = (deg: number): number => Math.round((deg / 360) * TWO32) % TWO32;
export const angleFromCode = (c: number): number => (c / TWO32) * 360;
export const hFromCode = (c: number): number | null => (c === H_UNKNOWN ? null : c / 100 - 10);

/**
 * Collects orbits one by one into growing planes (about 32 bytes each, no objects kept), then `finish` sorts them by H and writes
 * the container. Memory is the planes, never the text of the file.
 */
export class OrbitBuilder {
  private cap = 1 << 16;
  private n = 0;
  private skippedEpoch = 0;
  private desig = new Uint32Array(this.cap);
  private h = new Uint16Array(this.cap);
  private epoch = new Uint16Array(this.cap);
  private m0 = new Uint32Array(this.cap);
  private argp = new Uint32Array(this.cap);
  private node = new Uint32Array(this.cap);
  private inc = new Uint32Array(this.cap);
  private ecc = new Uint32Array(this.cap);
  private a = new Float32Array(this.cap);

  get count(): number {
    return this.n;
  }

  /** Orbits refused by `add` (an epoch before 1900 or after 2079). */
  get refused(): number {
    return this.skippedEpoch;
  }

  private grow(): void {
    const cap = this.cap * 2;
    const g = <T extends Uint32Array | Uint16Array | Float32Array>(old: T): T => {
      const next = new (old.constructor as new (n: number) => T)(cap);
      next.set(old);
      return next;
    };
    this.desig = g(this.desig); this.h = g(this.h); this.epoch = g(this.epoch); this.m0 = g(this.m0); this.argp = g(this.argp);
    this.node = g(this.node); this.inc = g(this.inc); this.ecc = g(this.ecc); this.a = g(this.a);
    this.cap = cap;
  }

  /** Append one parsed orbit; false when its epoch does not fit the 16-bit day column. */
  add(o: MpcOrbit): boolean {
    const code = designationCode(o.packed);
    const day = Math.round((o.epochMs - EPOCH0_MS) / 86_400_000);
    if (code === null || day < 0 || day > 65534) {
      this.skippedEpoch++;
      return false;
    }
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    this.desig[i] = code;
    this.h[i] = o.h === null ? H_UNKNOWN : Math.min(H_UNKNOWN - 1, Math.max(0, Math.round((o.h + 10) * 100)));
    this.epoch[i] = day;
    this.m0[i] = angleCode(o.m0Deg);
    this.argp[i] = angleCode(o.argpDeg);
    this.node[i] = angleCode(o.nodeDeg);
    this.inc[i] = angleCode(o.incDeg);
    this.ecc[i] = Math.min(TWO32 - 1, Math.round(o.e * TWO32));
    this.a[i] = o.aAu;
    return true;
  }

  /** The container, sorted by H (ties keep file order). `meta.parsed` and the H/epoch ranges are filled in. */
  finish(meta: Partial<PackedMeta> & { skipped: number }): Uint8Array {
    const n = this.n;
    // sort key: quantised H above, file index below: one float64 sort, no comparator calls
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) keys[i] = this.h[i] * TWO32 + i;
    keys.sort();
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = keys[i] % TWO32;
    let hMin: number | null = null, hMax: number | null = null, eMin = Infinity, eMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const hq = this.h[order[i]];
      if (hq !== H_UNKNOWN) {
        const h = hq / 100 - 10;
        if (hMin === null) hMin = h;
        hMax = h;
      }
      const d = this.epoch[i];
      if (d < eMin) eMin = d;
      if (d > eMax) eMax = d;
    }
    const full: PackedMeta = {
      ...meta, parsed: n, skipped: meta.skipped + this.skippedEpoch, hMin, hMax,
      epochMin: n ? EPOCH0_MS + eMin * 86_400_000 : null, epochMax: n ? EPOCH0_MS + eMax * 86_400_000 : null,
    };
    const buf = writeContainer(n, full);
    const u = readContainer(buf);
    for (let i = 0; i < n; i++) {
      const j = order[i];
      u.desig[i] = this.desig[j]; u.h[i] = this.h[j]; u.epoch[i] = this.epoch[j]; u.m0[i] = this.m0[j]; u.argp[i] = this.argp[j];
      u.node[i] = this.node[j]; u.inc[i] = this.inc[j]; u.ecc[i] = this.ecc[j]; u.a[i] = this.a[j];
    }
    return buf;
  }
}

/** Bytes of the planes of `n` orbits (each plane padded to 4 bytes). */
const planeBytes = (n: number): number => 28 * n + 4 * ((n + 1) & ~1);

function writeContainer(n: number, meta: PackedMeta): Uint8Array {
  // ASCII only (non-ASCII escaped), so one byte per character and no TextEncoder (core has no DOM or Node types)
  const text = asciiJson(meta);
  const json = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) json[i] = text.charCodeAt(i);
  const head = 16 + ((json.length + 3) & ~3);
  const buf = new Uint8Array(head + planeBytes(n));
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint8(4, PACKED_VERSION);
  dv.setUint32(8, n, true);
  dv.setUint32(12, json.length, true);
  buf.set(json, 16);
  return buf;
}

/** Typed views over a container (no copy when `bytes` is 4-byte aligned, else one copy). Throws on a foreign or truncated buffer. */
export function readContainer(bytes: Uint8Array): UnpackedOrbits {
  if (bytes.length < 16) throw new Error('minor planet data: truncated header');
  // a view that does not start on a 4-byte boundary (a Node Buffer, or a stored blob) is copied into a fresh ArrayBuffer: `Uint8Array.slice` copies,
  // but `Buffer.slice` is a view, so the copy is explicit
  let aligned = bytes;
  if (bytes.byteOffset % 4 !== 0) {
    aligned = new Uint8Array(bytes.length);
    aligned.set(bytes);
  }
  const dv = new DataView(aligned.buffer, aligned.byteOffset, aligned.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('minor planet data: not an MPCB container');
  if (dv.getUint8(4) !== PACKED_VERSION) throw new Error(`minor planet data: unsupported version ${dv.getUint8(4)}`);
  const n = dv.getUint32(8, true), m = dv.getUint32(12, true);
  const head = 16 + ((m + 3) & ~3);
  if (bytes.length !== head + planeBytes(n)) throw new Error(`minor planet data: ${bytes.length} bytes for ${n} orbits (expected ${head + planeBytes(n)})`);
  const meta = JSON.parse(String.fromCharCode(...aligned.subarray(16, 16 + m))) as PackedMeta;
  const base = aligned.byteOffset + head;
  const buffer = aligned.buffer as ArrayBuffer;
  const u16 = (off: number) => new Uint16Array(buffer, off, n);
  const pad16 = 2 * ((n + 1) & ~1);
  let off = base;
  const desig = new Uint32Array(buffer, off, n); off += 4 * n;
  const h = u16(off); off += pad16;
  const epoch = u16(off); off += pad16;
  const m0 = new Uint32Array(buffer, off, n); off += 4 * n;
  const argp = new Uint32Array(buffer, off, n); off += 4 * n;
  const node = new Uint32Array(buffer, off, n); off += 4 * n;
  const inc = new Uint32Array(buffer, off, n); off += 4 * n;
  const ecc = new Uint32Array(buffer, off, n); off += 4 * n;
  const a = new Float32Array(buffer, off, n);
  return { count: n, meta, desig, h, epoch, m0, argp, node, inc, ecc, a };
}

/** Orbits [start, end) of a container as a container of their own (the chunks the server sends). The meta is kept, `parsed` is the chunk's count. */
export function sliceOrbits(u: UnpackedOrbits, start: number, end: number): Uint8Array {
  const from = Math.max(0, Math.min(start, u.count)), to = Math.max(from, Math.min(end, u.count));
  const out = writeContainer(to - from, { ...u.meta, parsed: to - from });
  const v = readContainer(out);
  v.desig.set(u.desig.subarray(from, to)); v.h.set(u.h.subarray(from, to)); v.epoch.set(u.epoch.subarray(from, to));
  v.m0.set(u.m0.subarray(from, to)); v.argp.set(u.argp.subarray(from, to)); v.node.set(u.node.subarray(from, to));
  v.inc.set(u.inc.subarray(from, to)); v.ecc.set(u.ecc.subarray(from, to)); v.a.set(u.a.subarray(from, to));
  return out;
}

/** One orbit of a container: `MpcOrbit` without the packed text, with the readable designation. */
export type UnpackedOrbit = Omit<MpcOrbit, 'packed'> & { designation: string };

/** Orbit `i` of a container, back in degrees and AU (the quantisation of the layout applies: angles 8e-8 degrees, H 0.01, a 6e-8 relative). */
export function orbitAt(u: UnpackedOrbits, i: number): UnpackedOrbit {
  return {
    designation: designationText(u.desig[i]),
    h: hFromCode(u.h[i]),
    epochMs: EPOCH0_MS + u.epoch[i] * 86_400_000,
    m0Deg: angleFromCode(u.m0[i]),
    argpDeg: angleFromCode(u.argp[i]),
    nodeDeg: angleFromCode(u.node[i]),
    incDeg: angleFromCode(u.inc[i]),
    e: u.ecc[i] / TWO32,
    aAu: u.a[i],
  };
}

export const epochMsOfDay = (day: number): number => EPOCH0_MS + day * 86_400_000;
export const ECC_SCALE = TWO32;
export const ANGLE_SCALE = 360 / TWO32;

/** Line-by-line reading statistics (`readMpcorb`). */
export interface MpcReadStats {
  /** lines read (every line, header and blanks included) */
  lines: number;
  /** orbits stored */
  parsed: number;
  /** non-blank lines after the header that were not understood (or whose epoch is out of range) */
  skipped: number;
  /** the first few skipped lines, trimmed, for the log */
  samples: string[];
}

/**
 * Feed text lines (any async or sync iterable, e.g. a readline interface over the gunzipped file) into `builder`. Lines before
 * the first orbit or the `-----` rule under the column heads are the file header; blank lines (the section separators) are
 * not counted; any other line that does not parse is counted in `skipped` and left out.
 */
export async function readMpcorb(lines: AsyncIterable<string> | Iterable<string>, builder: OrbitBuilder): Promise<MpcReadStats> {
  const stats: MpcReadStats = { lines: 0, parsed: 0, skipped: 0, samples: [] };
  let header = true;
  for await (const raw of lines as AsyncIterable<string>) {
    stats.lines++;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    if (header && /^-{20,}\s*$/.test(line)) {
      header = false;
      continue;
    }
    const o = parseMpcorbLine(line);
    if (o) header = false;
    else if (header) continue;
    if (o && builder.add(o)) stats.parsed++;
    else {
      stats.skipped++;
      if (stats.samples.length < 3) stats.samples.push(line.slice(0, 60));
    }
  }
  return stats;
}

/** JSON text with every non-ASCII character written as a \\u escape, so one character is one byte. */
function asciiJson(v: unknown): string {
  let r = '';
  for (const ch of JSON.stringify(v)) {
    const c = ch.charCodeAt(0);
    r += c < 128 ? ch : '\\u' + c.toString(16).padStart(4, '0');
  }
  return r;
}
