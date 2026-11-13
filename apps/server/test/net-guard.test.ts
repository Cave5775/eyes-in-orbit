import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The single choke point: outgoing requests (`fetch(`, `new WebSocket`, a raw http client) live in apps/server/src/net only, so
 * every one passes the request limiter. A new data source that fetches somewhere else fails here.
 */
const ROOT = resolve(__dirname, '../../..');
const SCAN = ['apps/server/src', 'scripts'];

/** Files outside `net/` that may call the network directly, with the reason. Keep this list short. */
const ALLOW: Record<string, string> = {
  'scripts/fetch-assets.mjs': 'manual, run-once download of three static textures (npm run assets); not a data feed',
};

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'fetch(', re: /(^|[^\w.$])fetch\s*\(/ },
  { name: '.fetch(', re: /\b(globalThis|window|global)\.fetch\s*\(/ },
  { name: '?? fetch (a default fetch)', re: /\?\?\s*fetch\b/ },
  { name: 'new WebSocket', re: /\bnew\s+WebSocket\b/ },
  { name: 'a raw http client import', re: /from\s+['"](node:)?(https?|undici|axios|node-fetch|got)['"]/ },
];

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
  it('no fetch( or new WebSocket outside apps/server/src/net and the allow-list', () => {
    const offenders: string[] = [];
    for (const base of SCAN) {
      for (const file of walk(join(ROOT, base))) {
        const rel = relative(ROOT, file).split(sep).join('/');
        if (rel.startsWith('apps/server/src/net/') || ALLOW[rel]) continue;
        codeLines(readFileSync(file, 'utf8')).forEach((line, i) => {
          for (const f of FORBIDDEN) if (f.re.test(line)) offenders.push(`${rel}:${i + 1} uses ${f.name}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the allow-list only names files that exist', () => {
    for (const rel of Object.keys(ALLOW)) expect(() => statSync(join(ROOT, rel))).not.toThrow();
  });

  it('the guard does catch a violation (self-test of the patterns)', () => {
    const bad = ["const r = await fetch(url);", "const f = opts.fetch ?? fetch;", "const ws = new WebSocket(u);", "import https from 'node:https';"];
    for (const line of bad) expect(FORBIDDEN.some((f) => f.re.test(line)), line).toBe(true);
    const fine = ["await ctx.cachedFetch(key, url);", "fetchImpl: typeof fetch;", "this.opts.fetch", "doFetch(url)"];
    for (const line of fine) expect(FORBIDDEN.some((f) => f.re.test(line)), line).toBe(false);
  });
});
