/**
 * Live-edge logic for the YouTube strip's LIVE button. Pure, so it is tested without a player.
 *
 * From the IFrame API reference: `getDuration()` of a live event returns the elapsed time since the stream began, so at
 * the live head `currentTime` is about equal to `duration`, and behind it (DVR) `currentTime` is smaller. `seekTo(seconds,
 * allowSeekAhead)` with a time past the end of a live stream lands on the live head (the usual way to "go live" from the
 * API; not documented as a guarantee, so the button re-reads the state from the next infoDelivery instead of assuming).
 */

/** Seconds behind the head that still count as "at live": infoDelivery arrives about twice a second and the head moves. */
export const LIVE_EDGE_TOLERANCE_S = 6;

/** The time sent to `seekTo` to reach the live head: larger than any stream's elapsed time (about 31 years). */
export const LIVE_SEEK_SECONDS = 1e9;

export interface LiveState {
  /** from `videoData.isLive`; undefined when the player did not say */
  isLive?: boolean;
  currentTime?: number;
  duration?: number;
  /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued */
  playerState?: number;
}

export type LiveStatus = 'hidden' | 'live' | 'behind';

/**
 * `hint` is what the link itself says (a channel `/live` embed is live by construction); the player's own `isLive` wins.
 * - hidden: not a live stream (no button)
 * - live: playing at the live head (filled red dot)
 * - behind: live, but paused, ended, not started, or behind the head (grey dot; a click jumps to live)
 */
export function liveStatus(s: LiveState, hint = false, tolerance = LIVE_EDGE_TOLERANCE_S): LiveStatus {
  const live = s.isLive ?? hint;
  if (!live) return 'hidden';
  const playing = s.playerState === 1 || s.playerState === 3;
  const { currentTime: t, duration: d } = s;
  // without a time pair there is no evidence of being behind: trust a playing stream
  const behind = typeof t === 'number' && typeof d === 'number' && d > 0 && d - t > tolerance;
  return playing && !behind ? 'live' : 'behind';
}
