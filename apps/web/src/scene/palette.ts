import * as THREE from 'three';
import type { ColorKey } from '../lib/entity';

export interface Palette {
  colors: Record<ColorKey, THREE.Color>;
  accent: THREE.Color;
  bg: THREE.Color;
}

const FALLBACK: Record<ColorKey | 'accent' | 'bg', string> = {
  station: '#ffc857', satellite: '#7fb7e6', starlink: '#5c7088', probe: '#c58af9', vehicle: '#ff7a59',
  ground: '#58c28b', debris: '#9a6464', rover: '#e0a43a', aircraft: '#9ad1d4', body: '#e8eef5', navigation: '#e66aa8', accent: '#4fb3d9', bg: '#05080c',
};

/** Resolve the CSS custom properties (`--c-station` ...) so the scene follows the page theme. */
export function readPalette(el: Element = document.documentElement): Palette {
  const css = getComputedStyle(el);
  const get = (name: string, key: keyof typeof FALLBACK) => new THREE.Color(css.getPropertyValue(name).trim() || FALLBACK[key]);
  const colors = {} as Record<ColorKey, THREE.Color>;
  for (const k of Object.keys(FALLBACK) as (keyof typeof FALLBACK)[]) {
    if (k !== 'accent' && k !== 'bg') colors[k] = get(`--c-${k}`, k);
  }
  return { colors, accent: get('--accent', 'accent'), bg: get('--bg', 'bg') };
}

/** Point size in CSS pixels per colour key. */
export const POINT_SIZE: Record<ColorKey, number> = {
  station: 10, satellite: 3.6, starlink: 2.6, probe: 9, vehicle: 9, ground: 8, debris: 2.8, rover: 8, aircraft: 7, body: 10, navigation: 5,
};

export const GLYPH_ID = { dot: 0, diamond: 1, ring: 2, triangle: 3, square: 4 } as const;
