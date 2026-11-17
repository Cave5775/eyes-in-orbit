import type { EntityRecord } from './types';

/**
 * Landers, rovers and aircraft on bodies other than the Earth: ONE cited table, turned into entities by `surfaceSiteRecords`
 * (the server's `surface-sites` connector and the web mock both call it, so they cannot drift). A site is an ordinary entity:
 * a `geodetic` provider on its body (the body-fixed frame `<BODY>:fixed`, the IAU rotation of the registry), `bodyId` = the
 * body, so it is listed under the body in the tree, follows the scope rules and can be selected and framed.
 *
 * Coordinates are planetocentric latitude and EAST longitude on the sphere of the registry radius (`surfaceShape`), height 0:
 * the scene draws the Moon and Mars as bare spheres, so a point on the sphere is a point on the drawn surface. The published
 * elevation (relative to the lunar GLD100 / the Martian geoid) is not applied; it is kept in `attrs.elevationM` where known.
 * Longitudes are stored as the source prints them (east, 0 to 360 for LROC and ODE).
 *
 * Never invent a number: every row names where its coordinates were read (`source`, read 2026-11-17). Rows whose source is a
 * secondary summary say so. No Venus site is listed: the only coordinates found (Venera, Vega) carry no citation.
 */
export interface SurfaceSite {
  /** entity id; stable (`site-...`, or `dsn-MSL` / `dsn-M20` for the two rovers that are also DSN targets) */
  id: string;
  name: string;
  bodyId: string;
  kind: 'lander' | 'rover' | 'drone';
  /** planetocentric latitude, degrees, north positive */
  latDeg: number;
  /** east longitude, degrees, as published */
  lonDeg: number;
  /** is it working (a rover that still drives, a lander that still transmits); everything else is historic */
  status: 'active' | 'inactive';
  /** year of the landing */
  year: number;
  agency: string;
  /** where the coordinates come from */
  source: string;
  /** Elevation relative to the source's datum, metres (not applied to the position) */
  elevationM?: number;
  /** DSN spacecraft code (`MSL`, `M20`): the entity also carries the DSN link attributes */
  dsn?: string;
  /** JPL Horizons target id of a spacecraft that is also a DSN target */
  horizons?: string;
  /** NASA MMGIS waypoint layer whose latest waypoint replaces the coordinates while the feed is up (`mmgis-rovers` connector) */
  live?: 'M20' | 'MSL';
  /** the coordinates are only the landing site, shown until the live feed answers */
  placeholder?: boolean;
}

export const SURFACE_GROUP = 'surface';

const LROC = 'LROC Science Operations Team, Wagner et al. 2016, "Coordinates of Lunar Anthropogenic Targets" (Icarus 273, doi:10.1016/j.icarus.2016.05.011; lroc.im-ldi.com/data/support/downloads/2016_LROC_Coordinates_of_Human_Features.pdf), mean observed latitude and longitude, mean Earth/polar axis system';
const ODE = 'PDS Geosciences Orbital Data Explorer, "Supported Existing and Proposed Landing Sites" (ode.rsl.wustl.edu/mars/pagehelp/Content/Missions_Instruments/Landing_Sites.htm)';
const MMGIS_M20 = 'NASA MMGIS M20_waypoints.json (mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json), first waypoint (sol 13, site 3)';
const MMGIS_MSL = 'NASA MMGIS MSL_waypoints.json (mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json), first waypoint (sol 3, site 2)';

type Row = Omit<SurfaceSite, 'id' | 'bodyId' | 'source'> & { key: string; source?: string };
const moon = (r: Row): SurfaceSite => ({ ...r, id: `site-${r.key}`, bodyId: 'MOON', source: r.source ?? LROC });
const mars = (r: Row): SurfaceSite => ({ ...r, id: `site-${r.key}`, bodyId: 'MARS', source: r.source ?? ODE });

export const SURFACE_SITES: readonly SurfaceSite[] = [
  // ---- Moon. LROC 2016 table (lander positions); the newer landings: the LROC or NASA page quoted in `source`
  moon({ key: 'apollo-11', name: 'Apollo 11 Eagle (LM-5)', kind: 'lander', latDeg: 0.67416, lonDeg: 23.47314, elevationM: -1926, status: 'inactive', year: 1969, agency: 'NASA' }),
  moon({ key: 'apollo-12', name: 'Apollo 12 Intrepid (LM-6)', kind: 'lander', latDeg: -3.0128, lonDeg: 336.5781, elevationM: -1422, status: 'inactive', year: 1969, agency: 'NASA' }),
  moon({ key: 'apollo-14', name: 'Apollo 14 Antares (LM-8)', kind: 'lander', latDeg: -3.64589, lonDeg: 342.52806, elevationM: -1062, status: 'inactive', year: 1971, agency: 'NASA' }),
  moon({ key: 'apollo-15', name: 'Apollo 15 Falcon (LM-10)', kind: 'lander', latDeg: 26.13239, lonDeg: 3.6333, elevationM: -1931, status: 'inactive', year: 1971, agency: 'NASA' }),
  moon({ key: 'apollo-16', name: 'Apollo 16 Orion (LM-11)', kind: 'lander', latDeg: -8.9734, lonDeg: 15.50118, status: 'inactive', year: 1972, agency: 'NASA' }),
  moon({ key: 'apollo-17', name: 'Apollo 17 Challenger (LM-12)', kind: 'lander', latDeg: 20.1911, lonDeg: 30.7723, elevationM: -2626, status: 'inactive', year: 1972, agency: 'NASA' }),
  moon({ key: 'surveyor-1', name: 'Surveyor 1', kind: 'lander', latDeg: -2.4745, lonDeg: 316.6602, elevationM: -1889, status: 'inactive', year: 1966, agency: 'NASA' }),
  moon({ key: 'surveyor-3', name: 'Surveyor 3', kind: 'lander', latDeg: -3.0162, lonDeg: 336.582, elevationM: -1433, status: 'inactive', year: 1967, agency: 'NASA' }),
  moon({ key: 'surveyor-5', name: 'Surveyor 5', kind: 'lander', latDeg: 1.4551, lonDeg: 23.1943, elevationM: -2052, status: 'inactive', year: 1967, agency: 'NASA' }),
  moon({ key: 'surveyor-6', name: 'Surveyor 6', kind: 'lander', latDeg: 0.4742, lonDeg: 358.5725, elevationM: -757, status: 'inactive', year: 1967, agency: 'NASA' }),
  moon({ key: 'surveyor-7', name: 'Surveyor 7', kind: 'lander', latDeg: -40.9812, lonDeg: 348.4873, elevationM: 81, status: 'inactive', year: 1968, agency: 'NASA' }),
  moon({ key: 'luna-16', name: 'Luna 16', kind: 'lander', latDeg: -0.5137, lonDeg: 56.3638, elevationM: -2452, status: 'inactive', year: 1970, agency: 'USSR' }),
  moon({ key: 'luna-17', name: 'Luna 17', kind: 'lander', latDeg: 38.23764, lonDeg: 324.99837, elevationM: -2471, status: 'inactive', year: 1970, agency: 'USSR' }),
  moon({ key: 'lunokhod-1', name: 'Lunokhod 1', kind: 'rover', latDeg: 38.315, lonDeg: 324.9919, elevationM: -2471, status: 'inactive', year: 1970, agency: 'USSR' }),
  moon({ key: 'luna-20', name: 'Luna 20', kind: 'lander', latDeg: 3.7863, lonDeg: 56.6242, elevationM: -1780, status: 'inactive', year: 1972, agency: 'USSR' }),
  moon({ key: 'luna-21', name: 'Luna 21', kind: 'lander', latDeg: 25.9994, lonDeg: 30.4076, elevationM: -2680, status: 'inactive', year: 1973, agency: 'USSR' }),
  moon({ key: 'lunokhod-2', name: 'Lunokhod 2', kind: 'rover', latDeg: 25.8323, lonDeg: 30.9222, elevationM: -2761, status: 'inactive', year: 1973, agency: 'USSR' }),
  moon({ key: 'luna-23', name: 'Luna 23', kind: 'lander', latDeg: 12.6667, lonDeg: 62.1511, elevationM: -3668, status: 'inactive', year: 1974, agency: 'USSR' }),
  moon({ key: 'luna-24', name: 'Luna 24', kind: 'lander', latDeg: 12.7142, lonDeg: 62.2129, elevationM: -3670, status: 'inactive', year: 1976, agency: 'USSR' }),
  // Chang'e 3 / 4: LROC table and LROC DTM; the working status is the Wikipedia "List of artificial objects on the Moon" (read 2026-11-17), not confirmed by CNSA
  moon({ key: 'change-3', name: "Chang'e 3 lander", kind: 'lander', latDeg: 44.1214, lonDeg: 340.4883, elevationM: -2630, status: 'active', year: 2013, agency: 'CNSA' }),
  moon({ key: 'yutu', name: "Yutu (Chang'e 3 rover)", kind: 'rover', latDeg: 44.1208, lonDeg: 340.4878, elevationM: -2630, status: 'inactive', year: 2013, agency: 'CNSA' }),
  moon({
    key: 'change-4', name: "Chang'e 4 lander", kind: 'lander', latDeg: -45.4561, lonDeg: 177.5885, elevationM: -5927, status: 'active', year: 2019, agency: 'CNSA',
    source: "LROC stereo DTM of the Chang'e 4 site, lroc.im-ldi.com/posts/1087 (via a web search summary; the page itself was not opened)",
  }),
  moon({
    key: 'change-5', name: "Chang'e 5 lander", kind: 'lander', latDeg: 43.0576, lonDeg: 308.0839, elevationM: -2570, status: 'inactive', year: 2020, agency: 'CNSA',
    source: "LROC \"First Look: Chang'e 5\", lroc.im-ldi.com/posts/1172.2020 (via a web search summary: 43.0576 N, 308.0839 E, about 20 m)",
  }),
  moon({
    key: 'change-6', name: "Chang'e 6 lander", kind: 'lander', latDeg: -41.6385, lonDeg: 206.0148, elevationM: -5256, status: 'inactive', year: 2024, agency: 'CNSA',
    source: "LROC \"First Look: Chang'e 6\", lroc.im-ldi.com/images/1374 (published 2024-06-14: 41.6385 S, 206.0148 E, +-30 m)",
  }),
  moon({
    key: 'chandrayaan-3', name: 'Chandrayaan-3 Vikram', kind: 'lander', latDeg: -69.3741, lonDeg: 32.32, elevationM: 532, status: 'inactive', year: 2023, agency: 'ISRO',
    source: 'LROC "Chandrayaan-3 Landing Site", lroc.im-ldi.com/images/1314 (published 2023-09-05: 69.3741 S, 32.32 E, 532 m)',
  }),
  moon({
    key: 'slim', name: 'SLIM', kind: 'lander', latDeg: -13.316, lonDeg: 25.251, elevationM: -912, status: 'inactive', year: 2024, agency: 'JAXA',
    source: 'LROC "JAXA SLIM Landing", lroc.im-ldi.com/images/1358 (published 2024-01-26: 13.3160 S, 25.2510 E, -912 m)',
  }),
  moon({
    key: 'im-1', name: 'IM-1 Odysseus', kind: 'lander', latDeg: -80.13, lonDeg: 1.44, elevationM: 2579, status: 'inactive', year: 2024, agency: 'Intuitive Machines',
    source: 'NASA, "NASA\'s LRO Images Intuitive Machines\' Odysseus Lander" (nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/, 2024-02-26: 80.13 S, 1.44 E, 2,579 m)',
  }),

  // ---- Mars. Landers: ODE (the published solutions of the landing teams, planetocentric, east longitude)
  mars({ key: 'viking-1', name: 'Viking 1 lander', kind: 'lander', latDeg: 22.269, lonDeg: 312.049, status: 'inactive', year: 1976, agency: 'NASA' }),
  mars({ key: 'viking-2', name: 'Viking 2 lander', kind: 'lander', latDeg: 47.668, lonDeg: 134.28, status: 'inactive', year: 1976, agency: 'NASA' }),
  mars({ key: 'pathfinder', name: 'Mars Pathfinder (Sagan Memorial Station)', kind: 'lander', latDeg: 19.095, lonDeg: 326.747, status: 'inactive', year: 1997, agency: 'NASA' }),
  mars({ key: 'spirit', name: 'Spirit (MER-A)', kind: 'rover', latDeg: -14.571892, lonDeg: 175.47848, status: 'inactive', year: 2004, agency: 'NASA', source: `${ODE}, MER Spirit Doppler/radiometric solution (Arvidson et al. 2004)` }),
  mars({ key: 'opportunity', name: 'Opportunity (MER-B)', kind: 'rover', latDeg: -1.9483, lonDeg: 354.47417, status: 'inactive', year: 2004, agency: 'NASA', source: `${ODE}, MER Opportunity Doppler/radiometric solution (Arvidson et al. 2004)` }),
  mars({ key: 'phoenix', name: 'Phoenix', kind: 'lander', latDeg: 68.22, lonDeg: 234.25, status: 'inactive', year: 2008, agency: 'NASA' }),
  mars({
    key: 'insight', name: 'InSight', kind: 'lander', latDeg: 4.502, lonDeg: 135.623, status: 'inactive', year: 2018, agency: 'NASA',
    source: 'Golombek et al., LPSC 2019, InSight landing site (4.502 N, 135.623 E; via a web search summary, the abstract was not opened)',
  }),
  mars({
    key: 'zhurong', name: 'Zhurong (Tianwen-1)', kind: 'rover', latDeg: 25.066, lonDeg: 109.925, status: 'inactive', year: 2021, agency: 'CNSA',
    source: 'Wikipedia "Tianwen-1" infobox (25.066 N, 109.925 E), agrees with Remote Sensing 17(14):2400 (25.067 N, 109.926 E); secondary, no agency page found',
  }),
  // the two NASA rovers: also DSN targets (`dsn-MSL`, `dsn-M20`); the live position is the latest waypoint of the MMGIS layer
  {
    id: 'dsn-MSL', name: 'Mars Science Laboratory Curiosity', bodyId: 'MARS', kind: 'rover', latDeg: -4.589467, lonDeg: 137.441633, status: 'active', year: 2012, agency: 'NASA',
    source: MMGIS_MSL, dsn: 'MSL', horizons: '-76', live: 'MSL', placeholder: true,
  },
  {
    id: 'dsn-M20', name: 'Mars 2020 Perseverance', bodyId: 'MARS', kind: 'rover', latDeg: 18.44462715, lonDeg: 77.45088572, status: 'active', year: 2021, agency: 'NASA',
    source: MMGIS_M20, dsn: 'M20', horizons: '-168', live: 'M20', placeholder: true,
  },
  {
    id: 'site-ingenuity', name: 'Ingenuity (final position)', bodyId: 'MARS', kind: 'drone', latDeg: 18.49726866, lonDeg: 77.32253449, elevationM: -2398.77, status: 'inactive', year: 2021, agency: 'NASA',
    source: 'NASA MMGIS m20_heli_waypoints.json (mars.nasa.gov/mmgis-maps/M20/Layers/json/m20_heli_waypoints.json), flight 72 (2024-01-18, sol 1036), the last waypoint of the file',
  },

  // ---- Titan
  {
    id: 'site-huygens', name: 'Huygens', bodyId: 'TITAN', kind: 'lander', latDeg: -10.573, lonDeg: 167.665, status: 'inactive', year: 2005, agency: 'ESA',
    source: 'Kazeminejad, Atkinson and Lebreton 2011, Adv. Space Res. 47(9):1622 (10.573 S, 192.335 W = 167.665 E), as printed on Wikipedia "Huygens (spacecraft)"; secondary, assumes the registry pole of Titan',
  },
];

/** The surface site of an entity id, or undefined. */
export const surfaceSiteOf = (id: string): SurfaceSite | undefined => SURFACE_SITES.find((s) => s.id === id);

/** Longitude in [-180, 180). */
export const wrapLonDeg = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;

/** The `attrs` of a site's entity: what the detail panel shows. */
export function surfaceSiteAttrs(s: SurfaceSite): NonNullable<EntityRecord['attrs']> {
  const a: NonNullable<EntityRecord['attrs']> = {
    site: 'surface', status: s.status, landedYear: s.year, agency: s.agency,
    latDeg: s.latDeg, lonEastDeg: Number(wrapLonDeg(s.lonDeg).toFixed(6)), coordinateSource: s.source,
  };
  if (s.elevationM !== undefined) a.elevationM = s.elevationM;
  if (s.placeholder) a.positionNote = 'Landing site, until the live waypoint feed answers';
  return a;
}

/**
 * The entity of a site: a geodetic point on its body (planetocentric, height 0; the Earth is not handled here, see `observatories`),
 * kind `lander`, `rover` or `drone`. The two rovers that are DSN targets keep `group: 'dsn'` and their DSN and Horizons aliases.
 */
export function surfaceSiteRecord(s: SurfaceSite, updatedAt = 0): EntityRecord {
  const rover = s.kind === 'rover', drone = s.kind === 'drone';
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    bodyId: s.bodyId,
    aliases: { ...(s.dsn ? { dsn: s.dsn } : {}), ...(s.horizons ? { horizons: s.horizons } : {}) },
    group: s.dsn ? 'dsn' : SURFACE_GROUP,
    provider: { type: 'geodetic', bodyId: s.bodyId, latDeg: s.latDeg, lonDeg: s.lonDeg, altKm: 0 },
    links: { newsQuery: s.name },
    render: { colorKey: drone ? 'aircraft' : rover ? 'rover' : 'probe', glyph: drone ? 'triangle' : rover ? 'diamond' : 'square', label: s.status === 'active' },
    attrs: surfaceSiteAttrs(s),
    updatedAt,
  };
}

/** Every site as an entity. */
export const surfaceSiteRecords = (updatedAt = 0): EntityRecord[] => SURFACE_SITES.map((s) => surfaceSiteRecord(s, updatedAt));
