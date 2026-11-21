import type { Omm } from '@eio/core';
import { clearBackoff, isBackedOff, readBackoff, recordFailure } from '../backoff';
import { guardedFetch } from '../net/guarded-fetch';
import { LimitedError, hhmmz, type Limiter } from '../net/limiter';
import { applyUpstream, resolveUpstream, type UpstreamTable } from '../net/upstream';
import type { Connector } from '../scheduler';
import { isFresh } from '../store';
import { parseOmmJson, satelliteEntity } from './celestrak';
import type { CredentialSource } from './types';

/** Current Starlink GP elements: epoch within 30 days, not decayed. `%3E` is `>`, `~~` is SQL LIKE. */
export const STARLINK_QUERY =
  '/basicspacedata/query/class/gp/OBJECT_NAME/~~STARLINK/DECAY_DATE/null-val/EPOCH/%3Enow-30/orderby/NORAD_CAT_ID/format/json';
/** Space-Track asks for GP data at most about once an hour; every 3 h keeps well inside that and matches CelesTrak. */
const TTL_MS = 3 * 3600_000;
const CACHE_KEY = 'spacetrack:starlink';
/** The limiter source of the one relay call (it stands for login, query and logout together). */
export const SPACETRACK_SOURCE = 'spacetrack:query';

/** A failed login is not tried again for this long (the account may lock out); saving new credentials lifts it. */
export const FAILED_LOGIN_WAIT_MS = 6 * 3600_000;

export const NEEDS_CREDENTIALS =
  'Needs a Space-Track username and password (free account at space-track.org, set in the credentials panel) to fetch Starlink elements as a second source next to CelesTrak.';

/** Only the same origin (a relative base) or https: may carry credentials; a cross-origin http: relay would send them in the clear. */
export function isSafeRelayBase(base: string): boolean {
  if (base.startsWith('/') && !base.startsWith('//')) return true;
  try { return new URL(base).protocol === 'https:'; } catch { return false; }
}

/** Is this the relay's bad-login answer? (401 with a JSON body whose `stage` is "login") */
const isBadLogin = (status: number, text: string): boolean => {
  if (status !== 401) return false;
  try { return (JSON.parse(text) as { stage?: unknown }).stage === 'login'; } catch { return false; }
};

/**
 * Space-Track cannot be called from a browser: its login sets a cross-site session cookie and its answers carry no CORS headers.
 * The stateless relay does login, one query and logout in a single call, `POST <relayBase>/spacetrack` with the JSON body
 * `{ identity, password, query }` (query = a path under `/basicspacedata/query/`), and answers with the query's status, body and
 * content type (400 bad request, 403 not allow-listed, 502 upstream failure). The browser holds no cookie.
 *
 * The relay base comes from the upstream table (`resolveUpstream('spacetrack:query')`, kind `relay`); any other kind is an error,
 * because the credentials must never go anywhere but the relay. The call is one request of the `spacetrack:query` limit (one per 2 h);
 * a failed login is ONLY a 401 whose JSON body says `"stage":"login"` (the relay's answer for a rejected login) and blocks login and query for 6 h;
 * every other answer (401 without that stage, 502 and 504 with a stage, anything else) is a transient error. The password is never put into an
 * error message.
 *
 * The attempt is counted when it is sent (the limiter persists it before the request), so a relay 502/504 still uses the 2 h query slot:
 * refunding it would break the "attempt recorded before the request" rule, and a retry soon after an outage is what Space-Track's per-account
 * lockouts punish. The connector's own gate (`backoff:spacetrack`) then waits 30 min and more before the next try.
 */
export async function fetchSpaceTrackGp(
  limiter: Limiter, user: string, password: string, opts: { fetch?: typeof fetch; query?: string; upstreams?: UpstreamTable } = {},
): Promise<Omm[]> {
  const query = opts.query ?? STARLINK_QUERY;
  const upstream = resolveUpstream(SPACETRACK_SOURCE, opts.upstreams);
  if (upstream.kind !== 'relay') throw new Error('Space-Track is only reachable through the relay (no CORS headers, cookie login); no relay is configured');
  if (!isSafeRelayBase(upstream.base)) throw new Error('Space-Track credentials go only to a same-origin or https: relay');
  // a relative base resolves against the app root like every relay call (`setAppBase`)
  const url = applyUpstream({ kind: 'static', path: `${upstream.base.replace(/\/+$/, '')}/spacetrack` }, '', undefined);
  // a failed login's block and the query's own limit (one per 2 h) are checked before anything is sent, so a refused query never costs a login
  for (const source of ['spacetrack:login', SPACETRACK_SOURCE]) {
    const gate = await limiter.peek(source, 'poll');
    if ('limited' in gate) throw new LimitedError(source, gate.retryAt, gate.reason, gate.kind, gate.blockKind);
  }
  const r = await guardedFetch(limiter, SPACETRACK_SOURCE, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ identity: user, password, query }),
    signal: AbortSignal.timeout(90_000),
  }, { mode: 'poll', fetch: opts.fetch, upstreams: { [SPACETRACK_SOURCE]: { kind: 'direct' } } });
  if ('limited' in r) throw new LimitedError(SPACETRACK_SOURCE, r.retryAt, r.reason, r.kind, r.blockKind);
  const text = await r.response.text();
  if (isBadLogin(r.response.status, text)) {
    // a rejected login is retried only after 6 h, whatever the poll interval; new credentials lift it
    await limiter.block('spacetrack:login', FAILED_LOGIN_WAIT_MS, 'failed login', 'failure');
    await limiter.block(SPACETRACK_SOURCE, FAILED_LOGIN_WAIT_MS, 'failed login', 'failure');
    throw new Error('Space-Track login failed (check the username and password)');
  }
  if (!r.response.ok) throw new Error(`HTTP ${r.response.status} for Space-Track query: ${text.slice(0, 120).replace(/\s+/g, ' ').split(password).join('***')}`);
  return parseOmmJson(text);
}

export interface SpaceTrackOptions {
  credentials: CredentialSource;
  fetch?: typeof fetch;
  upstreams?: UpstreamTable;
  now?: () => number;
}

/**
 * Space-Track as a second source for the Starlink shell, independent of CelesTrak's per-IP download limit. Needs a free
 * account (credential keys `spacetrackUser`, `spacetrackPassword`). Entities share the `sat-<NORAD>` ids with the `celestrak`
 * connector, so whichever ran last supplies the element set; both sources are the same 18th SDS catalog.
 *
 * A connector's `stub` check is synchronous and the credentials are read from async storage, so a missing credential shows as an
 * error run with `NEEDS_CREDENTIALS` (the scheduler's `refresh('spacetrack')` retries at once when credentials are saved).
 */
export function createSpacetrack(deps: SpaceTrackOptions): Connector {
  const now = deps.now ?? Date.now;
  return {
    id: 'spacetrack',
    intervalMs: TTL_MS,
    startDelayMs: 3_000,
    async run(ctx) {
      const user = await deps.credentials.get('spacetrackUser');
      const password = await deps.credentials.get('spacetrackPassword');
      const row = await ctx.store.get<Omm[]>(CACHE_KEY);
      if (!user || !password) {
        if (row) {
          ctx.hub.upsert(...row.value.map((o) => satelliteEntity(o, 'starlink')));
          ctx.health.fromCache = true;
        }
        throw new Error(NEEDS_CREDENTIALS);
      }
      if (!row && ctx.http.offline) throw new Error('offline and nothing cached');
      let omms: Omm[];
      if (row && (isFresh(row, now()) || ctx.http.offline)) {
        omms = row.value;
        ctx.health.fromCache = true;
      } else {
        const gate = await readBackoff(ctx.store, 'spacetrack');
        if (isBackedOff(gate, now())) {
          // a failed login is retried only at the stored time; a locked-out account must not see repeated attempts
          const msg = `${gate.message ?? 'earlier failure'} (next attempt ${hhmmz(gate.notBefore)})`;
          if (!row) throw new Error(msg);
          omms = row.value;
          ctx.softFail(msg, gate.notBefore - now());
        } else {
          try {
            omms = await fetchSpaceTrackGp(ctx.http.limiter, user, password, { fetch: deps.fetch, upstreams: deps.upstreams });
            await ctx.store.put(CACHE_KEY, omms, TTL_MS, now());
            await clearBackoff(ctx.store, 'spacetrack');
          } catch (err) {
            // refused by the limiter (spacing, cap, block): nothing was sent, so no failure is counted; it is retried when allowed
            if (err instanceof LimitedError) {
              // a failed login keeps its red "login rejected" reading until the 6 h wait is over or new credentials arrive
              const msg = err.reason === 'failed login'
                ? `Space-Track login failed (check the username and password); next attempt ${hhmmz(err.retryAt)}`
                : err.message;
              if (!row) throw err.reason === 'failed login' ? new Error(msg) : err;
              omms = row.value;
              ctx.softFail(msg, Math.max(err.retryAt - now(), 1000));
            } else {
              const next = await recordFailure(ctx.store, 'spacetrack', err, now());
              if (!row) throw err;
              omms = row.value;
              ctx.softFail((err as Error).message, next.notBefore - now());
            }
          }
        }
      }
      const changed = ctx.hub.upsert(...omms.map((o) => satelliteEntity(o, 'starlink')));
      ctx.health.note = `${omms.length} Starlink element sets`;
      ctx.log(`${omms.length} starlink, ${changed} changed`);
    },
  };
}
