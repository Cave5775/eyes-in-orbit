import type { Omm } from '@eio/core';
import { clearBackoff, isBackedOff, readBackoff, recordFailure } from '../backoff';
import type { Connector } from '../connector';
import { USER_AGENT } from '../http';
import { isFresh } from '../store';
import { parseOmmJson, satelliteEntity } from './celestrak';

const BASE = 'https://www.space-track.org';
/** Current Starlink GP elements: epoch within 30 days, not decayed. `%3E` is `>`, `~~` is SQL LIKE. */
export const STARLINK_QUERY =
  '/basicspacedata/query/class/gp/OBJECT_NAME/~~STARLINK/DECAY_DATE/null-val/EPOCH/%3Enow-30/orderby/NORAD_CAT_ID/format/json';
/** Space-Track asks for GP data at most about once an hour; every 3 h keeps well inside that and matches CelesTrak. */
const TTL_MS = 3 * 3600_000;
const CACHE_KEY = 'spacetrack:starlink';

/** `name=value` pairs of the Set-Cookie headers, joined into one Cookie header. */
const cookieHeader = (res: Response): string =>
  res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

/**
 * Log in, run one query, log out. Space-Track answers a bad login with HTTP 200 and `{"Login":"Failed"}`, so the body
 * is checked as well as the status. Never logs or throws the password.
 */
export async function fetchSpaceTrackGp(
  fetchImpl: typeof fetch, user: string, password: string, query = STARLINK_QUERY,
): Promise<Omm[]> {
  const headers = { 'user-agent': USER_AGENT };
  const login = await fetchImpl(`${BASE}/ajaxauth/login`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identity: user, password }),
    signal: AbortSignal.timeout(20_000),
  });
  const loginBody = await login.text();
  if (!login.ok) throw new Error(`HTTP ${login.status} from Space-Track login`);
  if (/"Login"\s*:\s*"Failed"/i.test(loginBody)) throw new Error('Space-Track login failed (check SPACETRACK_USER / SPACETRACK_PASSWORD)');
  const cookie = cookieHeader(login);
  if (!cookie) throw new Error('Space-Track login returned no session cookie');
  try {
    const res = await fetchImpl(`${BASE}${query}`, { headers: { ...headers, cookie }, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} for Space-Track query: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    return parseOmmJson(text);
  } finally {
    await fetchImpl(`${BASE}/ajaxauth/logout`, { headers: { ...headers, cookie }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }
}

/**
 * Space-Track as a second source for the Starlink shell, independent of CelesTrak's per-IP download limit. Needs a free
 * account (`SPACETRACK_USER`, `SPACETRACK_PASSWORD`). Entities share the `sat-<NORAD>` ids with the `celestrak` connector,
 * so whichever ran last supplies the element set; both sources are the same 18th SDS catalog.
 */
export const spacetrack: Connector = {
  id: 'spacetrack',
  intervalMs: TTL_MS,
  startDelayMs: 3_000,
  stub: (c) =>
    c.spacetrackUser && c.spacetrackPassword
      ? undefined
      : 'Needs SPACETRACK_USER and SPACETRACK_PASSWORD (free account at space-track.org) to fetch Starlink elements as a second source next to CelesTrak.',
  async run(ctx) {
    const { user, password } = { user: ctx.config.spacetrackUser!, password: ctx.config.spacetrackPassword! };
    const row = ctx.store.get<Omm[]>(CACHE_KEY);
    if (!row && ctx.http.offline) throw new Error('offline (OFFLINE=1) and nothing cached');
    let omms: Omm[];
    if (row && (isFresh(row) || ctx.http.offline)) {
      omms = row.value;
      ctx.health.fromCache = true;
    } else {
      const gate = readBackoff(ctx.store, 'spacetrack');
      if (isBackedOff(gate)) {
        // a failed login is retried only at the stored time; a locked-out account must not see repeated attempts
        const msg = `${gate.message ?? 'earlier failure'} (next attempt ${new Date(gate.notBefore).toISOString().slice(11, 16)}Z)`;
        if (!row) throw new Error(msg);
        omms = row.value;
        ctx.softFail(msg, gate.notBefore - Date.now());
      } else {
        try {
          omms = await fetchSpaceTrackGp(fetch, user, password);
          ctx.store.set(CACHE_KEY, omms, TTL_MS);
          clearBackoff(ctx.store, 'spacetrack');
        } catch (err) {
          const next = recordFailure(ctx.store, 'spacetrack', err);
          if (!row) throw err;
          omms = row.value;
          ctx.softFail((err as Error).message, next.notBefore - Date.now());
        }
      }
    }
    const changed = ctx.hub.upsert(...omms.map((o) => satelliteEntity(o, 'starlink')));
    ctx.health.note = `${omms.length} Starlink element sets`;
    ctx.log(`${omms.length} starlink, ${changed} changed`);
  },
};
