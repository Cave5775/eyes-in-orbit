/**
 * Observatories are ordinary entities (ground stations, probes, satellites) that carry an `observatory` attribute, not a
 * separate EntityKind: their kind decides how they move and are drawn, the attribute only says "this one looks at the sky".
 * The attributes are plain strings so they travel in `EntityRecord.attrs` (REST, WS, the detail panel) unchanged.
 */

export type ObservatorySite = 'ground' | 'space';

export interface ObservatoryMeta {
  site: ObservatorySite;
  /** wavebands it observes in, free text words (`optical`, `infrared`, `x-ray`, `radio`) */
  bands: string[];
  /** HiPS survey ids of its own instruments for the Sky view, in order of preference (the first is the default); empty when it has no sky imagery (DSN dishes) */
  surveys: string[];
}

export const OBSERVATORY_ATTR = 'observatory';
export const OBSERVATORY_BANDS_ATTR = 'observatoryBands';
export const OBSERVATORY_SURVEY_ATTR = 'observatorySurvey';
/** The group of the observatories that are not already in another connector's group. */
export const OBSERVATORY_GROUP = 'observatory';
/** Default HiPS survey: DSS2 colour (CDS HiPS id, listed by the CDS MocServer). */
export const DEFAULT_HIPS_SURVEY = 'CDS/P/DSS2/color';
/** Hubble Space Telescope in the CelesTrak catalogue (international designator 1990-037B). */
export const HUBBLE_NORAD = 20580;
/** XMM-Newton (COSPAR 1999-066A) and Fermi (2008-029A), SATCAT numbers from the Wikipedia infoboxes read 2026-11-16 (CelesTrak itself did not answer). */
export const XMM_NORAD = 25989;
export const FERMI_NORAD = 33053;

/** The entity attrs of an observatory (merge into `attrs`). */
export function observatoryAttrs(meta: ObservatoryMeta): Record<string, string> {
  return {
    [OBSERVATORY_ATTR]: meta.site,
    [OBSERVATORY_BANDS_ATTR]: meta.bands.join(', '),
    // comma separated (HiPS ids contain no comma); one id is the older single-survey form
    [OBSERVATORY_SURVEY_ATTR]: meta.surveys.join(','),
  };
}

/** The observatory description of an entity, or null when it is not one (also for a malformed `observatory` value). */
export function observatoryOf(rec: { attrs?: Record<string, string | number | boolean | null> }): ObservatoryMeta | null {
  const a = rec.attrs;
  if (!a) return null;
  const site = a[OBSERVATORY_ATTR];
  if (site !== 'ground' && site !== 'space') return null;
  const bands = a[OBSERVATORY_BANDS_ATTR];
  const surveys = a[OBSERVATORY_SURVEY_ATTR];
  return {
    site,
    bands: typeof bands === 'string' ? bands.split(',').map((b) => b.trim()).filter(Boolean) : [],
    surveys: typeof surveys === 'string' ? surveys.split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
}

export interface GroundObservatory {
  id: string;
  name: string;
  latDeg: number;
  /** east positive */
  lonDeg: number;
  altKm: number;
  /** where the numbers come from */
  source: string;
  meta: ObservatoryMeta;
}

/**
 * Ground observatories (optical, infrared and the VLA radio array). Coordinates are the site positions to about 0.001 deg
 * (100 m), enough for a zenith. Each site lists the HiPS surveys of its own instruments (ids as in apps/web/src/lib/observatories.ts
 * SURVEYS), the first being the default.
 * - Paranal (ESO VLT): the ESO page https://www.eso.org/public/teles-instr/paranal-observatory/ gives 2635 m above sea level;
 *   its Google Earth link carries -24.62722, -70.40389. VISTA (VHS, VIKING) and the VST (KiDS) are on this mountain.
 * - Rubin (Cerro Pachon): 30 deg 14' 41" S, 70 deg 44' 58" W, 2672.75 m (Wikipedia "Vera C. Rubin Observatory"; the operator
 *   page https://rubinobservatory.org/about/summit-facility returned no text to the fetch tool).
 * - Mauna Kea: 19 deg 49' 20" N, 155 deg 28' 30" W (19.8222, -155.4749), altitude 4,205 m (infobox of
 *   https://en.wikipedia.org/wiki/Maunakea_Observatories). UKIRT (UKIDSS), Subaru (HSC) and CFHT (CFHTLS) are on it.
 * The sites below were read from the Wikipedia infobox of each page on 2026-11-16 (coordinates in decimal degrees as the
 * infobox gives them, east positive here, altitude in metres):
 * - Haleakala (Pan-STARRS1): 20.7083 N, 156.2571 W, 3,052 m (https://en.wikipedia.org/wiki/Haleakal%C4%81_Observatory).
 * - Apache Point (SDSS 2.5 m): 32.78028 N, 105.82028 W, 2,788 m (https://en.wikipedia.org/wiki/Apache_Point_Observatory).
 * - VLA (NRAO): 34.0787492 N, 107.6177275 W, 2,124 m (https://en.wikipedia.org/wiki/Very_Large_Array).
 * - Kitt Peak (Mayall, DESI): 31.9583 N, 111.5967 W, 2,096 m (https://en.wikipedia.org/wiki/Kitt_Peak_National_Observatory).
 * - Cerro Tololo (Blanco, DECam, DES): 30.16917 S, 70.80639 W, 2,207 m
 *   (https://en.wikipedia.org/wiki/Cerro_Tololo_Inter-American_Observatory). It is 15 km from Rubin.
 * - Siding Spring (SkyMapper): 31.27333 S, 149.06444 E, 1,165 m (https://en.wikipedia.org/wiki/Siding_Spring_Observatory).
 * - Palomar (ZTF on the 48-inch Oschin; the POSS/DSS plates were made there too): 33.3564 N, 116.865 W, 1,712 m
 *   (https://en.wikipedia.org/wiki/Palomar_Observatory).
 */
export const GROUND_OBSERVATORIES: GroundObservatory[] = [
  {
    id: 'obs-maunakea', name: 'Mauna Kea Observatories', latDeg: 19.8222, lonDeg: -155.4749, altKm: 4.205,
    source: 'https://en.wikipedia.org/wiki/Maunakea_Observatories',
    meta: { site: 'ground', bands: ['optical', 'infrared', 'submillimetre'], surveys: ['VOXASTRO/P/UKIDSS/JHK/color', 'CDS/P/HSC/DR2/wide/color-i-r-g', 'CDS/P/CFHTLS/W/Color/ugi'] },
  },
  {
    id: 'obs-paranal', name: 'Paranal Observatory (VLT)', latDeg: -24.62722, lonDeg: -70.40389, altKm: 2.635,
    source: 'https://www.eso.org/public/teles-instr/paranal-observatory/',
    meta: { site: 'ground', bands: ['optical', 'infrared'], surveys: ['VOXASTRO/P/VHS/JKs/color', 'CDS/P/VISTA/VIKING/K', 'CDS/P/KiDS/DR5/color-gri'] },
  },
  {
    id: 'obs-rubin', name: 'Vera C. Rubin Observatory', latDeg: -30.24464, lonDeg: -70.74942, altKm: 2.67275,
    source: 'https://en.wikipedia.org/wiki/Vera_C._Rubin_Observatory', meta: { site: 'ground', bands: ['optical'], surveys: ['CDS/P/Rubin/FirstLook'] },
  },
  {
    id: 'obs-haleakala', name: 'Haleakala Observatory (Pan-STARRS)', latDeg: 20.7083, lonDeg: -156.2571, altKm: 3.052,
    source: 'https://en.wikipedia.org/wiki/Haleakal%C4%81_Observatory', meta: { site: 'ground', bands: ['optical'], surveys: ['CDS/P/PanSTARRS/DR1/color-i-r-g'] },
  },
  {
    id: 'obs-apachepoint', name: 'Apache Point Observatory (SDSS)', latDeg: 32.78028, lonDeg: -105.82028, altKm: 2.788,
    source: 'https://en.wikipedia.org/wiki/Apache_Point_Observatory', meta: { site: 'ground', bands: ['optical'], surveys: ['CDS/P/SDSS9/color'] },
  },
  {
    id: 'obs-vla', name: 'Very Large Array (NRAO)', latDeg: 34.0787492, lonDeg: -107.6177275, altKm: 2.124,
    source: 'https://en.wikipedia.org/wiki/Very_Large_Array', meta: { site: 'ground', bands: ['radio'], surveys: ['CDS/P/NVSS'] },
  },
  {
    id: 'obs-kittpeak', name: 'Kitt Peak National Observatory (Mayall, DESI)', latDeg: 31.9583, lonDeg: -111.5967, altKm: 2.096,
    source: 'https://en.wikipedia.org/wiki/Kitt_Peak_National_Observatory', meta: { site: 'ground', bands: ['optical'], surveys: ['CDS/P/DESI-Legacy-Surveys/DR10/color'] },
  },
  {
    id: 'obs-ctio', name: 'Cerro Tololo Inter-American Observatory (DECam)', latDeg: -30.16917, lonDeg: -70.80639, altKm: 2.207,
    source: 'https://en.wikipedia.org/wiki/Cerro_Tololo_Inter-American_Observatory', meta: { site: 'ground', bands: ['optical'], surveys: ['CDS/P/DES-DR2/ColorIRG'] },
  },
  {
    id: 'obs-sidingspring', name: 'Siding Spring Observatory (SkyMapper)', latDeg: -31.27333, lonDeg: 149.06444, altKm: 1.165,
    source: 'https://en.wikipedia.org/wiki/Siding_Spring_Observatory', meta: { site: 'ground', bands: ['optical'], surveys: ['CDS/P/Skymapper/DR4/color'] },
  },
  {
    id: 'obs-palomar', name: 'Palomar Observatory (ZTF, DSS)', latDeg: 33.3564, lonDeg: -116.865, altKm: 1.712,
    source: 'https://en.wikipedia.org/wiki/Palomar_Observatory', meta: { site: 'ground', bands: ['optical'], surveys: ['CDS/P/ZTF/DR7/color', 'CDS/P/DSS2/color'] },
  },
];

/**
 * The space observatories (Hubble, JWST, TESS, Chandra, Euclid, XMM-Newton, Fermi): wavebands and the HiPS surveys of their own
 * data (ids as in apps/web/src/lib/observatories.ts SURVEYS). Shared by the server connectors and the mock data. Decommissioned
 * missions (Spitzer, WISE, Herschel, Planck, GALEX, Kepler, Gaia), eROSITA (in safe mode since 2022) and Swift (reboost
 * cancelled 2026-08) are not listed.
 */
export const SPACE_OBSERVATORY_META: Record<'hubble' | 'jwst' | 'tess' | 'chandra' | 'euclid' | 'xmm' | 'fermi', ObservatoryMeta> = {
  hubble: { site: 'space', bands: ['optical', 'ultraviolet', 'near-infrared'], surveys: ['CDS/P/HST/color', 'ESAVO/P/HST/WFC3'] },
  jwst: { site: 'space', bands: ['infrared'], surveys: ['ESAVO/P/JWST/NIRCam_Imaging', 'CDS/P/JWST/F200W'] },
  tess: { site: 'space', bands: ['optical', 'near-infrared'], surveys: ['CDS/P/TESS/2yr'] },
  chandra: { site: 'space', bands: ['x-ray'], surveys: ['cxc.harvard.edu/P/cda/hips/allsky/rgb'] },
  euclid: { site: 'space', bands: ['optical', 'near-infrared'], surveys: ['CDS/P/Euclid/Q1/color'] },
  xmm: { site: 'space', bands: ['x-ray'], surveys: ['xcatdb/P/XMM/PN/color', 'ESDC/P/XMM/EPIC-RGB'] },
  fermi: { site: 'space', bands: ['gamma-ray'], surveys: ['CDS/P/Fermi/color'] },
};
