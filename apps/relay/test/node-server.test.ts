import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeServer } from '../src/node';
import { mimeOf, resolveStatic } from '../src/static';

let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'eio-relay-'));
  root = join(base, 'dist');
  outside = join(base, 'secret.txt');
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'dir'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<html>app</html>');
  writeFileSync(join(root, 'assets', 'a-1.js'), 'export {}');
  writeFileSync(join(root, 'assets', 'tex.png'), 'png');
  writeFileSync(outside, 'secret');
});
afterAll(() => rmSync(join(root, '..'), { recursive: true, force: true }));

describe('static lookup', () => {
  it('serves files with the right MIME type', async () => {
    expect((await resolveStatic(root, '/assets/a-1.js'))?.type).toBe('text/javascript; charset=utf-8');
    expect((await resolveStatic(root, '/assets/tex.png'))?.type).toBe('image/png');
    expect(mimeOf('x.wasm')).toBe('application/wasm');
    expect(mimeOf('x.unknown')).toBe('application/octet-stream');
  });

  it('falls back to index.html for app routes and directories, 404 for a missing asset', async () => {
    expect((await resolveStatic(root, '/'))?.file).toMatch(/index\.html$/);
    expect((await resolveStatic(root, '/some/route'))?.file).toMatch(/index\.html$/);
    expect((await resolveStatic(root, '/dir'))?.file).toMatch(/index\.html$/);
    expect(await resolveStatic(root, '/assets/missing.js')).toBeNull();
  });

  it('marks hashed assets immutable and the entry page not', async () => {
    expect((await resolveStatic(root, '/assets/a-1.js'))?.immutable).toBe(true);
    expect((await resolveStatic(root, '/'))?.immutable).toBe(false);
  });

  it('is safe against traversal', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt', '/%00', '/..\\secret.txt', '/%E0%A4%A']) {
      const hit = await resolveStatic(root, p);
      expect(hit === null || !hit.file.endsWith('secret.txt')).toBe(true);
    }
  });
});

describe('node server', () => {
  let server: ReturnType<typeof createNodeServer>;
  let origin: string;
  const seen: string[] = [];

  beforeAll(async () => {
    server = createNodeServer({
      webDist: root,
      fetch: async (url) => {
        seen.push(url);
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('serves the app and the SPA fallback', async () => {
    const r = await fetch(`${origin}/assets/a-1.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(await (await fetch(`${origin}/orbit/iss`)).text()).toBe('<html>app</html>');
    expect((await fetch(`${origin}/assets/nope.js`)).status).toBe(404);
    expect((await fetch(origin, { method: 'POST' })).status).toBe(405);
  });

  it('mounts the relay at /relay (fake upstream, no network)', async () => {
    const r = await fetch(`${origin}/relay?url=${encodeURIComponent('https://ssd.jpl.nasa.gov/api/horizons.api?a=1')}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(seen).toEqual(['https://ssd.jpl.nasa.gov/api/horizons.api?a=1']);
    expect((await fetch(`${origin}/relay?url=${encodeURIComponent('https://example.com/')}`)).status).toBe(403);
  });

  it('passes a POST body through the adapter', async () => {
    let got = '';
    const s2 = createNodeServer({
      webDist: root,
      fetch: async (_u, init) => {
        got = new TextDecoder().decode(init?.body as Uint8Array);
        return new Response('ok');
      },
    });
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const o2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
    const r = await fetch(`${o2}/relay?url=${encodeURIComponent('https://mast.stsci.edu/api/v0/invoke')}`, { method: 'POST', body: 'request=1' });
    expect(r.status).toBe(200);
    expect(got).toBe('request=1');
    await new Promise<void>((r2) => s2.close(() => r2()));
  });
});
