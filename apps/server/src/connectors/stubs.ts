import type { Connector } from '../connector';

/** Documented placeholders: they appear in /api/health with status `stub` and never run. */

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
    `Not implemented (no OCR here). A script that reads the T+/velocity/altitude overlay of a webcast (ffmpeg + tesseract) can already feed the server: POST [{tSec, altKm, speedKmS}] to /api/telemetry/<launch id> (localhost only, see README "Ascent telemetry"); rows go through reconstructDownrange() and replace the modeled path. WEBCAST_URL ${c.webcastUrl ? 'is set' : 'is not set'}.`,
};
