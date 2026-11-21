// Static file lookup for the built web app: correct MIME type, SPA fallback, no directory listing, no traversal.
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
};

export function mimeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export interface StaticHit {
  file: string;
  type: string;
  size: number;
  /** hashed build output may be cached for good; the entry page must be revalidated */
  immutable: boolean;
}

async function isFile(p: string): Promise<number | null> {
  try {
    const s = await stat(p);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/**
 * Maps a URL path to a file under `root`. Returns null for a missing asset (a path with an extension, 404). A path
 * without an extension that is not a file (a route of the single-page app, or a directory) gets index.html.
 */
export async function resolveStatic(root: string, urlPath: string): Promise<StaticHit | null> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  const rootAbs = resolve(root);
  const target = resolve(join(rootAbs, rel));
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null;

  const hit = async (file: string, size: number): Promise<StaticHit> => ({
    file,
    size,
    type: mimeOf(file),
    immutable: /[\\/]assets[\\/]/.test(file) && file !== join(rootAbs, 'index.html'),
  });

  const size = await isFile(target);
  if (size !== null) return hit(target, size);
  if (extname(target)) return null;
  const index = join(rootAbs, 'index.html');
  const isize = await isFile(index);
  return isize === null ? null : hit(index, isize);
}
