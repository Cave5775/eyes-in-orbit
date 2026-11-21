import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeServer } from '../src/node';
import { resolveStatic } from '../src/static';

let base: string;
let root: string;
let server: ReturnType<typeof createNodeServer>;
let port: number;
let upstreamCalls = 0;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'eio-relay-h-'));
  root = join(base, 'dist');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<html>app</html>');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(root, '.git', 'config'), 'x');
  writeFileSync(join(base, 'outside.txt'), 'outside');
  server = createNodeServer({
    webDist: root,
    fetch: async () => {
      upstreamCalls++;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

/** sends raw bytes, so a Host header the fetch client would refuse can be tested */
function raw(request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.write(request));
    let out = '';
    s.on('data', (d) => (out += d.toString()));
    s.on('end', () => resolve(out));
    s.on('close', () => resolve(out));
    s.on('error', reject);
  });
}

describe('node host robustness', () => {
  it('survives malformed Host headers and keeps serving', async () => {
    const url = encodeURIComponent('https://ssd.jpl.nasa.gov/api/horizons.api');
    for (const host of ['a b', 'x:99999', '[', 'a/b', '']) {
      const out = await raw(`GET /relay?url=${url} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      expect(out, host).toMatch(/^HTTP\/1\.1 (200|400|500)/);
    }
    const ok = await fetch(`http://127.0.0.1:${port}/`);
    expect(ok.status).toBe(200);
  });

  it('treats a //host path as a path, not as another host', async () => {
    const out = await raw('GET //evil.test/x HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(out).toMatch(/^HTTP\/1\.1 (200|404)/);
  });

  it('answers 413 for a request body over the cap, streamed through the adapter', async () => {
    const before = upstreamCalls;
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 6) return c.close();
        sent++;
        c.enqueue(chunk);
      },
    });
    const r = await fetch(`http://127.0.0.1:${port}/relay?url=${encodeURIComponent('https://mast.stsci.edu/api/v0/invoke')}`, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(r.status).toBe(413);
    expect(upstreamCalls).toBe(before);
  });

  it('sends the safety headers on relayed answers', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/relay?url=${encodeURIComponent('https://ssd.jpl.nasa.gov/api/horizons.api')}`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});

describe('static: dotfiles and symlinks', () => {
  it('refuses dotfiles and dot directories', async () => {
    expect(await resolveStatic(root, '/.env')).toBeNull();
    expect(await resolveStatic(root, '/.git/config')).toBeNull();
    expect(await resolveStatic(root, '/%2eenv')).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/.env`)).status).toBe(404);
  });

  it('does not follow a symlink out of the folder', async (ctx) => {
    try {
      symlinkSync(join(base, 'outside.txt'), join(root, 'link.txt'), 'file');
    } catch {
      ctx.skip(); // creating symlinks needs a privilege on some Windows setups
      return;
    }
    expect(await resolveStatic(root, '/link.txt')).toBeNull();
  });
});
