import { defaultBodies } from '@eio/core';
import type { FastifyInstance } from 'fastify';
import { searchNews } from './connectors/snapi';
import type { Http } from './http';
import type { Hub } from './hub';
import { filterEntities, searchEntities } from './search';

const int = (v: unknown, fallback?: number): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

export function registerApi(app: FastifyInstance, hub: Hub, http: Http): void {
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

  app.get('/api/dsn', async () => hub.dsn);

  app.get('/api/iss', async () => ({ fix: hub.issFix, telemetry: [...hub.telemetry.values()] }));

  app.get('/api/bodies', async () => defaultBodies.all());
}
