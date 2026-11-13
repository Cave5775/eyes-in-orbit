import { describe, expect, it } from 'vitest';
import { LIVE_EDGE_TOLERANCE_S, LIVE_SEEK_SECONDS, liveStatus } from '../src/lib/live';
import { isLiveChannelEmbed, parseWidgetMessage, toEmbedUrl, widgetCommand, withNativeControls, withStart } from '../src/lib/youtube';

const ID = 'dQw4w9WgXcQ';

// Shaped like an infoDelivery from the IFrame API's postMessage channel. The field names currentTime, duration, playerState,
// volume, muted come from the API reference (getCurrentTime, getDuration, getPlayerState, getVolume, isMuted); that they
// arrive in infoDelivery, and that videoData carries isLive (getVideoData), is assumed, not captured from a live player.
const liveDelivery = (currentTime: number, duration: number, playerState = 1) => ({
  event: 'infoDelivery',
  id: 1,
  channel: 'widget',
  info: { playerState, currentTime, duration, volume: 100, muted: true, videoData: { video_id: ID, author: 'x', title: 'y', isLive: true } },
});

describe('parseWidgetMessage live fields', () => {
  it('reads currentTime, duration and videoData.isLive', () => {
    expect(parseWidgetMessage(liveDelivery(3601.4, 3604.9))).toEqual({
      playerState: 1, currentTime: 3601.4, duration: 3604.9, volume: 100, muted: true, isLive: true,
    });
    expect(parseWidgetMessage(JSON.stringify(liveDelivery(1, 2)))?.isLive).toBe(true);
  });

  it('reads a non-live video and ignores bad values', () => {
    const info = parseWidgetMessage({ event: 'infoDelivery', info: { currentTime: 12.5, duration: 212, videoData: { isLive: false } } });
    expect(info).toEqual({ currentTime: 12.5, duration: 212, isLive: false });
    expect(parseWidgetMessage({ event: 'infoDelivery', info: { currentTime: -1, duration: 'x', videoData: 'y' } })).toEqual({});
    expect(parseWidgetMessage({ event: 'infoDelivery', info: { videoData: { isLive: 'yes' } } })).toEqual({});
  });
});

describe('liveStatus', () => {
  it('is live when playing at the head, within the tolerance', () => {
    expect(liveStatus({ isLive: true, playerState: 1, currentTime: 3600, duration: 3602 })).toBe('live');
    expect(liveStatus({ isLive: true, playerState: 3, currentTime: 3600, duration: 3600 + LIVE_EDGE_TOLERANCE_S })).toBe('live');
  });

  it('is behind when further back, paused, ended or not started', () => {
    expect(liveStatus({ isLive: true, playerState: 1, currentTime: 3000, duration: 3600 })).toBe('behind');
    expect(liveStatus({ isLive: true, playerState: 1, currentTime: 3600, duration: 3600 + LIVE_EDGE_TOLERANCE_S + 1 })).toBe('behind');
    expect(liveStatus({ isLive: true, playerState: 2, currentTime: 3600, duration: 3600 })).toBe('behind');
    expect(liveStatus({ isLive: true, playerState: 0 })).toBe('behind');
    expect(liveStatus({ isLive: true })).toBe('behind');
  });

  it('trusts a playing live stream that reports no times', () => {
    expect(liveStatus({ isLive: true, playerState: 1 })).toBe('live');
    expect(liveStatus({ isLive: true, playerState: 1, currentTime: 5, duration: 0 })).toBe('live');
  });

  it('is hidden for a video that is not live, and the player outranks the link hint', () => {
    expect(liveStatus({ isLive: false, playerState: 1, currentTime: 10, duration: 200 })).toBe('hidden');
    expect(liveStatus({ playerState: 1 })).toBe('hidden');
    expect(liveStatus({ playerState: 1 }, true)).toBe('live');
    expect(liveStatus({ isLive: false, playerState: 1 }, true)).toBe('hidden');
  });

  it('jumps with a seekTo far past any stream length', () => {
    const cmd = JSON.parse(widgetCommand('seekTo', [LIVE_SEEK_SECONDS, true]));
    expect(cmd).toEqual({ event: 'command', func: 'seekTo', args: [1e9, true] });
  });
});

describe('withStart and the live channel hint', () => {
  const embed = toEmbedUrl(`https://www.youtube.com/watch?v=${ID}`, 'http://localhost:5173')!;

  it('resumes a reload at the whole second, keeping the controls choice and the other parameters', () => {
    const u = new URL(withStart(withNativeControls(embed, true), 125.9));
    expect(u.searchParams.get('start')).toBe('125');
    expect(u.searchParams.get('controls')).toBe('1');
    expect(u.searchParams.get('enablejsapi')).toBe('1');
    expect(u.pathname).toBe(`/embed/${ID}`);
  });

  it('leaves the URL alone for no position, under a second, bad values, channel embeds and other hosts', () => {
    for (const s of [undefined, 0, 0.4, NaN, Infinity]) expect(withStart(embed, s)).toBe(embed);
    const channel = toEmbedUrl('https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/live')!;
    expect(withStart(channel, 300)).toBe(channel);
    expect(withStart('https://player.vimeo.com/video/1', 30)).toBe('https://player.vimeo.com/video/1');
    expect(withStart('not a url', 30)).toBe('not a url');
  });

  it('knows a channel live embed', () => {
    expect(isLiveChannelEmbed(toEmbedUrl('https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/live')!)).toBe(true);
    expect(isLiveChannelEmbed(embed)).toBe(false);
    expect(isLiveChannelEmbed('nope')).toBe(false);
  });
});
