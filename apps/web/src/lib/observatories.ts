import { observatoryOf, type EntityRecord, type ObservatoryMeta } from '@eio/core';
import { zenithRaDec } from './sky-frame';

/**
 * HiPS surveys the Sky view offers. Ids and `urls` come from each survey's CDS MocServer record
 * (https://alasky.cds.unistra.fr/MocServer/query?ID=<id>&get=record&fmt=json, fields hips_service_url, _1, _2..., read
 * 2026-11-13), CDS first, then the mirrors that answered. lib/hips-mirror.ts picks the first that works.
 * Pan-STARRS and ROSAT are only on CDS (alasky, alaskybis), so they are unavailable while CDS is.
 */
export interface Survey { id: string; label: string; band: string; urls: readonly string[] }
export const SURVEYS: readonly Survey[] = [
  {
    id: 'CDS/P/DSS2/color', label: 'DSS2 colour', band: 'optical',
    urls: ['https://alasky.cds.unistra.fr/DSS/DSSColor', 'https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color', 'https://skies.esac.esa.int/DSSColor', 'https://casda.csiro.au/hips/DSS2/color'],
  },
  {
    id: 'CDS/P/2MASS/color', label: '2MASS', band: 'near-infrared',
    urls: ['https://alasky.cds.unistra.fr/2MASS/Color', 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color'],
  },
  {
    id: 'CDS/P/PanSTARRS/DR1/color-z-zg-g', label: 'Pan-STARRS DR1', band: 'optical (north of -30 deg)',
    urls: ['https://alasky.cds.unistra.fr/Pan-STARRS/DR1/color-z-zg-g', 'https://alaskybis.cds.unistra.fr/Pan-STARRS/DR1/color-z-zg-g'],
  },
  {
    id: 'CDS/P/Fermi/color', label: 'Fermi', band: 'gamma-ray',
    urls: ['https://alasky.cds.unistra.fr/Fermi/Color', 'https://skies.esac.esa.int/FermiColor'],
  },
  {
    id: 'CDS/P/RASS', label: 'ROSAT all-sky', band: 'x-ray',
    urls: ['https://alasky.cds.unistra.fr/RASS', 'https://alaskybis.cds.unistra.fr/RASS'],
  },
];

export const surveyOf = (id: string): Survey | undefined => SURVEYS.find((s) => s.id === id);

export const surveyLabel = (id: string): string => SURVEYS.find((s) => s.id === id)?.label ?? id;

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
      id: r.id, name: r.name, meta, imagery: meta.survey !== null,
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

/** Where the view is centred: a ground site's zenith at `tMs`, a space telescope's default target (said so in the note). */
export function skyTarget(row: Pick<ObservatoryRow, 'meta' | 'latDeg' | 'lonDeg'>, tMs: number): SkyTarget {
  if (row.meta.site === 'ground' && row.latDeg !== undefined && row.lonDeg !== undefined) {
    const z = zenithRaDec(tMs, row.latDeg, row.lonDeg);
    return { ...z, tracksZenith: true, note: `Centred on the zenith (RA ${(z.raDeg / 15).toFixed(2)} h, Dec ${z.decDeg.toFixed(1)}°); follows sim time` };
  }
  return {
    raDeg: DEFAULT_SPACE_TARGET.raDeg, decDeg: DEFAULT_SPACE_TARGET.decDeg, tracksZenith: false,
    note: `Pointing data is not available: starting at ${DEFAULT_SPACE_TARGET.name}, drag to look elsewhere`,
  };
}
