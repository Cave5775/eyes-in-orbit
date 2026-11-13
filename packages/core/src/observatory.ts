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
  /** default HiPS survey id for the Sky view; null when it has no sky imagery to show (DSN dishes) */
  survey: string | null;
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

/** The entity attrs of an observatory (merge into `attrs`). */
export function observatoryAttrs(meta: ObservatoryMeta): Record<string, string> {
  return {
    [OBSERVATORY_ATTR]: meta.site,
    [OBSERVATORY_BANDS_ATTR]: meta.bands.join(', '),
    [OBSERVATORY_SURVEY_ATTR]: meta.survey ?? '',
  };
}

/** The observatory description of an entity, or null when it is not one (also for a malformed `observatory` value). */
export function observatoryOf(rec: { attrs?: Record<string, string | number | boolean | null> }): ObservatoryMeta | null {
  const a = rec.attrs;
  if (!a) return null;
  const site = a[OBSERVATORY_ATTR];
  if (site !== 'ground' && site !== 'space') return null;
  const bands = a[OBSERVATORY_BANDS_ATTR];
  const survey = a[OBSERVATORY_SURVEY_ATTR];
  return {
    site,
    bands: typeof bands === 'string' ? bands.split(',').map((b) => b.trim()).filter(Boolean) : [],
    survey: typeof survey === 'string' && survey ? survey : null,
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
 * Optical ground observatories. Coordinates are the site positions to about 0.001 deg (100 m), enough for a zenith.
 * - Paranal (ESO VLT): the ESO page https://www.eso.org/public/teles-instr/paranal-observatory/ gives 2635 m above sea level;
 *   its Google Earth link carries -24.62722, -70.40389.
 * - Rubin (Cerro Pachon): 30 deg 14' 41" S, 70 deg 44' 58" W, 2672.75 m (Wikipedia "Vera C. Rubin Observatory"; the operator
 *   page https://rubinobservatory.org/about/summit-facility returned no text to the fetch tool).
 * - Mauna Kea summit: 19.8207 N, 155.4681 W, 4.205 km. NOT checked against a page in this run (the one fetch was refused);
 *   from the Maunakea Observatories summit coordinates as commonly published (https://www.maunakeaobservatories.org/).
 */
export const GROUND_OBSERVATORIES: GroundObservatory[] = [
  {
    id: 'obs-maunakea', name: 'Mauna Kea Observatories', latDeg: 19.8207, lonDeg: -155.4681, altKm: 4.205,
    source: 'https://www.maunakeaobservatories.org/', meta: { site: 'ground', bands: ['optical', 'infrared', 'submillimetre'], survey: 'CDS/P/DSS2/color' },
  },
  {
    id: 'obs-paranal', name: 'Paranal Observatory (VLT)', latDeg: -24.62722, lonDeg: -70.40389, altKm: 2.635,
    source: 'https://www.eso.org/public/teles-instr/paranal-observatory/', meta: { site: 'ground', bands: ['optical', 'infrared'], survey: 'CDS/P/DSS2/color' },
  },
  {
    id: 'obs-rubin', name: 'Vera C. Rubin Observatory', latDeg: -30.24464, lonDeg: -70.74942, altKm: 2.67275,
    source: 'https://en.wikipedia.org/wiki/Vera_C._Rubin_Observatory', meta: { site: 'ground', bands: ['optical'], survey: 'CDS/P/DSS2/color' },
  },
];
