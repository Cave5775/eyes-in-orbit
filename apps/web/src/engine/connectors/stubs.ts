import type { Connector } from '../scheduler';

/** Documented placeholders: they appear in the feed list with status `stub` and never run. */

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
    `Not implemented (no OCR here). Measured ascent telemetry is not available (the ingest route was dropped); only the modeled ascent is shown. WEBCAST_URL ${c.webcastUrl ? 'is set' : 'is not set'}.`,
};
