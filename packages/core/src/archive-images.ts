import { HUBBLE_NORAD } from './observatory';

/**
 * Images of a solar-system body taken BY one observatory, streamed from its public archive (`GET /api/archive-images`).
 * The shapes are shared by the server connector (apps/server/src/archive-images.ts) and the web card of the Sky view.
 */

export interface ArchiveImage {
  /** archive observation id (MAST `obs_id`) */
  id: string;
  /** a preview jpeg, small enough for a thumbnail grid; the browser loads it straight from the archive */
  thumbUrl: string;
  /** the same preview at the size the archive keeps (the lightbox) */
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
