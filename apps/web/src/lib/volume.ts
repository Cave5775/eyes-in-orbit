/** Volume arithmetic for the video players' mute button: 10 bars, 10% per wheel tick, mute remembers the level. */
export const VOLUME_STEP = 10;
export const VOLUME_BARS = 10;

export interface VolumeState {
  /** 0-100, kept while muted so unmuting restores it */
  volume: number;
  muted: boolean;
}

export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}

/** Number of bars drawn light (0-10); a muted player shows none. */
export function barsLit(s: VolumeState): number {
  return s.muted ? 0 : Math.round(clampVolume(s.volume) / VOLUME_STEP);
}

/** One wheel tick. deltaY < 0 (wheel up) raises, > 0 lowers, 0 changes nothing. Raising a muted player unmutes it. */
export function wheelVolume(s: VolumeState, deltaY: number): VolumeState {
  const volume = clampVolume(s.volume);
  if (!deltaY || Number.isNaN(deltaY)) return { volume, muted: s.muted };
  if (deltaY < 0) {
    const next = clampVolume((Math.floor(volume / VOLUME_STEP) + 1) * VOLUME_STEP);
    return { volume: next, muted: false };
  }
  // lowering a muted player keeps it muted and lowers the remembered level
  const next = clampVolume((Math.ceil(volume / VOLUME_STEP) - 1) * VOLUME_STEP);
  return { volume: next, muted: s.muted };
}

/** Click: mute keeps the level; unmute restores it. Level 0 comes back as one tick, whether the click was on a muted or an unmuted player (never a click that changes nothing audible). */
export function toggleMute(s: VolumeState): VolumeState {
  const volume = clampVolume(s.volume);
  // already silent at level 0: a click raises it, there is nothing to mute
  if (!s.muted) return volume === 0 ? { volume: VOLUME_STEP, muted: false } : { volume, muted: true };
  return { volume: volume === 0 ? VOLUME_STEP : volume, muted: false };
}

/** Bar heights as fractions of the button height, shortest first. */
export function barHeights(n = VOLUME_BARS): number[] {
  return Array.from({ length: n }, (_, i) => (i + 1) / n);
}
