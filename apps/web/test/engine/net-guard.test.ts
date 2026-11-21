import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The single choke point: outgoing requests (`fetch(`, `new WebSocket`, XHR, EventSource, a raw http client) live in
 * apps/web/src/engine/net only, so every one passes the request limiter. A new data source that fetches somewhere else in the
 * engine fails here. (The rest of the web app, such as map tiles through `<img>`, is outside the engine.)
 */
const ROOT = resolve(__dirname, '../../../..');
const SCAN = ['apps/web/src/engine'];
const GUARD_DIR = 'apps/web/src/engine/net/';

/** Files outside `net/` that may call the network directly, with the reason. Keep this list short. */
const ALLOW: Record<string, string> = {};

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'fetch(', re: /(^|[^\w.$])fetch\s*\(/ },
  { name: '.fetch(', re: /\b(globalThis|window|global)\.fetch\s*\(/ },
  { name: '?? fetch (a default fetch)', re: /\?\?\s*fetch\b/ },
  { name: 'new WebSocket', re: /\bnew\s+WebSocket\b/ },
  { name: 'XMLHttpRequest / EventSource / sendBeacon', re: /\b(XMLHttpRequest|EventSource)\b|\bsendBeacon\s*\(/ },
  { name: 'a raw http client import', re: /(^|;)\s*import\s+(?!type\b)[^;]*from\s+['"](node:)?(https?|http2|net|tls|undici|ws|axios|node-fetch|got)['"]/ },
  { name: 'require(/import( of a network module', re: /\b(require|import)\s*\(\s*['"](node:)?(https?|http2|net|tls|undici|ws)['"]/ },
  { name: 'a fetch-named call', re: /\bfetch\w*\s*\(/ },
];

/** fetch-named functions that are not the network (they call `Http`/the guard); anything else matching `fetch*(` fails. */
const FETCH_NAMES_OK = ['fetchSpaceTrackGp', 'fetchSummary'];
const stripOk = (line: string): string => FETCH_NAMES_OK.reduce((l, n) => l.split(n).join('_'), line);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** Code lines only: block and line comments are dropped (the pattern text appears in doc comments). */
function codeLines(text: string): string[] {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock.split(/\r?\n/).map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'));
}

describe('single network choke point', () => {
  it('no fetch( or new WebSocket outside apps/web/src/engine/net and the allow-list', () => {
    const offenders: string[] = [];
    for (const base of SCAN) {
      for (const file of walk(join(ROOT, base))) {
        const rel = relative(ROOT, file).split(sep).join('/');
        if (rel.startsWith(GUARD_DIR) || ALLOW[rel]) continue;
        codeLines(readFileSync(file, 'utf8')).forEach((line, i) => {
          for (const f of FORBIDDEN) if (f.re.test(stripOk(line))) offenders.push(`${rel}:${i + 1} uses ${f.name}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard directory holds the choke point and the limiter', () => {
    for (const f of ['guarded-fetch.ts', 'limiter.ts', 'upstream.ts']) expect(() => statSync(join(ROOT, GUARD_DIR, f))).not.toThrow();
  });

  it('the allow-list only names files that exist', () => {
    for (const rel of Object.keys(ALLOW)) expect(() => statSync(join(ROOT, rel))).not.toThrow();
  });

  it('the guard does catch a violation (self-test of the patterns)', () => {
    const bad = [
      "const r = await fetch(url);", "const f = opts.fetch ?? fetch;", "const ws = new WebSocket(u);", "import https from 'node:https';",
      "const x = await fetchJson(url);", "const x = new XMLHttpRequest();", "const s = new EventSource(u);","import { WebSocket } from 'ws';", "const h = require('node:http2');", "const u = await import('undici');",
    ];
    for (const line of bad) expect(FORBIDDEN.some((f) => f.re.test(line)), line).toBe(true);
    const fine = ["await ctx.cachedFetch(key, url);", "fetchImpl: typeof fetch;", "this.opts.fetch", "doFetch(url)", "await fetchSpaceTrackGp(l, u, p)"];

    for (const line of fine) expect(FORBIDDEN.some((f) => f.re.test(stripOk(line))), line).toBe(false);
  });
});
