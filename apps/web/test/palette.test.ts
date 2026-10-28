/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, categoryOf } from '../src/lib/browser-ui';
import { colorKeyOf } from '../src/lib/entity';
import { POINT_SIZE } from '../src/scene/palette';


// The colour of an object is its category: nine colours that stay apart on the dark scene and for the common colour-vision deficiencies.

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const cssVar = (name: string): string | undefined => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1].toLowerCase();

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v: number) => { const c = Math.min(1, Math.max(0, v)); return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055; };
const luminance = (c: Rgb) => { const [r, g, b] = c.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** WCAG contrast ratio */
const contrast = (a: Rgb, b: Rgb) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function lab(c: Rgb): Rgb {
  const [r, g, b] = c.map(lin);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047, y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b, z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
/** CIE76 colour difference; about 15 or more is clearly two colours, even for small dots */
const dE = (a: Rgb, b: Rgb) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
/** Machado, Oliveira, Fernandes (2009), full severity, on linear RGB */
const CVD: Record<string, number[][]> = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const simulate = (c: Rgb, m: number[][]): Rgb => { const l = c.map(lin); return m.map((row) => gam(row[0] * l[0] + row[1] * l[1] + row[2] * l[2])) as Rgb; };

describe('category colours', () => {
  it('has nine distinct colours, one per category, and styles.css agrees with them', () => {
    expect(CATEGORIES).toHaveLength(9);
    expect(new Set(CATEGORIES.map((c) => c.color)).size).toBe(9);
    for (const c of CATEGORIES) {
      expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(cssVar(`--c-${c.id}`), `--c-${c.id}`).toBe(c.color);
    }
  });
  it('has no per-constellation or per-kind colour left in the stylesheet', () => {
    const vars = [...css.matchAll(/--c-([a-z-]+):/g)].map((m) => m[1]).sort();
    expect(vars).toEqual(CATEGORIES.map((c) => c.id).sort());
    expect(css).not.toMatch(/--c-starlink|--c-satellite\b|--c-station\b|--c-probe\b|--c-vehicle\b|--c-rover|--c-aircraft/);
  });
  it('stays readable on the dark scene and its panels (WCAG contrast of at least 4.5)', () => {
    const bg = rgb(cssVar('--bg')!), panel = rgb(cssVar('--panel')!);
    for (const c of CATEGORIES) {
      expect(contrast(rgb(c.color), bg), `${c.id} on the scene`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(c.color), panel), `${c.id} on a panel`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('keeps every pair apart under normal, protan, deutan and tritan vision', () => {
    for (const [vision, m] of Object.entries(CVD)) {
      const seen = CATEGORIES.map((c) => ({ id: c.id, rgb: simulate(rgb(c.color), m) }));
      for (let i = 0; i < seen.length; i++) for (let j = i + 1; j < seen.length; j++) {
        expect(dE(seen[i].rgb, seen[j].rgb), `${seen[i].id} / ${seen[j].id} (${vision})`).toBeGreaterThanOrEqual(15);
      }
    }
  });
  it('has a point size for every category', () => {
    for (const c of CATEGORIES) expect(POINT_SIZE[c.id], c.id).toBeGreaterThan(0);
    expect(Object.keys(POINT_SIZE).sort()).toEqual(CATEGORIES.map((c) => c.id).sort());
  });
});

describe('colorKeyOf is the category', () => {
  const rec = (kind: string, group?: string, colorKey?: string) => ({ kind, group, aliases: {}, render: colorKey ? { colorKey: colorKey as 'starlink' } : undefined });
  it('is categoryOf, so a list dot, a point and a legend entry agree', () => {
    for (const r of [rec('satellite', 'starlink', 'starlink'), rec('station'), rec('debris'), rec('rover'), rec('pad'), rec('moon'), rec('weird'), rec('satellite', 'gps-ops')]) {
      expect(colorKeyOf(r)).toBe(categoryOf(r));
    }
  });
  it('colours Starlink like any other satellite (render.colorKey is advisory)', () => {
    expect(colorKeyOf(rec('satellite', 'starlink', 'starlink'))).toBe('satellites');
    expect(colorKeyOf(rec('satellite', 'starlink'))).toBe('satellites');
    expect(colorKeyOf(rec('satellite', 'active', 'satellite'))).toBe('satellites');
  });
  it('maps the other kinds to their category colour', () => {
    expect(colorKeyOf(rec('station', 'stations', 'station'))).toBe('stations');
    expect(colorKeyOf(rec('satellite', 'gps-ops', 'navigation'))).toBe('navigation');
    expect(colorKeyOf(rec('probe'))).toBe('probes');
    expect(colorKeyOf(rec('rover', undefined, 'rover'))).toBe('probes');
    expect(colorKeyOf(rec('launch_vehicle', 'launch', 'vehicle'))).toBe('launch-vehicles');
    expect(colorKeyOf(rec('debris'))).toBe('debris');
    expect(colorKeyOf(rec('ground_station'))).toBe('ground');
    expect(colorKeyOf(rec('planet', 'bodies', 'body'))).toBe('bodies');
    expect(colorKeyOf(rec('drone', undefined, 'aircraft'))).toBe('other');
    expect(colorKeyOf(rec('weird'))).toBe('other');
  });
});
