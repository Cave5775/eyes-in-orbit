import { DEFAULT_HIPS_SURVEY, observatoryOf, type EntityRecord, type ObservatoryMeta } from '@eio/core';
import { precessToJ2000, zenithRaDec } from './sky-frame';

/**
 * HiPS surveys the Sky view offers. Ids, `skyFraction` (the registry's `moc_sky_fraction`) and `urls` come from each survey's CDS
 * MocServer record (https://alasky.cds.unistra.fr/MocServer/query?ID=<id>&get=record&fmt=json, fields hips_service_url, _1, _2...,
 * read 2026-11-13 and 2026-11-15). `urls` are tried in order by lib/hips-mirror.ts (the first whose `properties` file answers wins),
 * the servers that answered on 2026-11-15/16 first and CDS (alasky, alaskybis; their tile paths answered 404 or timed out then)
 * and ESA (skies.esac.esa.int, esdchips.esac.esa.int; timed out) after them, so they work again when those come back. CORS was
 * checked with an Origin header on 2026-11-16 for the CXC, PADC, MAST S3, IRSA and CASDA hosts (open). The ROE/WFAU VHS K survey
 * (http://surveys.roe.ac.uk, no CORS headers, http) is left out: a browser page cannot use it.
 * Several surveys exist only on CDS or ESA (Hubble, JWST, TESS, Rubin, Euclid, DES, DESI, SkyMapper, ZTF, HSC, KiDS, VIKING,
 * CFHTLS, Fermi, ROSAT): they are unavailable while those are, and the Sky view then falls back (lib/survey-fallback.ts).
 */
export interface Survey {
  id: string;
  label: string;
  band: string;
  /** fraction of the whole sky the survey covers, 0..1 (a pointed survey such as Hubble is mostly empty) */
  skyFraction: number;
  urls: readonly string[];
}
const ALASKY = 'https://alasky.cds.unistra.fr';
const ALASKYBIS = 'https://alaskybis.cds.unistra.fr';
const cds = (path: string): string[] => [`${ALASKY}/${path}`, `${ALASKYBIS}/${path}`];
export const SURVEYS: readonly Survey[] = [
  {
    id: 'CDS/P/DSS2/color', label: 'DSS2 colour', band: 'optical', skyFraction: 1,
    urls: ['https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color', 'https://casda.csiro.au/hips/DSS2/color', `${ALASKY}/DSS/DSSColor`, 'https://skies.esac.esa.int/DSSColor'],
  },
  {
    id: 'CDS/P/2MASS/color', label: '2MASS', band: 'near-infrared', skyFraction: 1,
    urls: ['https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color', `${ALASKY}/2MASS/Color`],
  },
  {
    id: 'CDS/P/PanSTARRS/DR1/color-i-r-g', label: 'Pan-STARRS DR1', band: 'optical (north of -30 deg)', skyFraction: 0.764,
    urls: ['https://stpubdata.s3.us-east-1.amazonaws.com/mast/skybackgrounds/PanSTARRS', ...cds('Pan-STARRS/DR1/color-i-r-g')],
  },
  {
    id: 'CDS/P/SDSS9/color', label: 'SDSS DR9', band: 'optical', skyFraction: 0.356,
    urls: ['https://irsa.ipac.caltech.edu/data/hips/CDS/SDSS/DR9/color', `${ALASKY}/SDSS/DR9/color`],
  },
  {
    id: 'CDS/P/NVSS', label: 'NVSS 1.4 GHz', band: 'radio', skyFraction: 0.824,
    urls: ['https://casda.csiro.au/hips/NVSS'],
  },
  {
    id: 'VOXASTRO/P/UKIDSS/JHK/color', label: 'UKIDSS JHK (UKIRT)', band: 'near-infrared', skyFraction: 0.105,
    urls: ['https://padc-web.obspm.fr/planeto/hips/VOXASTRO_P_UKIDSS_COLOR'],
  },
  {
    id: 'CDS/P/HSC/DR2/wide/color-i-r-g', label: 'Subaru HSC DR2 wide', band: 'optical', skyFraction: 0.0177,
    urls: cds('HSC/DR2/CDS_P_HSC_DR2_wide_color-i-r-g'),
  },
  {
    id: 'CDS/P/CFHTLS/W/Color/ugi', label: 'CFHTLS Wide ugi', band: 'optical', skyFraction: 0.0037,
    urls: cds('CFHTLS-T0007b/Wide/RGB-UGIm'),
  },
  {
    id: 'VOXASTRO/P/VHS/JKs/color', label: 'VISTA VHS J+Ks', band: 'near-infrared', skyFraction: 0.481,
    urls: ['https://padc-web.obspm.fr/planeto/hips/VOXASTRO_P_VHS_COLOR'],
  },
  {
    id: 'CDS/P/VISTA/VIKING/K', label: 'VISTA VIKING K', band: 'near-infrared', skyFraction: 0.0249,
    urls: cds('VISTA/VIKING/VISTA-VIKING-K'),
  },
  {
    id: 'CDS/P/KiDS/DR5/color-gri', label: 'KiDS DR5 gri (VST)', band: 'optical', skyFraction: 0.0326,
    urls: cds('KiDS/CDS_P_KiDS_DR5_color-gri'),
  },
  {
    id: 'CDS/P/Rubin/FirstLook', label: 'Rubin First Look', band: 'optical', skyFraction: 0.00071,
    urls: cds('Rubin/CDS_P_Rubin_FirstLook'),
  },
  {
    id: 'CDS/P/DESI-Legacy-Surveys/DR10/color', label: 'DESI Legacy Surveys DR10', band: 'optical', skyFraction: 0.673,
    urls: cds('DESI-legacy-surveys/DR10/CDS_P_DESI-Legacy-Surveys_DR10_color'),
  },
  {
    id: 'CDS/P/DES-DR2/ColorIRG', label: 'Dark Energy Survey DR2', band: 'optical', skyFraction: 0.126,
    urls: cds('DES/DR2/CDS_P_DES-DR2_ColorIRG'),
  },
  {
    id: 'CDS/P/Skymapper/DR4/color', label: 'SkyMapper DR4', band: 'optical', skyFraction: 0.633,
    urls: cds('Skymapper/DR4/CDS_P_Skymapper_DR4_color'),
  },
  {
    id: 'CDS/P/ZTF/DR7/color', label: 'ZTF DR7', band: 'optical', skyFraction: 0.733,
    urls: cds('ZTF/DR7/CDS_P_ZTF_DR7_color'),
  },
  {
    id: 'CDS/P/HST/color', label: 'Hubble colour', band: 'optical', skyFraction: 0.0018,
    urls: cds('HST-hips/color'),
  },
  {
    id: 'ESAVO/P/HST/WFC3', label: 'Hubble WFC3', band: 'optical', skyFraction: 0.0002,
    urls: ['https://skies.esac.esa.int/HST/WFC3', ...cds('ESAC/ESAVO_P_HST_WFC3')],
  },
  {
    id: 'ESAVO/P/JWST/NIRCam_Imaging', label: 'JWST NIRCam', band: 'near-infrared', skyFraction: 0.000034,
    urls: ['https://skies.esac.esa.int/JWST/NIRCam_Imaging', ...cds('ESAC/ESAVO_P_JWST_NIRCam_Imaging')],
  },
  {
    id: 'CDS/P/JWST/F200W', label: 'JWST F200W', band: 'near-infrared', skyFraction: 0.00001,
    urls: cds('JWST/CDS_P_JWST_F200W'),
  },
  {
    id: 'CDS/P/TESS/2yr', label: 'TESS 2 years', band: 'optical', skyFraction: 0.7607,
    urls: cds('TESS/CDS_P_TESS_2yr'),
  },
  {
    id: 'cxc.harvard.edu/P/cda/hips/allsky/rgb', label: 'Chandra (CXC)', band: 'x-ray', skyFraction: 0.0219,
    urls: ['https://cdaftp.cfa.harvard.edu/cxc-hips', ...cds('CHANDRA/cxc.harvard.edu_P_cda_hips_allsky_rgb')],
  },
  {
    id: 'CDS/P/Euclid/Q1/color', label: 'Euclid Q1', band: 'optical / near-infrared', skyFraction: 0.0016,
    urls: cds('Euclid/Q1/CDS_P_Euclid_Q1_color'),
  },
  {
    id: 'xcatdb/P/XMM/PN/color', label: 'XMM-Newton EPIC-pn', band: 'x-ray', skyFraction: 0.092,
    urls: ['https://xcatdb.unistra.fr/PNColor', `${ALASKY}/SSC/xcatdb_P_XMM_PN_color`],
  },
  {
    id: 'ESDC/P/XMM/EPIC-RGB', label: 'XMM-Newton EPIC RGB', band: 'x-ray', skyFraction: 0.092,
    urls: ['https://esdchips.esac.esa.int/XMM-Newton/EPIC-RGB'],
  },
  {
    id: 'CDS/P/Fermi/color', label: 'Fermi', band: 'gamma-ray', skyFraction: 1,
    urls: ['https://skies.esac.esa.int/FermiColor', `${ALASKY}/Fermi/Color`],
  },
  {
    id: 'CDS/P/RASS', label: 'ROSAT all-sky', band: 'x-ray', skyFraction: 1,
    urls: cds('RASS'),
  },
];

export const surveyOf = (id: string): Survey | undefined => SURVEYS.find((s) => s.id === id);

/** All-sky surveys the Sky view falls back to when none of an observatory's own surveys has a working server (each is hosted by a non-CDS server too). */
export const FALLBACK_SURVEYS: readonly string[] = [DEFAULT_HIPS_SURVEY, 'CDS/P/2MASS/color', 'CDS/P/PanSTARRS/DR1/color-i-r-g'];

/** A survey covering less than this fraction of the sky is "pointed": most of the sky is empty in it. */
export const POINTED_SKY_FRACTION = 0.5;

/** The percentage of the sky a survey covers, as short text (`0.18%`, `10%`, `0.0034%`). */
export function fmtSkyPercent(fraction: number): string {
  const p = fraction * 100;
  return `${p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toPrecision(2)}%`;
}

/** The note for a survey that covers little of the sky; null for a (nearly) all-sky one. */
export function coverageNote(s: Survey | undefined): string | null {
  if (!s || s.skyFraction >= POINTED_SKY_FRACTION) return null;
  return `${s.label} covers ${fmtSkyPercent(s.skyFraction)} of the sky; outside its footprint the view is empty (black).`;
}

/** The surveys to try for an observatory: its own list (ids unknown to SURVEYS dropped), then the fallbacks, no repeats. */
export function surveyPlan(own: readonly string[]): { own: string[]; fallbacks: string[] } {
  const known = [...new Set(own)].filter((id) => !!surveyOf(id));
  return { own: known, fallbacks: FALLBACK_SURVEYS.filter((id) => !known.includes(id)) };
}

/** Default centre for a space telescope (no pointing data): the Galactic centre, Sgr A* (J2000 17h45m40.04s -29d00m28.1s). */
export const DEFAULT_SPACE_TARGET = { raDeg: 266.41684, decDeg: -29.00781, name: 'the Galactic centre' } as const;

export interface ObservatoryRow {
  id: string;
  name: string;
  meta: ObservatoryMeta;
  /** `34.0 N 116.9 W` for a ground site, `In space` otherwise */
  place: string;
  /** the Sky view has imagery for it */
  imagery: boolean;
  latDeg?: number;
  lonDeg?: number;
}

export function fmtLatLon(latDeg: number, lonDeg: number): string {
  return `${Math.abs(latDeg).toFixed(2)}°${latDeg < 0 ? 'S' : 'N'} ${Math.abs(lonDeg).toFixed(2)}°${lonDeg < 0 ? 'W' : 'E'}`;
}

/** The observatories among `records`: space telescopes first, then ground sites, each by name. */
export function observatoryRows(records: Iterable<EntityRecord>): ObservatoryRow[] {
  const rows: ObservatoryRow[] = [];
  for (const r of records) {
    const meta = observatoryOf(r);
    if (!meta) continue;
    const p = r.provider;
    const geo = p && p.type === 'geodetic' ? { latDeg: p.latDeg, lonDeg: p.lonDeg } : undefined;
    rows.push({
      id: r.id, name: r.name, meta, imagery: surveyPlan(meta.surveys).own.length > 0,
      place: geo ? fmtLatLon(geo.latDeg, geo.lonDeg) : 'In space', ...geo,
    });
  }
  return rows.sort((a, b) => (a.meta.site === b.meta.site ? a.name.localeCompare(b.name) : a.meta.site === 'space' ? -1 : 1));
}

export interface SkyTarget {
  raDeg: number;
  decDeg: number;
  /** one line for the window: what the view is centred on */
  note: string;
  /** the view follows the sky's rotation (ground zenith) */
  tracksZenith: boolean;
}

/** Where the view is centred, J2000 RA/Dec (what Aladin and the HiPS surveys use): a ground site's zenith at `tMs` (of date, precessed to J2000), a space telescope's default target (said so in the note). */
export function skyTarget(row: Pick<ObservatoryRow, 'meta' | 'latDeg' | 'lonDeg'>, tMs: number): SkyTarget {
  if (row.meta.site === 'ground' && row.latDeg !== undefined && row.lonDeg !== undefined) {
    const of = zenithRaDec(tMs, row.latDeg, row.lonDeg);
    const z = precessToJ2000(of.raDeg, of.decDeg, tMs);
    return { ...z, tracksZenith: true, note: `Centred on the zenith (RA ${(z.raDeg / 15).toFixed(2)} h, Dec ${z.decDeg.toFixed(1)}°); follows sim time` };
  }
  return {
    raDeg: DEFAULT_SPACE_TARGET.raDeg, decDeg: DEFAULT_SPACE_TARGET.decDeg, tracksZenith: false,
    note: `Pointing data is not available: starting at ${DEFAULT_SPACE_TARGET.name}, drag to look elsewhere`,
  };
}
