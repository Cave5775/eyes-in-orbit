import { defaultBodies, type LiveAscent } from '@eio/core';
import type { FastifyInstance } from 'fastify';
import { searchNews } from './connectors/snapi';
import { syncLaunchEntities } from './connectors/launchlibrary';
import { CredentialError, type Credentials } from './credentials';
import { LimitedError } from './net/limiter';
import type { DescribeService } from './describe/service';
import type { Http } from './http';
import { parseTile, type ImageryCache } from './imagery';
import type { Hub } from './hub';
import { filterEntities, searchEntities } from './search';
import type { Store } from './store';
import { buildSeries, isLocalRequest, mergeLive, validateTelemetryBody } from './telemetry';
import { matchTrajectory } from './trajectory';

export const LIVE_KEY = 'telemetry:live:';
const LIVE_TTL_MS = 7 * 86_400_000;

/** Reload measured ascent telemetry persisted by an earlier run. */
export function loadLiveTelemetry(hub: Hub, store: Store): number {
  let n = 0;
  for (const { key, row } of store.list<LiveAscent>(LIVE_KEY)) {
    if (Array.isArray(row.value?.rows) && row.value.rows.length) {
      hub.liveTelemetry.set(key.slice(LIVE_KEY.length), row.value);
      n++;
    }
  }
  return n;
}

const int = (v: unknown, fallback?: number): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

export interface CredentialsApi {
  credentials: Credentials;
  /** called after a successful change with the connectors whose settings moved */
  onChanged(connectors: string[]): void;
}

export function registerApi(app: FastifyInstance, hub: Hub, http: Http, store?: Store, creds?: CredentialsApi, imagery?: ImageryCache, describe?: DescribeService): void {
  app.get('/api/health', async () => ({
    serverTime: Date.now(),
    entityCount: hub.graph.size,
    connectors: hub.healthList(),
  }));

  app.get<{ Querystring: { since?: string; kind?: string; body?: string; q?: string; group?: string; limit?: string } }>(
    '/api/entities',
    async (req) => {
      const { since, kind, body, q, group, limit } = req.query;
      return {
        serverTime: Date.now(),
        entities: filterEntities(hub.graph.all(), { since: int(since), kind, body, q, group, limit: int(limit) }),
      };
    },
  );

  app.get<{ Params: { id: string } }>('/api/entities/:id', async (req, reply) => {
    const rec = hub.graph.get(req.params.id);
    return rec ?? reply.code(404).send({ error: `unknown entity ${req.params.id}` });
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search', async (req) =>
    searchEntities(hub.graph.all(), req.query.q ?? '', Math.min(int(req.query.limit, 20)!, 100)));

  app.get('/api/launches', async () => ({ launches: hub.launches }));

  // text description of one object, looked up only when asked (Wikipedia via Wikidata, ESA DISCOS with a token), cached
  if (describe) {
    app.get<{ Params: { entityId: string } }>('/api/describe/:entityId', async (req, reply) => {
      const rec = hub.graph.get(req.params.entityId);
      if (!rec) return reply.code(404).send({ error: `unknown entity ${req.params.entityId}` });
      return describe.describe(rec);
    });
  }

  app.get<{ Querystring: { entity?: string; q?: string; limit?: string } }>('/api/news', async (req, reply) => {
    const { entity, q } = req.query;
    const limit = Math.min(int(req.query.limit, 20)!, 50);
    let search = q?.trim();
    if (!search && entity) {
      const rec = hub.graph.get(entity);
      if (!rec) return reply.code(404).send({ error: `unknown entity ${entity}` });
      search = rec.links?.newsQuery ?? rec.name;
    }
    if (!search) return { articles: hub.articles.slice(0, limit) };
    try {
      return { articles: await searchNews(http, search, limit) };
    } catch (err) {
      if (err instanceof LimitedError) {
        // not an upstream failure: the request limiter refused the search; the client shows the retry time
        return reply.code(429).header('retry-after', String(Math.max(Math.ceil((err.retryAt - Date.now()) / 1000), 1)))
          .send({ error: err.message, limited: true, retryAt: err.retryAt });
      }
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // ---- ascent telemetry: the modeled plan next to measured rows (see telemetry.ts for the ingest format)
  const findLaunch = (id: string) => hub.launches.find((l) => l.id === id.replace(/^launch-/, ''));

  app.get<{ Params: { launchId: string } }>('/api/telemetry/:launchId', async (req, reply) => {
    const launch = findLaunch(req.params.launchId);
    if (!launch) return reply.code(404).send({ error: `unknown launch ${req.params.launchId}` });
    return buildSeries(launch, matchTrajectory(hub.trajectories, launch), hub.liveTelemetry.get(launch.id));
  });

  const requireLocal = (req: { socket: { remoteAddress?: string }; headers: { origin?: string } }) =>
    isLocalRequest(req.socket.remoteAddress, req.headers.origin);

  const refresh = () => {
    syncLaunchEntities(hub);
    hub.flush();
  };

  app.post<{ Params: { launchId: string } }>('/api/telemetry/:launchId', async (req, reply) => {
    if (!requireLocal(req)) return reply.code(403).send({ error: 'telemetry ingest is accepted from localhost only' });
    const launch = findLaunch(req.params.launchId);
    if (!launch) return reply.code(404).send({ error: `unknown launch ${req.params.launchId}` });
    const v = validateTelemetryBody(req.body);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    let live: LiveAscent;
    try {
      live = mergeLive(hub.liveTelemetry.get(launch.id), v.input, Date.now());
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    hub.liveTelemetry.set(launch.id, live);
    store?.set(`${LIVE_KEY}${launch.id}`, live, LIVE_TTL_MS);
    refresh();
    const series = buildSeries(launch, matchTrajectory(hub.trajectories, launch), live);
    return {
      ok: true, launchId: launch.id, entityId: launch.entityId, source: series.source, rows: live.rows.length,
      lastTSec: live.rows[live.rows.length - 1].tSec, extrapolatedFromSec: series.live?.extrapolatedFromSec ?? null,
    };
  });

  app.delete<{ Params: { launchId: string } }>('/api/telemetry/:launchId', async (req, reply) => {
    if (!requireLocal(req)) return reply.code(403).send({ error: 'telemetry ingest is accepted from localhost only' });
    const launch = findLaunch(req.params.launchId);
    if (!launch) return reply.code(404).send({ error: `unknown launch ${req.params.launchId}` });
    const had = hub.liveTelemetry.delete(launch.id);
    store?.delete(`${LIVE_KEY}${launch.id}`);
    refresh();
    return { ok: true, launchId: launch.id, cleared: had };
  });

  // ---- Earth imagery tiles for the close-up detail layer (NASA GIBS through a disk cache, OFFLINE-aware)
  if (imagery) {
    app.get<{ Params: { z: string; x: string; file: string } }>('/api/imagery/:z/:x/:file', async (req, reply) => {
      const m = /^(\d{1,4})\.jpg$/.exec(req.params.file);
      const id = m ? parseTile(req.params.z, req.params.x, m[1]) : null;
      if (!id) return reply.code(400).send({ error: 'tile must be /api/imagery/<z 3..6>/<x>/<y>.jpg inside the grid (2^(z+1) x 2^z tiles)' });
      try {
        const buf = await imagery.get(id);
        if (!buf) return reply.code(404).send({ error: 'tile not cached and OFFLINE=1' });
        return reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=86400').send(buf);
      } catch (err) {
        if (err instanceof LimitedError) {
          return reply.code(429).header('retry-after', String(Math.max(Math.ceil((err.retryAt - Date.now()) / 1000), 1))).send({ error: err.message, limited: true, retryAt: err.retryAt });
        }
        return reply.code(502).send({ error: (err as Error).message });
      }
    });
  }

  // ---- credentials typed into the UI: local requests only, secrets are write-only
  if (creds) {
    const denied = { error: 'credentials can be read and changed from localhost only' };
    app.get('/api/credentials', async (req, reply) =>
      requireLocal(req) ? { credentials: creds.credentials.describe() } : reply.code(403).send(denied));

    app.put<{ Body: { values?: unknown } }>('/api/credentials', async (req, reply) => {
      if (!requireLocal(req)) return reply.code(403).send(denied);
      try {
        const { changed, connectors } = creds.credentials.update(req.body?.values);
        if (connectors.length) creds.onChanged(connectors);
        return { ok: true, changed, credentials: creds.credentials.describe() };
      } catch (err) {
        if (err instanceof CredentialError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    });
  }

  app.get('/api/dsn', async () => hub.dsn);

  app.get('/api/iss', async () => ({ fix: hub.issFix, telemetry: [...hub.telemetry.values()], arrays: hub.issArrays }));

  app.get('/api/bodies', async () => defaultBodies.all());
}
