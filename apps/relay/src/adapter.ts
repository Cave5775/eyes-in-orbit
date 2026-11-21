// node:http <-> Web Request/Response, shared by the standalone entry (node.ts) and the Vite dev plugin.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export type WebHandler = (req: Request) => Promise<Response>;

export function toWebRequest(req: IncomingMessage, res: ServerResponse): Request {
  // behind a mount (connect/Vite) req.url has the prefix stripped; originalUrl keeps the full path
  const path = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/';
  const url = `http://${req.headers.host ?? 'localhost'}${path}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, v);
  }
  const ctl = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ctl.abort();
  });
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    signal: ctl.signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit);
}

export async function sendWebResponse(out: Response, res: ServerResponse): Promise<void> {
  res.statusCode = out.status;
  out.headers.forEach((v, k) => res.setHeader(k, v));
  if (!out.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(out.body as import('node:stream/web').ReadableStream);
  // an upstream that exceeds the size cap errors the stream: drop the connection rather than send a short body
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** A connect/node:http style listener for a Web handler. */
export function nodeListener(handler: WebHandler) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    handler(toWebRequest(req, res))
      .then((out) => sendWebResponse(out, res))
      .catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        } else res.destroy();
      });
  };
}
