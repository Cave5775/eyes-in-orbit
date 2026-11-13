import { describe, expect, it } from 'vitest';
import {
  addRecent, loadRecent, MAX_RECENT, normaliseLink, parseRecent, recentTitle, removeRecent, RECENT_STORAGE_KEY, saveRecent, serialiseRecent,
} from '../src/lib/recent-links';

const YT = 'https://www.youtube.com/watch?v=abcdefghijk';

describe('recent links', () => {
  it('normalises: scheme added, host lower-cased, fragment dropped', () => {
    expect(normaliseLink('  YouTube.com/watch?v=abcdefghijk#t=5 ')).toBe('https://youtube.com/watch?v=abcdefghijk');
    expect(normaliseLink('javascript:alert(1)')).toBeNull();
    expect(normaliseLink('ftp://x.org/a.mp4')).toBeNull();
    expect(normaliseLink('')).toBeNull();
  });

  it('adds most recent first and de-duplicates by normalised link', () => {
    let l = addRecent([], YT, 'YouTube stream', 1);
    l = addRecent(l, 'https://twitch.tv/nasa', 'Twitch: nasa', 2);
    l = addRecent(l, `${YT}#t=9`, 'YouTube stream', 3);
    expect(l.map((e) => e.url)).toEqual([YT, 'https://twitch.tv/nasa']);
    expect(l[0].at).toBe(3);
  });

  it('ignores links that are not streams', () => {
    expect(addRecent([], 'https://example.com/page', 'x', 1)).toEqual([]);
  });

  it('caps the list', () => {
    let l: ReturnType<typeof addRecent> = [];
    for (let i = 0; i < MAX_RECENT + 5; i++) l = addRecent(l, `https://example.com/v${i}.mp4`, undefined, i);
    expect(l).toHaveLength(MAX_RECENT);
    expect(l[0].url).toContain(`v${MAX_RECENT + 4}`);
  });

  it('removes one entry', () => {
    const l = addRecent(addRecent([], YT, '', 1), 'https://twitch.tv/nasa', 'Twitch: nasa', 2);
    expect(removeRecent(l, YT).map((e) => e.url)).toEqual(['https://twitch.tv/nasa']);
    expect(removeRecent(l, 'https://nope.example/')).toHaveLength(2);
  });

  it('title falls back to host and path for the generic YouTube title', () => {
    expect(recentTitle('https://twitch.tv/nasa', 'Twitch: nasa')).toBe('Twitch: nasa');
    expect(recentTitle(YT, 'YouTube stream')).toBe('youtube.com/watch?v=abcdefghijk');
    expect(recentTitle('https://example.com/a/b.mp4')).toBe('example.com/a/b.mp4');
  });

  it('round-trips and survives corrupt data', () => {
    const l = addRecent(addRecent([], YT, 'YouTube stream', 1), 'https://twitch.tv/nasa', 'Twitch: nasa', 2);
    expect(parseRecent(serialiseRecent(l))).toEqual(l);
    expect(parseRecent('{nope')).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent(null)).toEqual([]);
  });

  it('drops stored entries the field would refuse', () => {
    const raw = JSON.stringify([
      { url: 'javascript:alert(1)', title: 'x', at: 5 },
      { url: 'https://example.com/page', title: 'x', at: 5 },
      { url: 3, title: 'x', at: 5 },
      null,
      { url: YT, title: 'ok', at: 'bad' },
    ]);
    expect(parseRecent(raw)).toEqual([{ url: YT, title: 'ok', at: 0 }]);
  });

  it('tolerates storage that is missing or throws', () => {
    expect(loadRecent(null)).toEqual([]);
    expect(saveRecent([], null)).toBe(false);
    const bad = { getItem(): string | null { throw new Error('x'); }, setItem(): void { throw new Error('x'); } };
    expect(loadRecent(bad)).toEqual([]);
    expect(saveRecent(addRecent([], YT, '', 1), bad)).toBe(false);
  });

  it('saves under the versioned key and removes it when empty', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    const l = addRecent([], YT, '', 1);
    expect(saveRecent(l, s)).toBe(true);
    expect(m.has(RECENT_STORAGE_KEY)).toBe(true);
    expect(loadRecent(s)).toEqual(l);
    saveRecent([], s);
    expect(m.has(RECENT_STORAGE_KEY)).toBe(false);
  });
});
