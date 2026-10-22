import type { Connector } from '../connector';

/** Documented placeholders: they appear in /api/health with status `stub` and never run. */

export const spacetrack: Connector = {
  id: 'spacetrack',
  stub: (c) =>
    `Not implemented. Would pull SATCAT/decay/GP data from space-track.org (30 req/min, free account). Needs SPACETRACK_USER and SPACETRACK_PASSWORD${c.spacetrackUser ? ' (user is set)' : ' (not set)'}.`,
};

export const satnogs: Connector = {
  id: 'satnogs',
  stub: (c) =>
    `Not implemented. Would read observations/telemetry from network.satnogs.org and db.satnogs.org (open read access); SATNOGS_TOKEN ${c.satnogsToken ? 'is set' : 'is optional and not set'}.`,
};

export const notam: Connector = {
  id: 'notam',
  stub: () =>
    'Not implemented. FAA NOTAM and NGA NAVAREA launch hazard areas have no stable open JSON API; a parser for published hazard polygons is needed.',
};

export const webcastOcr: Connector = {
  id: 'webcast-ocr',
  stub: (c) =>
    `Not implemented. Would OCR the T+/velocity/altitude overlay of a launch webcast (ffmpeg + tesseract) and feed reconstructDownrange(). WEBCAST_URL ${c.webcastUrl ? 'is set' : 'is not set'}.`,
};
