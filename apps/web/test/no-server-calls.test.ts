import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });

/** The text with comments blanked out (a comment may still say what the old server did). Strings are kept: that is where an address lives. */
function withoutComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      out += text.slice(i, end < 0 ? text.length : end + 2).replace(/[^\n]/g, ' ');
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out;
}

describe('the app no longer talks to the old server', () => {
  const files = walk(SRC).filter((f) => !/[\/]mock[\/]/.test(f));

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each([
    ['an /api/ address', /['"`]\/api\//],
    ['the /stream WebSocket address', /\/stream\b(?!-)/],
    ['a WebSocket to its own host', /new WebSocket\(\s*`\$\{/],
  ])('has no code reaching for %s', (_what, re) => {
    const hits = files.filter((f) => re.test(withoutComments(readFileSync(f, 'utf8')))).map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });
});
