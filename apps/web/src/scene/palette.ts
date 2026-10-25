import * as THREE from 'three';
import { CATEGORIES } from '../lib/browser-ui';
import type { ColorKey } from '../lib/entity';

export interface Palette {
  colors: Record<ColorKey, THREE.Color>;
  accent: THREE.Color;
  bg: THREE.Color;
}

/** The nine category colours (`CATEGORIES` in browser-ui.ts, the same values as `--c-<category>` in styles.css) and the page's accent and background. */
const FALLBACK: Record<ColorKey | 'accent' | 'bg', string> = {
  ...(Object.fromEntries(CATEGORIES.map((c) => [c.id, c.color])) as Record<ColorKey, string>),
  accent: '#4fb3d9', bg: '#05080c',
};

/** Resolve the CSS custom properties (`--c-satellites` ...) so the scene follows the page theme. */
export function readPalette(el: Element = document.documentElement): Palette {
  const css = getComputedStyle(el);
  const get = (name: string, key: keyof typeof FALLBACK) => new THREE.Color(css.getPropertyValue(name).trim() || FALLBACK[key]);
  const colors = {} as Record<ColorKey, THREE.Color>;
  for (const c of CATEGORIES) colors[c.id] = get(`--c-${c.id}`, c.id);
  return { colors, accent: get('--accent', 'accent'), bg: get('--bg', 'bg') };
}

/** Point size in CSS pixels per category (the colour key). */
export const POINT_SIZE: Record<ColorKey, number> = {
  stations: 10, satellites: 3.6, navigation: 5, probes: 9, 'launch-vehicles': 9, ground: 8, debris: 2.8, bodies: 10, other: 7,
};

export const GLYPH_ID = { dot: 0, diamond: 1, ring: 2, triangle: 3, square: 4 } as const;
