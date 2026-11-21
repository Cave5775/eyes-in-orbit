// node:http <-> Web Request/Response, shared by the standalone entry (node.ts) and the Vite dev plugin.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export type WebHandler = (req: Request) => Promise<Response>;

// The URL is built on a fixed base, never from the Host header: a malformed Host ("a b", "x:99999") would make the URL
// parser throw. The header itself still travels in the headers for the handler's same-origin check.
const BASE = 'http://relay.invalid';

/** Returns null when the request line or a header cannot be represented (the caller answers 400). */
export function toWebRequest(req: IncomingMessage, res: ServerResponse): Request | null {
  try {
    // behind a mount (connect/Vite) req.url has the prefix stripped; originalUrl keeps the full path
    const path = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/';
    // string concatenation, not new URL(path, base): a path like //host/x would otherwise replace the host
    const url = new URL(BASE + (path.startsWith('/') ? path : '/'));
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
  } catch {
    return null;
  }
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
  // the client left: stop reading the upstream body (this also releases the upstream connection)
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** A connect/node:http style listener for a Web handler. A synchronous throw never reaches the process. */
export function nodeListener(handler: WebHandler) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const webReq = toWebRequest(req, res);
      if (!webReq) {
        res.statusCode = 400;
        res.end();
        return;
      }
      handler(webReq)
        .then((out) => {
          // answered before the whole request body was read (size cap): do not keep the connection for more requests
          if (!req.complete) {
            res.setHeader('connection', 'close');
            res.once('finish', () => req.destroy());
          }
          return sendWebResponse(out, res);
        })
        .catch(() => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end();
          } else res.destroy();
        });
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      } else res.destroy();
    }
  };
}
