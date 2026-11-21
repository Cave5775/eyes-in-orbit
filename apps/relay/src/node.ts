// Standalone host: serves apps/web/dist and mounts the relay at /relay. Nothing is stored; no keys are read.
//   PORT (default 8080), HOST (default 127.0.0.1; 0.0.0.0 to listen on every interface),
//   WEB_DIST (default apps/web/dist), RELAY_ALLOWED_ORIGINS (comma list or *, default none = same-origin only)
import { createReadStream } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRelay, type FetchLike } from './handler';
import { nodeListener } from './adapter';
import { resolveStatic } from './static';

export interface NodeServerOptions {
  webDist: string;
  fetch?: FetchLike;
  allowedOrigins?: string[] | '*';
}

export function createNodeServer(opts: NodeServerOptions): Server {
  const relay = nodeListener(createRelay({ fetch: opts.fetch ?? ((u, i) => fetch(u, i)), allowedOrigins: opts.allowedOrigins }));
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/relay' || path.startsWith('/relay/')) {
      relay(req, res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    resolveStatic(opts.webDist, req.url ?? '/')
      .then((hit) => {
        if (!hit) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
          return;
        }
        res.writeHead(200, {
          'content-type': hit.type,
          'content-length': hit.size,
          'cache-control': hit.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        if (req.method === 'HEAD') res.end();
        else createReadStream(hit.file).on('error', () => res.destroy()).pipe(res);
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
  });
}

function origins(v: string | undefined): string[] | '*' | undefined {
  if (!v) return undefined;
  return v.trim() === '*' ? '*' : v.split(',').map((s) => s.trim()).filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const webDist = process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  createNodeServer({ webDist, allowedOrigins: origins(process.env.RELAY_ALLOWED_ORIGINS) }).listen(port, host, () => {
    console.log(`serving ${webDist} and /relay on http://${host}:${port}`);
  });
}
