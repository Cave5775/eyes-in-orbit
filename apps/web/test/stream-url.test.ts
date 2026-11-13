import { describe, expect, it } from 'vitest';
import { embedFor, parseWebUrl, providerOfEmbed, safeHref, watchResult } from '../src/lib/stream-url';

const ORIGIN = 'http://localhost:5202';

describe('embedFor: YouTube', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ?feature=share',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'youtube.com/watch?v=dQw4w9WgXcQ',
  ])('%s', (u) => {
    const e = embedFor(u, ORIGIN);
    expect(e?.provider).toBe('youtube');
    expect(e?.embedUrl).toMatch(/^https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ\?/);
  });
  it('maps a channel live link to the live_stream embed', () => {
    expect(embedFor('https://www.youtube.com/channel/UCabc123/live', ORIGIN)?.embedUrl).toMatch(/embed\/live_stream\?.*channel=UCabc123/);
  });
});

describe('embedFor: Twitch', () => {
  it('channel', () => {
    const e = embedFor('https://www.twitch.tv/NASA', 'https://eio.example.org')!;
    expect(e.provider).toBe('twitch');
    const u = new URL(e.embedUrl);
    expect(u.origin + u.pathname).toBe('https://player.twitch.tv/');
    expect(u.searchParams.get('channel')).toBe('nasa');
    expect(u.searchParams.get('parent')).toBe('eio.example.org');
  });
  it('video, with a localhost parent when the origin is unknown', () => {
    const u = new URL(embedFor('https://twitch.tv/videos/123456789')!.embedUrl);
    expect(u.searchParams.get('video')).toBe('v123456789');
    expect(u.searchParams.get('parent')).toBe('localhost');
  });
  it('rejects non-channel pages', () => {
    for (const p of ['directory', 'videos', 'settings', 'nasa/about', '']) expect(embedFor(`https://twitch.tv/${p}`)).toBeNull();
  });
});

describe('embedFor: Vimeo', () => {
  it.each([
    'https://vimeo.com/123456789',
    'https://vimeo.com/channels/staffpicks/123456789',
    'https://player.vimeo.com/video/123456789?h=abc',
  ])('%s', (u) => {
    const e = embedFor(u);
    expect(e?.provider).toBe('vimeo');
    expect(e?.embedUrl).toMatch(/^https:\/\/player\.vimeo\.com\/video\/123456789\?/);
  });
  it('rejects pages without a numeric id', () => {
    expect(embedFor('https://vimeo.com/features')).toBeNull();
    expect(embedFor('https://player.vimeo.com/video/abc')).toBeNull();
  });
});

describe('embedFor: direct video', () => {
  it.each(['https://cdn.example.com/live/a.m3u8', 'http://example.com/clip.MP4?token=1', 'https://example.com/v/x.webm'])('%s', (u) => {
    const e = embedFor(u);
    expect(e?.provider).toBe('video');
    expect(e?.embedUrl).toBe(new URL(u).href);
  });
  it('rejects other files', () => {
    expect(embedFor('https://example.com/page.html')).toBeNull();
    expect(embedFor('https://example.com/a.mp4.exe')).toBeNull();
  });
});

describe('embedFor: rejected input', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ',
    'data:text/html,hello',
    'file:///etc/passwd.mp4',
    'ftp://example.com/a.mp4',
    'https://user:pw@example.com/a.mp4',
    'https://evil.example/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://notvimeo.com/123456789',
    '',
    '   ',
    'not a url',
  ])('%j', (u) => {
    expect(embedFor(u, ORIGIN)).toBeNull();
  });
});

describe('parseWebUrl and safeHref', () => {
  it('adds https to a bare host and refuses other schemes', () => {
    expect(parseWebUrl('example.com/a')?.href).toBe('https://example.com/a');
    expect(parseWebUrl('localhost:8080/a.mp4')?.href).toBe('https://localhost:8080/a.mp4');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://example.com/x')).toBe('https://example.com/x');
  });
});

describe('providerOfEmbed', () => {
  it('accepts what embedFor produces and nothing else', () => {
    for (const u of ['https://youtu.be/dQw4w9WgXcQ', 'https://twitch.tv/nasa', 'https://vimeo.com/123456789', 'https://a.example/b.mp4']) {
      const e = embedFor(u, ORIGIN)!;
      expect(providerOfEmbed(e.embedUrl)).toBe(e.provider);
    }
    for (const u of ['javascript:alert(1)', 'https://evil.example/embed/x', 'https://www.youtube.com/embed/', 'https://player.twitch.tv/', 'https://player.vimeo.com/video/x', 'https://www.nasa.gov/nasalive', 'nope']) {
      expect(providerOfEmbed(u)).toBeNull();
    }
  });
});

describe('watchResult', () => {
  it('returns the embed for a supported link', () => {
    const r = watchResult('https://vimeo.com/123456789');
    expect(r.ok && r.embed.provider).toBe('vimeo');
  });
  it('explains an unsupported link and offers it as a link only when it is a web URL', () => {
    const page = watchResult('https://www.nasa.gov/nasalive');
    expect(page).toMatchObject({ ok: false, href: 'https://www.nasa.gov/nasalive' });
    expect(!page.ok && page.error).toMatch(/YouTube, Twitch, Vimeo/);
    expect(watchResult('javascript:alert(1)')).toMatchObject({ ok: false, href: null });
    expect(watchResult('  ')).toMatchObject({ ok: false, href: null });
  });
});
