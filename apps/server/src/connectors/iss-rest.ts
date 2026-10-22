import type { IssFix } from '@eio/core';
import type { Connector } from '../connector';

const URL = 'https://api.wheretheiss.at/v1/satellites/25544';

export function normalizeIssFix(raw: Record<string, any>): IssFix {
  const fix: IssFix = {
    t: Number(raw.timestamp) * 1000,
    latitude: Number(raw.latitude),
    longitude: Number(raw.longitude),
    altitudeKm: Number(raw.altitude),
    velocityKmh: Number(raw.velocity),
    visibility: String(raw.visibility),
    footprintKm: Number(raw.footprint),
  };
  if (![fix.t, fix.latitude, fix.longitude, fix.altitudeKm].every(Number.isFinite)) {
    throw new Error(`unexpected wheretheiss.at response: ${JSON.stringify(raw).slice(0, 120)}`);
  }
  return fix;
}

/** 1 Hz ISS fix, polled only while at least one client has subscribed to topic `iss`. */
export const issRest: Connector = {
  id: 'iss-rest',
  intervalMs: 1000,
  topic: 'iss',
  async run(ctx) {
    ctx.hub.setIssFix(normalizeIssFix(JSON.parse(await ctx.http.text(URL))));
  },
};
