import { describe, expect, it } from 'vitest';
import { parseWidgetMessage, resolveStream, toEmbedUrl, widgetCommand, widgetListen, youtubeVideoId } from '../src/lib/youtube';

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

  it('builds a muted autoplay embed URL with the quiet parameters', () => {
    const url = toEmbedUrl(`https://www.youtube.com/watch?v=${ID}`)!;
    expect(url.startsWith(`https://www.youtube.com/embed/${ID}?`)).toBe(true);
    const p = new URL(url).searchParams;
    expect(p.get('autoplay')).toBe('1');
    expect(p.get('mute')).toBe('1');
    expect(p.get('controls')).toBe('0');
    expect(p.get('rel')).toBe('0');
    expect(p.get('modestbranding')).toBe('1');
    expect(p.get('iv_load_policy')).toBe('3');
    expect(p.get('disablekb')).toBe('1');
    expect(p.get('fs')).toBe('1');
    expect(p.get('playsinline')).toBe('1');
    expect(p.get('enablejsapi')).toBe('1');
    // no origin outside the browser: the parameter is only added when the page supplies one
    expect(p.has('origin')).toBe(false);
  });

  it('adds the page origin when given, and ignores anything that is not an http(s) origin', () => {
    const url = toEmbedUrl(`https://youtu.be/${ID}`, 'http://localhost:5194')!;
    expect(new URL(url).searchParams.get('origin')).toBe('http://localhost:5194');
    expect(toEmbedUrl(`https://youtu.be/${ID}`, 'null')).not.toContain('origin=');
  });

  it('resolves a channel /live link to the live_stream embed', () => {
    const url = toEmbedUrl('https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/live', 'http://localhost:5194')!;
    expect(url).toContain('/embed/live_stream?');
    const p = new URL(url).searchParams;
    expect(p.get('channel')).toBe('UCLA_DiR1FfKNvjuUpBHmylQ');
    expect(p.get('controls')).toBe('0');
    expect(p.get('origin')).toBe('http://localhost:5194');
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

describe('youtube player messages', () => {
  it('builds the postMessage commands and listen request', () => {
    expect(JSON.parse(widgetCommand('pauseVideo'))).toEqual({ event: 'command', func: 'pauseVideo', args: [] });
    expect(JSON.parse(widgetCommand('unMute')).func).toBe('unMute');
    const listen = JSON.parse(widgetListen());
    expect(listen).toMatchObject({ event: 'listening', channel: 'widget' });
  });

  it('reads play state and mute from player messages, as objects or JSON strings', () => {
    const msg = { event: 'infoDelivery', id: 1, channel: 'widget', info: { playerState: 1, muted: false } };
    expect(parseWidgetMessage(msg)).toEqual({ playerState: 1, muted: false });
    expect(parseWidgetMessage(JSON.stringify(msg))).toEqual({ playerState: 1, muted: false });
    expect(parseWidgetMessage({ event: 'infoDelivery', info: { playerState: 2 } })).toEqual({ playerState: 2 });
  });

  it('ignores anything else', () => {
    expect(parseWidgetMessage('not json')).toBeNull();
    expect(parseWidgetMessage(null)).toBeNull();
    expect(parseWidgetMessage({ event: 'onReady' })).toBeNull();
    expect(parseWidgetMessage({ event: 'infoDelivery', info: 'x' })).toBeNull();
    expect(parseWidgetMessage({ event: 'infoDelivery', info: { playerState: 'x', muted: 'no' } })).toEqual({});
  });
});
