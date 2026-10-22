import { describe, expect, it } from 'vitest';
import { resolveStream, toEmbedUrl, youtubeVideoId } from '../src/lib/youtube';

const ID = 'dQw4w9WgXcQ';

describe('youtube embed conversion', () => {
  it('extracts ids from every common URL shape', () => {
    expect(youtubeVideoId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://youtube.com/watch?v=${ID}&t=42s&feature=share`)).toBe(ID);
    expect(youtubeVideoId(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://youtu.be/${ID}?si=abc`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/live/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube-nocookie.com/embed/${ID}`)).toBe(ID);
  });

  it('builds a muted autoplay embed URL', () => {
    const url = toEmbedUrl(`https://www.youtube.com/watch?v=${ID}`)!;
    expect(url.startsWith(`https://www.youtube.com/embed/${ID}?`)).toBe(true);
    expect(url).toContain('autoplay=1');
    expect(url).toContain('mute=1');
  });

  it('resolves a channel /live link to the live_stream embed', () => {
    expect(toEmbedUrl('https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/live')).toContain('/embed/live_stream?channel=UCLA_DiR1FfKNvjuUpBHmylQ');
  });

  it('rejects non-YouTube and malformed input', () => {
    expect(toEmbedUrl('https://www.nasa.gov/nasalive')).toBeNull();
    expect(toEmbedUrl('https://x.com/SpaceX/status/1')).toBeNull();
    expect(toEmbedUrl('https://evil.example/watch?v=' + ID)).toBeNull();
    expect(toEmbedUrl('not a url')).toBeNull();
    expect(youtubeVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(youtubeVideoId('https://www.youtube.com/watch')).toBeNull();
  });

  it('only embeds YouTube-backed links and falls back to link-out otherwise', () => {
    expect(resolveStream({ title: 't', url: `https://youtu.be/${ID}`, kind: 'youtube' }).embedUrl).toContain('/embed/');
    const nasa = resolveStream({ title: 'NASA TV', url: 'https://www.nasa.gov/nasalive', kind: 'nasa-tv' });
    expect(nasa.embedUrl).toBeNull();
    expect(nasa.href).toBe('https://www.nasa.gov/nasalive');
    expect(resolveStream({ title: 'x', url: 'https://x.com/a', kind: 'x' }).embedUrl).toBeNull();
    // a mislabelled YouTube URL on a nasa-tv link is not embedded
    expect(resolveStream({ title: 'm', url: `https://youtu.be/${ID}`, kind: 'nasa-tv' }).embedUrl).toBeNull();
  });
});
