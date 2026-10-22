import { defaultBodies, type LiveAscent } from '@eio/core';
import type { FastifyInstance } from 'fastify';
import { searchNews } from './connectors/snapi';
import { syncLaunchEntities } from './connectors/launchlibrary';
import type { Http } from './http';
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

export function registerApi(app: FastifyInstance, hub: Hub, http: Http, store?: Store): void {
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

  app.get('/api/dsn', async () => hub.dsn);

  app.get('/api/iss', async () => ({ fix: hub.issFix, telemetry: [...hub.telemetry.values()], arrays: hub.issArrays }));

  app.get('/api/bodies', async () => defaultBodies.all());
}
