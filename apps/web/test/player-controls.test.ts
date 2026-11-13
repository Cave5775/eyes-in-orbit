import { describe, expect, it } from 'vitest';
import { toEmbedUrl, withNativeControls } from '../src/lib/youtube';
import { parseNativeControls } from '../src/state/player';

const ID = 'dQw4w9WgXcQ';

describe('withNativeControls', () => {
  const embed = toEmbedUrl(`https://www.youtube.com/watch?v=${ID}`, 'http://localhost:5173')!;

  it('turns YouTube\'s own controls and keyboard on, keeping the rest', () => {
    const on = new URL(withNativeControls(embed, true));
    expect(on.searchParams.get('controls')).toBe('1');
    expect(on.searchParams.get('disablekb')).toBe('0');
    expect(on.searchParams.get('enablejsapi')).toBe('1');
    expect(on.searchParams.get('origin')).toBe('http://localhost:5173');
    expect(on.pathname).toBe(`/embed/${ID}`);
  });

  it('off gives back the default embed parameters', () => {
    const off = new URL(withNativeControls(withNativeControls(embed, true), false));
    expect(off.searchParams.get('controls')).toBe('0');
    expect(off.searchParams.get('disablekb')).toBe('1');
    expect(withNativeControls(embed, false)).toBe(new URL(embed).toString());
  });

  it('works for live channel embeds', () => {
    const live = toEmbedUrl('https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/live')!;
    expect(new URL(withNativeControls(live, true)).searchParams.get('controls')).toBe('1');
  });

  it('leaves non-YouTube and malformed URLs alone', () => {
    for (const u of ['https://player.vimeo.com/video/1?autoplay=1', 'https://player.twitch.tv/?channel=x&parent=localhost', 'https://www.youtube.com/watch?v=x', 'not a url']) {
      expect(withNativeControls(u, true)).toBe(u);
    }
  });
});

describe('player controls preference', () => {
  it('reads only an explicit true', () => {
    expect(parseNativeControls(JSON.stringify({ nativeControls: true }))).toBe(true);
    expect(parseNativeControls(JSON.stringify({ nativeControls: false }))).toBe(false);
    expect(parseNativeControls(JSON.stringify({ nativeControls: 'yes' }))).toBe(false);
    expect(parseNativeControls('{bad')).toBe(false);
    expect(parseNativeControls(null)).toBe(false);
    expect(parseNativeControls('[]')).toBe(false);
  });
});
