/**
 * What each data stream provides, for the Data streams popup. Keyed by connector id: the server's ids plus the ids the
 * mock health list uses (see mock/generators.ts mockHealth). Static text; the live state comes from `/api/health`.
 */
export interface FeedInfo {
  name: string;
  /** one or two sentences: what the app gets from this stream */
  provides: string;
  /** who publishes it */
  source: string;
  /** public page of the source, or null for built-in data */
  link: string | null;
}

const celestrak: FeedInfo = {
  name: 'CelesTrak',
  provides: 'Orbital element sets (OMM) for satellites, stations, navigation constellations and debris groups. Positions are propagated from them with SGP4.',
  source: 'CelesTrak (Dr T.S. Kelso)',
  link: 'https://celestrak.org/',
};
const launchlibrary: FeedInfo = {
  name: 'Launch Library 2',
  provides: 'Upcoming launches with vehicle, pad, mission, window and webcast links, shown in the launch board.',
  source: 'The Space Devs',
  link: 'https://thespacedevs.com/llapi',
};
const snapi: FeedInfo = {
  name: 'Spaceflight News',
  provides: 'Recent spaceflight headlines for the news ticker and the News tab of an object.',
  source: 'Spaceflight News API',
  link: 'https://www.spaceflightnewsapi.net/',
};
const dsn: FeedInfo = {
  name: 'Deep Space Network',
  provides: 'Which Deep Space Network dishes are talking to which spacecraft, with range, light time and downlink rate.',
  source: 'NASA JPL, DSN Now',
  link: 'https://eyes.nasa.gov/dsn/dsn.html',
};

export const FEED_CATALOG: Record<string, FeedInfo> = {
  celestrak,
  launchlibrary,
  snapi,
  dsn,
  horizons: {
    name: 'JPL Horizons (spacecraft)',
    provides: 'Ephemerides of deep-space probes, sampled and interpolated so they can be drawn at any time.',
    source: 'NASA JPL Solar System Dynamics',
    link: 'https://ssd.jpl.nasa.gov/horizons/',
  },
  'horizons-bodies': {
    name: 'JPL Horizons (bodies)',
    provides: 'Ephemerides of the Sun, planets, moons and other solar-system bodies.',
    source: 'NASA JPL Solar System Dynamics',
    link: 'https://ssd.jpl.nasa.gov/horizons/',
  },
  'iss-live': {
    name: 'ISS live telemetry',
    provides: 'Live ISS values: solar array and radiator joint angles, attitude quaternion and state vector.',
    source: 'ISS Live (NASA, via Lightstreamer)',
    link: 'https://iss-mimic.github.io/Mimic/',
  },
  'iss-rest': {
    name: 'ISS position',
    provides: 'Current ISS latitude, longitude, altitude and velocity, used to check the propagated orbit.',
    source: 'Where the ISS at',
    link: 'https://wheretheiss.at/',
  },
  flightclub: {
    name: 'Flight Club',
    provides: 'Simulated ascent trajectories for upcoming launches.',
    source: 'Flight Club',
    link: 'https://flightclub.io/',
  },
  spacetrack: {
    name: 'Space-Track',
    provides: 'Large element-set groups such as Starlink, from the US Space Force catalog. Needs a free account.',
    source: 'Space-Track.org (US Space Force)',
    link: 'https://www.space-track.org/',
  },
  wikipedia: {
    name: 'Wikipedia and Wikidata',
    provides: 'The About tab of an object: a short article summary with a picture, found through Wikidata by catalogue number. Asked only when you open the About tab, cached for 30 days.',
    source: 'Wikimedia (Wikidata, Wikipedia)',
    link: 'https://www.wikidata.org/',
  },
  discos: {
    name: 'ESA DISCOS',
    provides: 'Mass, size, shape, operator and mission facts for catalogued objects, in the About tab. Needs a free ESA DISCOS token; asked only when you open the About tab.',
    source: 'ESA Space Debris Office (DISCOS)',
    link: 'https://discosweb.esoc.esa.int/',
  },
  bodies: {
    name: 'Solar-system bodies',
    provides: 'The built-in catalog of the Sun, planets and moons: sizes, rotation and appearance. No network needed.',
    source: 'Built in (IAU / NASA data)',
    link: null,
  },
  satnogs: {
    name: 'SatNOGS',
    provides: 'Planned: amateur ground-station observations and satellite telemetry. Not implemented yet.',
    source: 'SatNOGS network',
    link: 'https://satnogs.org/',
  },
  notam: {
    name: 'Launch hazard areas',
    provides: 'Planned: NOTAM and NAVAREA hazard zones around launches. Not implemented yet.',
    source: 'FAA / NGA',
    link: null,
  },
  'webcast-ocr': {
    name: 'Webcast telemetry reader',
    provides: 'Planned: ascent telemetry read from a launch webcast overlay. Not implemented; a script can post rows to the server instead.',
    source: 'Local script',
    link: null,
  },
  // the mock health list uses these ids
  'launch-library-2': launchlibrary,
  'spaceflight-news': snapi,
  'dsn-now': dsn,
  'dsn-xml': dsn,
};

/** Catalog entry for a connector id; unknown ids get a generic one so the popup never shows an empty pane. */
export function feedInfo(id: string): FeedInfo {
  return FEED_CATALOG[id] ?? { name: id, provides: 'No description for this connector yet.', source: 'unknown', link: null };
}

/** Ids whose popup section shows the DSN link table. */
export const DSN_FEEDS: ReadonlySet<string> = new Set(['dsn', 'dsn-now', 'dsn-xml']);

/**
 * The server connector whose credentials (`GET /api/credentials`, `CredentialInfo.connector`) a feed's popup section edits,
 * or null when the feed needs none. Covers the mock id of Launch Library 2.
 */
const CREDENTIAL_CONNECTOR: Record<string, string> = {
  spacetrack: 'spacetrack',
  launchlibrary: 'launchlibrary',
  'launch-library-2': 'launchlibrary',
  discos: 'discos',
};
export function credentialConnector(feedId: string): string | null {
  return CREDENTIAL_CONNECTOR[feedId] ?? null;
}
