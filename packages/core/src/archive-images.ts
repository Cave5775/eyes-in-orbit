import { HUBBLE_NORAD } from './observatory';

/**
 * Images of a solar-system body taken BY one observatory, streamed from its public archive (`api.archiveImages`).
 * The shapes are shared by the engine (apps/web/src/engine/archive.ts) and the web card of the Sky view.
 */

export interface ArchiveImage {
  /** archive observation id (MAST `obs_id`) */
  id: string;
  /**
   * the preview jpeg the archive offers (MAST has one size only, "Preview-Full": measured 19 to 102 kB per file, about 2000 px,
   * and no thumbnail product), loaded by the browser straight from the archive; the card limits how many it shows at once
   */
  thumbUrl: string;
  /** the same file (the lightbox) */
  fullUrl: string;
  /** the observation in the archive's own search page */
  pageUrl: string;
  /** observation start, ms since the epoch */
  tMs: number;
  instrument: string;
  /** filter or filters, as the archive names them (empty when it gives none) */
  filters: string;
  /** exposure time, seconds */
  exposureS?: number;
  /** proposal / programme id */
  program?: string;
}

/** `ok` images found; `none` the archive answered with nothing; `unsupported` no preview service for this observatory or body; `error` the archive or the request limiter refused. */
export type ArchiveImagesStatus = 'ok' | 'none' | 'unsupported' | 'error';

export interface ArchiveRef {
  id: string;
  /** shown to the user */
  label: string;
  /** the archive's own front page */
  url: string;
}

export interface ArchiveImagesResult {
  observatoryId: string;
  observatory: string;
  /** body registry id, as asked (`JUPITER`) */
  body: string;
  /** the archive asked, or null when none is mapped to this observatory */
  archive: ArchiveRef | null;
  status: ArchiveImagesStatus;
  /** why there is nothing (every status but `ok`) */
  reason?: string;
  /** newest first, at most `ARCHIVE_IMAGE_CAP` */
  images: ArchiveImage[];
  /** rows the archive reported for the body in the time window, before de-duplication and the cap */
  total?: number;
  fetchedAt: number;
  fromCache?: boolean;
  /** `error` caused by a request limit: when asking is possible again */
  limitedUntil?: number;
}

export const ARCHIVE_IMAGE_CAP = 24;

export interface ArchiveSpec extends ArchiveRef {
  /** a MAST collection that answers; absent = no preview service we can use */
  mastCollection?: 'HST' | 'JWST';
  /** why there is no service (when `mastCollection` is absent) */
  unsupported?: string;
}

/** The archives, by id. Only MAST (Hubble, JWST) has a preview service that was checked; the others say why not. */
export const ARCHIVES: Record<string, ArchiveSpec> = {
  'mast-hst': { id: 'mast-hst', label: 'MAST (Hubble)', url: 'https://mast.stsci.edu/', mastCollection: 'HST' },
  'mast-jwst': { id: 'mast-jwst', label: 'MAST (JWST)', url: 'https://mast.stsci.edu/', mastCollection: 'JWST' },
  chandra: {
    id: 'chandra', label: 'Chandra Data Archive', url: 'https://cxc.harvard.edu/cda/',
    unsupported: 'The Chandra Data Archive has a catalogue service (TAP) but no public preview-image service for solar-system targets.',
  },
  tess: {
    id: 'tess', label: 'MAST (TESS)', url: 'https://mast.stsci.edu/',
    unsupported: 'TESS observes fixed star fields; the planets are not targets of its archive.',
  },
  eso: {
    id: 'eso', label: 'ESO Science Archive', url: 'https://archive.eso.org/',
    unsupported: 'The ESO archive lists solar-system observations (for example HARPS spectra) but offers no public preview images for them.',
  },
};

/**
 * The archive of an observatory entity, by a stable attribute rather than its name or id: the CelesTrak NORAD number (Hubble),
 * the DSN spacecraft code (JWST, Chandra, TESS) or the `observatory` alias of a ground site (Paranal). Null for any other,
 * which the endpoint then answers as unsupported.
 */
export function archiveOf(rec: { aliases?: Record<string, string> }): ArchiveSpec | null {
  const a = rec.aliases ?? {};
  if (a.norad !== undefined && Number(a.norad) === HUBBLE_NORAD) return ARCHIVES['mast-hst'];
  const dsn: Record<string, string> = { JWST: 'mast-jwst', CHDR: 'chandra', TESS: 'tess' };
  if (a.dsn !== undefined && dsn[a.dsn]) return ARCHIVES[dsn[a.dsn]];
  if (a.observatory === 'paranal') return ARCHIVES.eso;
  return null;
}

/**
 * The target name MAST files a body under (CAOM `target_name`, matched case-insensitively), or null when the archives hold no
 * images of it as a target. Checked against MAST on 2026-11-16: HST and JWST have JUPITER, SATURN, MARS, URANUS, NEPTUNE, PLUTO,
 * CERES, ERIS, HAUMEA and MAKEMAKE as targets; there are no image products for the Sun, Moon, Venus or Mercury.
 */
export function mastTargetOf(bodyId: string): string | null {
  const id = bodyId.toUpperCase();
  return ['JUPITER', 'SATURN', 'MARS', 'URANUS', 'NEPTUNE', 'PLUTO', 'CERES', 'ERIS', 'HAUMEA', 'MAKEMAKE'].includes(id) ? id : null;
}

// ---- MAST (Hubble, JWST): response rows and their selection. Pure, so the web mock builds its answer from a real response the same way.

const MAST_DOWNLOAD = 'https://mast.stsci.edu/api/v0.1/Download/file';
const MAST_PORTAL = 'https://mast.stsci.edu/portal/Mashup/Clients/Mast/Portal.html';
/** At most this many previews of one observing day (a visit has dozens of exposures of one scene). */
export const PER_DAY_CAP = 6;

const MJD_UNIX_EPOCH = 40587;
export const mjdToMs = (mjd: number): number => Math.round((mjd - MJD_UNIX_EPOCH) * 86_400_000);
export const msToMjd = (ms: number): number => ms / 86_400_000 + MJD_UNIX_EPOCH;

export interface MastRow extends ArchiveImage {
  /** CAOM calibration level (3 = combined product, 2 = calibrated, 1 = raw) */
  calib: number;
}

/** A preview jpeg of a `mast:` URI (the CAOM `jpegURL`); an image needs no CORS, so the browser loads it from MAST itself. */
export const previewUrl = (jpegUri: string): string => `${MAST_DOWNLOAD}?uri=${encodeURIComponent(jpegUri)}`;
export const portalUrl = (obsId: string): string => `${MAST_PORTAL}?searchQuery=${encodeURIComponent(obsId)}`;

export interface MastParsed {
  rows: MastRow[];
  /** rows the archive matched (can exceed the page) */
  total: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Rows with a preview jpeg from a `Mast.Caom.Filtered` JSON answer. Throws on a wrong shape or a status other than COMPLETE. */
export function parseMast(text: string): MastParsed {
  let j: { status?: unknown; msg?: unknown; data?: unknown; paging?: { rowsFiltered?: unknown } };
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('MAST returned unexpected non-JSON text');
  }
  if (!j || j.status !== 'COMPLETE' || !Array.isArray(j.data)) throw new Error(`MAST returned unexpected status ${String(j?.status)}${j?.msg ? `: ${String(j.msg)}` : ''}`);
  const rows: MastRow[] = [];
  for (const d of j.data as Record<string, unknown>[]) {
    const jpeg = str(d.jpegURL), obsId = str(d.obs_id);
    if (!jpeg || !obsId || typeof d.t_min !== 'number' || !Number.isFinite(d.t_min)) continue;
    const program = d.proposal_id === undefined || d.proposal_id === null ? '' : String(d.proposal_id).trim();
    rows.push({
      id: obsId, thumbUrl: previewUrl(jpeg), fullUrl: previewUrl(jpeg), pageUrl: portalUrl(obsId), tMs: mjdToMs(d.t_min),
      instrument: str(d.instrument_name), filters: str(d.filters),
      ...(typeof d.t_exptime === 'number' ? { exposureS: d.t_exptime } : {}),
      ...(program ? { program } : {}),
      calib: typeof d.calib_level === 'number' ? d.calib_level : 0,
    });
  }
  const total = typeof j.paging?.rowsFiltered === 'number' ? j.paging.rowsFiltered : j.data.length;
  return { rows, total };
}

const day = (tMs: number): number => Math.floor(tMs / 86_400_000);

/**
 * Newest first, near-identical exposures removed: one row per day, instrument and filter (the same scene exposed again; the
 * higher calibration level wins, then the longer exposure), then at most `PER_DAY_CAP` of one day, at most `cap` rows.
 */
export function selectImages(rows: readonly MastRow[], cap = ARCHIVE_IMAGE_CAP): ArchiveImage[] {
  const best = new Map<string, MastRow>();
  for (const r of rows) {
    const k = `${day(r.tMs)}|${r.instrument}|${r.filters}`;
    const b = best.get(k);
    if (!b || r.calib > b.calib || (r.calib === b.calib && (r.exposureS ?? 0) > (b.exposureS ?? 0))) best.set(k, r);
  }
  const sorted = [...best.values()].sort((a, b) => b.tMs - a.tMs || (a.id < b.id ? -1 : 1));
  const perDay = new Map<number, number>();
  const out: ArchiveImage[] = [];
  for (const r of sorted) {
    const d = day(r.tMs), n = perDay.get(d) ?? 0;
    if (n >= PER_DAY_CAP) continue;
    perDay.set(d, n + 1);
    const { calib: _calib, ...img } = r;
    out.push(img);
    if (out.length >= cap) break;
  }
  return out;
}

const cap1 = (s: string): string => s.charAt(0) + s.slice(1).toLowerCase();

/** How far back observations are asked for, years. */
export const WINDOW_YEARS = 4;

/**
 * What an ask resolves to before any request: a final answer (`unsupported`: no archive or no preview service for this
 * observatory; `none`: the archive holds no images of this body as a target), or the MAST query to run.
 */
export function planArchiveAsk(
  obs: { id: string; name: string; aliases?: Record<string, string> }, bodyId: string, now: number,
): { done: ArchiveImagesResult } | { ask: { spec: ArchiveSpec; collection: 'HST' | 'JWST'; target: string; base: ArchiveImagesResult } } {
  const body = bodyId.toUpperCase();
  const base: ArchiveImagesResult = { observatoryId: obs.id, observatory: obs.name, body, archive: null, status: 'unsupported', images: [], fetchedAt: now };
  const spec = archiveOf(obs);
  if (!spec) return { done: { ...base, reason: `No public image archive is mapped to ${obs.name}.` } };
  const archive = { id: spec.id, label: spec.label, url: spec.url };
  if (!spec.mastCollection) return { done: { ...base, archive, reason: spec.unsupported ?? `${spec.label} has no public preview service here.` } };
  const target = mastTargetOf(body);
  if (!target) return { done: { ...base, archive, status: 'none', reason: `${spec.label} holds no images of ${cap1(body)} as an observation target.` } };
  return { ask: { spec, collection: spec.mastCollection, target, base: { ...base, archive } } };
}

/** The answer for the rows MAST returned: `ok` with the selection, or `none` with a reason. */
export function archiveAnswer(base: ArchiveImagesResult, spec: ArchiveSpec, target: string, parsed: MastParsed): ArchiveImagesResult {
  const images = selectImages(parsed.rows);
  const out = { ...base, images, total: parsed.total };
  return images.length
    ? { ...out, status: 'ok' }
    : { ...out, status: 'none', reason: `${spec.label} has no preview images of ${cap1(target)} from the last ${WINDOW_YEARS} years.` };
}
