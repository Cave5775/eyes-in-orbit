import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { USER_AGENT } from './http';

/**
 * Earth imagery tiles for the close-up detail layer: NASA GIBS "Blue Marble: shaded relief and bathymetry" (the same look
 * as the base map, 500 m per pixel at best), fetched through the local server so the browser never talks to NASA, the
 * tiles are cached on disk and OFFLINE=1 is honoured. The grid is plain equirectangular squares: level z has tiles
 * 180 / 2^z degrees on a side (2^(z+1) across, 2^z down, row 0 at the north pole), each 512 x 512 pixels.
 */

export const IMAGERY_LAYER = 'BlueMarble_ShadedRelief_Bathymetry';
export const IMAGERY_MIN_Z = 3;
/** 0.61 km per pixel; the layer's own resolution is about 0.5 km, so deeper levels would only be upscaled */
export const IMAGERY_MAX_Z = 6;
export const TILE_PX = 512;
const GIBS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';

export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** A valid tile id from request strings, or null. */
export function parseTile(z: unknown, x: unknown, y: unknown): TileId | null {
  const [nz, nx, ny] = [z, x, y].map((v) => (typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : typeof v === 'number' ? v : NaN));
  if (![nz, nx, ny].every(Number.isInteger)) return null;
  if (nz < IMAGERY_MIN_Z || nz > IMAGERY_MAX_Z) return null;
  if (nx < 0 || nx >= 2 ** (nz + 1) || ny < 0 || ny >= 2 ** nz) return null;
  return { z: nz, x: nx, y: ny };
}

/** [west, south, east, north] in degrees. */
export function tileBbox({ z, x, y }: TileId): [number, number, number, number] {
  const s = 180 / 2 ** z;
  return [-180 + x * s, 90 - (y + 1) * s, -180 + (x + 1) * s, 90 - y * s];
}

export function tileUrl(id: TileId): string {
  const q = new URLSearchParams({
    SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.1.1', LAYERS: IMAGERY_LAYER, STYLES: '', FORMAT: 'image/jpeg',
    SRS: 'EPSG:4326', WIDTH: String(TILE_PX), HEIGHT: String(TILE_PX), BBOX: tileBbox(id).join(','),
  });
  return `${GIBS}?${q.toString()}`;
}

const isJpeg = (b: Buffer): boolean => b.length > 1024 && b[0] === 0xff && b[1] === 0xd8;

export interface ImageryOptions {
  offline?: boolean;
  fetch?: typeof fetch;
  /** disk cache cap, bytes */
  maxBytes?: number;
  /** simultaneous requests to NASA */
  concurrency?: number;
  timeoutMs?: number;
}

export class ImageryCache {
  private inflight = new Map<string, Promise<Buffer>>();
  private active = 0;
  private waiting: (() => void)[] = [];
  private bytes = -1;

  constructor(private dir: string, private opts: ImageryOptions = {}) {}

  get offline(): boolean {
    return !!this.opts.offline;
  }

  private file({ z, x, y }: TileId): string {
    return join(this.dir, IMAGERY_LAYER, String(z), String(x), `${y}.jpg`);
  }

  /** The tile's JPEG bytes from disk or NASA; null when OFFLINE=1 and it is not cached. Throws when the download fails. */
  async get(id: TileId): Promise<Buffer | null> {
    const path = this.file(id);
    if (existsSync(path)) {
      try {
        const now = new Date();
        utimesSync(path, now, now); // recently used survives eviction
        return readFileSync(path);
      } catch {
        /* unreadable: fall through and download again */
      }
    }
    if (this.opts.offline) return null;
    const pending = this.inflight.get(path);
    if (pending) return pending;
    const p = this.download(id, path).finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return p;
  }

  private async slot<T>(job: () => Promise<T>): Promise<T> {
    const max = this.opts.concurrency ?? 4;
    if (this.active >= max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private download(id: TileId, path: string): Promise<Buffer> {
    return this.slot(async () => {
      const res = await (this.opts.fetch ?? fetch)(tileUrl(id), {
        headers: { 'user-agent': USER_AGENT, accept: 'image/jpeg' },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from GIBS for tile ${id.z}/${id.x}/${id.y}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!isJpeg(buf)) throw new Error(`GIBS answered tile ${id.z}/${id.x}/${id.y} with something that is not a JPEG (${res.headers.get('content-type') ?? 'no type'}, ${buf.length} bytes)`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, buf);
      this.account(buf.length);
      return buf;
    });
  }

  /** Track the cache size and delete the least recently used tiles once it passes the cap. */
  private account(added: number): void {
    const cap = this.opts.maxBytes ?? 400 * 1024 * 1024;
    if (this.bytes < 0) this.bytes = this.scan().reduce((n, f) => n + f.size, 0);
    else this.bytes += added;
    if (this.bytes <= cap) return;
    const files = this.scan().sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files) {
      if (total <= cap * 0.9) break;
      try {
        unlinkSync(f.path);
        total -= f.size;
      } catch {
        /* already gone */
      }
    }
    this.bytes = total;
  }

  private scan(): { path: string; size: number; mtime: number }[] {
    const out: { path: string; size: number; mtime: number }[] = [];
    const walk = (dir: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const p = join(dir, n);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (n.endsWith('.jpg')) out.push({ path: p, size: st.size, mtime: st.mtimeMs });
      }
    };
    walk(join(this.dir, IMAGERY_LAYER));
    return out;
  }
}
