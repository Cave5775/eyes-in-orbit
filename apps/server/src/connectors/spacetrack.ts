import type { Omm } from '@eio/core';
import { clearBackoff, isBackedOff, readBackoff, recordFailure } from '../backoff';
import type { Connector } from '../connector';
import { USER_AGENT } from '../http';
import { guardedFetch } from '../net/guarded-fetch';
import { LimitedError, hhmmz, type Limiter } from '../net/limiter';
import { isFresh } from '../store';
import { parseOmmJson, satelliteEntity } from './celestrak';

const BASE = 'https://www.space-track.org';
/** Current Starlink GP elements: epoch within 30 days, not decayed. `%3E` is `>`, `~~` is SQL LIKE. */
export const STARLINK_QUERY =
  '/basicspacedata/query/class/gp/OBJECT_NAME/~~STARLINK/DECAY_DATE/null-val/EPOCH/%3Enow-30/orderby/NORAD_CAT_ID/format/json';
/** Space-Track asks for GP data at most about once an hour; every 3 h keeps well inside that and matches CelesTrak. */
const TTL_MS = 3 * 3600_000;
const CACHE_KEY = 'spacetrack:starlink';

/** A failed login is not tried again for this long (the account may lock out); saving new credentials lifts it. */
export const FAILED_LOGIN_WAIT_MS = 6 * 3600_000;

/** `name=value` pairs of the Set-Cookie headers, joined into one Cookie header. */
const cookieHeader = (res: Response): string =>
  res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

/**
 * Log in, run one query, log out. Space-Track answers a bad login with HTTP 200 and `{"Login":"Failed"}`, so the body
 * is checked as well as the status. Never logs or throws the password.
 */
export async function fetchSpaceTrackGp(
  limiter: Limiter, user: string, password: string, opts: { fetch?: typeof fetch; query?: string } = {},
): Promise<Omm[]> {
  const headers = { 'user-agent': USER_AGENT };
  const query = opts.query ?? STARLINK_QUERY;
  const send = async (source: string, path: string, init: RequestInit) => {
    const r = await guardedFetch(limiter, source, `${BASE}${path}`, init, { mode: 'poll', fetch: opts.fetch });
    if ('limited' in r) throw new LimitedError(source, r.retryAt, r.reason, r.kind);
    return r.response;
  };
  // the query's own limit (one per 2 h) is checked before logging in, so a refused query never costs a login
  const gate = limiter.peek('spacetrack:query', 'poll');
  if ('limited' in gate) throw new LimitedError('spacetrack:query', gate.retryAt, gate.reason, gate.kind);
  const login = await send('spacetrack:login', '/ajaxauth/login', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identity: user, password }),
    signal: AbortSignal.timeout(20_000),
  });
  const loginBody = await login.text();
  if (!login.ok) throw new Error(`HTTP ${login.status} from Space-Track login`);
  if (/"Login"\s*:\s*"Failed"/i.test(loginBody)) {
    // a rejected login is retried only after 6 h, whatever the poll interval; new credentials lift it (credentials.ts)
    limiter.block('spacetrack:login', FAILED_LOGIN_WAIT_MS, 'failed login');
    limiter.block('spacetrack:query', FAILED_LOGIN_WAIT_MS, 'failed login');
    throw new Error('Space-Track login failed (check SPACETRACK_USER / SPACETRACK_PASSWORD)');
  }
  const cookie = cookieHeader(login);
  if (!cookie) throw new Error('Space-Track login returned no session cookie');
  try {
    const res = await send('spacetrack:query', query, { headers: { ...headers, cookie }, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} for Space-Track query: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    return parseOmmJson(text);
  } finally {
    await send('spacetrack:logout', '/ajaxauth/logout', { headers: { ...headers, cookie }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
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
          omms = await fetchSpaceTrackGp(ctx.http.limiter, user, password);
          ctx.store.set(CACHE_KEY, omms, TTL_MS);
          clearBackoff(ctx.store, 'spacetrack');
        } catch (err) {
          // refused by the limiter (spacing, cap, block): nothing was sent, so no failure is counted; it is retried when allowed
          if (err instanceof LimitedError) {
            // a failed login keeps its red "login rejected" reading until the 6 h wait is over or new credentials arrive
            const msg = err.reason === 'failed login'
              ? `Space-Track login failed (check SPACETRACK_USER / SPACETRACK_PASSWORD); next attempt ${hhmmz(err.retryAt)}`
              : err.message;
            if (!row) throw err.reason === 'failed login' ? new Error(msg) : err;
            omms = row.value;
            ctx.softFail(msg, Math.max(err.retryAt - Date.now(), 1000));
          } else {
            const next = recordFailure(ctx.store, 'spacetrack', err);
            if (!row) throw err;
            omms = row.value;
            ctx.softFail((err as Error).message, next.notBefore - Date.now());
          }
        }
      }
    }
    const changed = ctx.hub.upsert(...omms.map((o) => satelliteEntity(o, 'starlink')));
    ctx.health.note = `${omms.length} Starlink element sets`;
    ctx.log(`${omms.length} starlink, ${changed} changed`);
  },
};
