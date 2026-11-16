/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '../src/lib/browser-ui';
import { DEFAULT_SKIN, SKINS, SKIN_ATTR, SKIN_KEY, parseSkin, serialiseSkin } from '../src/lib/skin';
import { loadSkin } from '../src/state/skin';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const skinsCss = read('../src/skins.css');
const html = read('../index.html');

describe('parseSkin / serialiseSkin', () => {
  it('knows the three skins, classic first and the default', () => {
    expect(SKINS.map((s) => s.id)).toEqual(['classic', 'terminal', 'mission']);
    expect(DEFAULT_SKIN).toBe('classic');
    for (const s of SKINS) { expect(s.label.length).toBeGreaterThan(0); expect(s.hint.length).toBeGreaterThan(0); }
  });
  it('round-trips every skin', () => {
    for (const s of SKINS) expect(parseSkin(serialiseSkin(s.id))).toBe(s.id);
  });
  it('reads anything unknown as classic', () => {
    for (const v of [null, undefined, '', 'Terminal', 'TERMINAL', ' mission', 'space', 'null', '1', 0, {}, []]) expect(parseSkin(v), String(v)).toBe('classic');
  });
});

describe('loadSkin', () => {
  it('reads the remembered skin from eio.skin', () => {
    expect(SKIN_KEY).toBe('eio.skin');
    expect(loadSkin({ getItem: (k) => (k === 'eio.skin' ? 'terminal' : null) })).toBe('terminal');
    expect(loadSkin({ getItem: () => 'mission' })).toBe('mission');
  });
  it('is classic with nothing stored, junk stored, no storage or blocked storage', () => {
    expect(loadSkin({ getItem: () => null })).toBe('classic');
    expect(loadSkin({ getItem: () => 'neon' })).toBe('classic');
    expect(loadSkin(null)).toBe('classic');
    expect(loadSkin({ getItem: () => { throw new Error('blocked'); } })).toBe('classic');
  });
});

describe('index.html first-paint script', () => {
  it('uses the same key, attribute and skin ids as lib/skin.ts', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(script).toContain(`'${SKIN_KEY}'`);
    expect(script).toContain(`'${SKIN_ATTR}'`);
    for (const s of SKINS.filter((x) => x.id !== DEFAULT_SKIN)) expect(script, s.id).toContain(`'${s.id}'`);
    expect(script).toContain(`'${DEFAULT_SKIN}'`);
  });
});

/** The declaration blocks of skins.css for one skin's `:root[data-skin='...']` rule. */
function rootBlock(id: string): string {
  const m = new RegExp(`:root\\[data-skin='${id}'\\]\\s*\\{([^}]*)\\}`).exec(skinsCss);
  return m?.[1] ?? '';
}
const prop = (block: string, name: string) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1].toLowerCase();

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = (c: Rgb) => { const [r, g, b] = c.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: Rgb, b: Rgb) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

describe('skins.css', () => {
  const others = SKINS.filter((s) => s.id !== DEFAULT_SKIN);
  it('has a token block for every skin but classic, and none for classic', () => {
    for (const s of others) expect(rootBlock(s.id), s.id).not.toBe('');
    expect(skinsCss).not.toContain("data-skin='classic'");
  });
  it('shares the category colours and the feed states: no skin redefines them', () => {
    for (const s of others) {
      const b = rootBlock(s.id);
      expect(b, s.id).not.toMatch(/--c-[a-z-]+:/);
      for (const v of ['--ok', '--warn', '--bad', '--orange']) expect(b, `${s.id} ${v}`).not.toContain(`${v}:`);
    }
  });
  it('keeps the category colours readable (4.5:1) on every skin\'s scene and panels', () => {
    for (const s of others) {
      const b = rootBlock(s.id);
      const bg = prop(b, '--bg'), panel = prop(b, '--panel');
      expect(bg, `${s.id} --bg`).toBeDefined();
      expect(panel, `${s.id} --panel`).toBeDefined();
      for (const c of CATEGORIES) {
        expect(contrast(rgb(c.color), rgb(bg!)), `${c.id} on the ${s.id} scene`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(rgb(c.color), rgb(panel!)), `${c.id} on a ${s.id} panel`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('keeps text, engaged keys and secondary text legible on every skin', () => {
    for (const s of others) {
      const b = rootBlock(s.id);
      const panel = rgb(prop(b, '--panel')!);
      expect(contrast(rgb(prop(b, '--ink')!), panel), `${s.id} ink`).toBeGreaterThanOrEqual(7);
      expect(contrast(rgb(prop(b, '--ink-2')!), panel), `${s.id} ink-2`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(prop(b, '--ink-3')!), panel), `${s.id} ink-3`).toBeGreaterThanOrEqual(4.5);
      const on = prop(b, '--on-bg') ?? prop(b, '--sig');
      expect(on, `${s.id} engaged colour`).toBeDefined();
      expect(contrast(rgb(on!), rgb(prop(b, '--on-fg')!)), `${s.id} engaged key`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('skins.css motion and decoration', () => {
  const guard = /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\r?\n\}/g;
  it('runs every animation of the console skin only under prefers-reduced-motion: no-preference', () => {
    const guarded = (skinsCss.match(guard) ?? []).join('\n');
    expect(guarded).toContain('skin-roll');
    expect(guarded).toContain('skin-warm');
    // `animation:` may only appear inside the guarded blocks (keyframes are defined outside, never applied)
    const outside = skinsCss.replace(guard, '').replace(/@keyframes[^{]*\{(?:[^{}]|\{[^}]*\})*\}/g, '');
    expect(outside).not.toMatch(/\banimation:/);
  });
  it('paints the console with CSS only: nothing fetched, no font files, no category colour touched', () => {
    const mission = skinsCss.slice(skinsCss.indexOf('mission: navy and cream'));
    expect(mission).not.toMatch(/url\(\s*['"]?https?:/);
    expect(mission).not.toMatch(/@import|@font-face/);
    expect(mission).not.toMatch(/--c-[a-z-]+:/);
  });
  it('scopes every rule of the console section to the mission skin', () => {
    const consoleCss = skinsCss.slice(skinsCss.indexOf('the console: an early-1960s'));
    const selectors = consoleCss.split(/\r?\n/).filter((l) => /^[^\s@}/].*\{\s*$/.test(l) || /^\[data-skin.*\{.*\}\s*$/.test(l));
    expect(selectors.length).toBeGreaterThan(10);
    for (const l of selectors) expect(l, l).toMatch(/data-skin='mission'|^:root/);
  });
});
