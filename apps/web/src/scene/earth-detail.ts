import * as THREE from 'three';
import {
  ATLAS, TILE_PX, detailLevel, nextWindow, windowBox, windowTiles, type DetailView, type DetailWindow,
} from '../lib/earth-detail';

/**
 * Streamed close-up Earth imagery. The base map is one 8192 px texture; when the camera is low enough that it would be
 * magnified, a window of 4 x 4 finer tiles (NASA GIBS Blue Marble through the local server's /api/imagery cache) is painted
 * into a 2048 px atlas that the Earth shader blends over the base map. Tiles that have not arrived are transparent, so the
 * base map shows through until they do; a server without the route (or offline with nothing cached) just leaves the base map.
 */

const MAX_IMAGES = 96;
const RETRY_FAILED_MS = 30_000;

interface Tile {
  state: 'loading' | 'ready' | 'failed';
  img: HTMLImageElement;
  at: number;
  used: number;
}

export interface DetailStats {
  z: number;
  ready: number;
  total: number;
}

export class EarthDetail {
  readonly texture: THREE.CanvasTexture;
  /** the atlas rectangle in the base map's uv, as the shader wants it */
  readonly box = new THREE.Vector4(0, 0, 1, 1);
  /** 1 while a window is active (the shader's uDetailOn) */
  on = 0;
  enabled = true;

  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly tiles = new Map<string, Tile>();
  private window: DetailWindow | null = null;
  private dirty = false;
  private disposed = false;

  constructor(maxAnisotropy = 8) {
    this.canvas.width = this.canvas.height = ATLAS * TILE_PX;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.premultiplyAlpha = true; // transparent holes must not bleed black into the filtered edge of a tile
    this.texture.anisotropy = maxAnisotropy;
  }

  /** What the HUD shows, or null while the layer is off. */
  get stats(): DetailStats | null {
    const w = this.window;
    if (!this.on || !w) return null;
    const tiles = windowTiles(w);
    return { z: w.z, ready: tiles.filter((t) => this.tiles.get(this.key(t))?.state === 'ready').length, total: tiles.length };
  }

  /** Feed the current view (null: not looking at the Earth). Cheap to call a few times a second. */
  update(view: DetailView | null, now = performance.now()): void {
    const z = this.enabled && view ? detailLevel(view) : null;
    if (z === null || !view) {
      this.on = 0;
      this.window = null;
      return;
    }
    const w = nextWindow(this.window, z, view.latDeg, view.lonDeg);
    if (w !== this.window) {
      this.window = w;
      this.box.set(...windowBox(w));
      this.dirty = true;
    }
    this.request(w, view, now);
    if (this.dirty) this.redraw(w);
    this.on = 1;
  }

  /** Start the tiles of the window that are missing, nearest to the view first. */
  private request(w: DetailWindow, view: DetailView, now: number): void {
    const s = 180 / 2 ** w.z;
    const cx = (view.lonDeg + 180) / s - 0.5, cy = (90 - view.latDeg) / s - 0.5;
    const wanted = windowTiles(w).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    for (const t of wanted) {
      const key = this.key(t);
      const have = this.tiles.get(key);
      if (have) {
        have.used = now;
        if (have.state !== 'failed' || now - have.at < RETRY_FAILED_MS) continue;
      }
      const img = new Image();
      const tile: Tile = { state: 'loading', img, at: now, used: now };
      this.tiles.set(key, tile);
      img.onload = () => {
        if (this.disposed) return;
        tile.state = 'ready';
        this.dirty = true;
      };
      img.onerror = () => {
        tile.state = 'failed';
        tile.at = performance.now();
      };
      img.src = `/api/imagery/${t.z}/${t.x}/${t.y}.jpg`;
    }
    this.evict(w);
  }

  private evict(w: DetailWindow): void {
    if (this.tiles.size <= MAX_IMAGES) return;
    const keep = new Set(windowTiles(w).map((t) => this.key(t)));
    const old = [...this.tiles.entries()].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].used - b[1].used);
    for (const [k] of old) {
      if (this.tiles.size <= MAX_IMAGES) break;
      this.tiles.delete(k);
    }
  }

  private redraw(w: DetailWindow): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const t of windowTiles(w)) {
      const tile = this.tiles.get(this.key(t));
      if (tile?.state === 'ready') ctx.drawImage(tile.img, t.px, t.py, TILE_PX, TILE_PX);
    }
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  private key(t: { z: number; x: number; y: number }): string {
    return `${t.z}/${t.x}/${t.y}`;
  }

  dispose(): void {
    this.disposed = true;
    this.texture.dispose();
    this.tiles.clear();
  }
}
