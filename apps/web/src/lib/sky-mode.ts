/**
 * The Sky view's phase machine (pure). The Sky view is not a window: it takes over the whole scene area, starting from the
 * first-person view of an observatory.
 *
 *   off -request-> flying -settled-> loading -ready-> entering -entered-> on -leave-> leaving -left-> off
 *
 * - flying: the first-person camera is still blending to the observatory (1.5 s); Aladin Lite and the survey mirror load meanwhile.
 * - loading: the camera has settled, Aladin is not ready yet.
 * - entering: the transition into the Aladin view runs (the scene is still drawn under it).
 * - on: the scene is covered and paused; Aladin is live.
 * - leaving: the first-person view has been left (the camera flies back to the Earth view) and the transition runs in reverse.
 *
 * `ready` can come before `settled` (the preload is usually quicker than the camera): it is remembered, so `settled` then goes
 * straight to entering. `failed` returns to the plain first-person view with a message (the view stays where it is); `fpEnded`
 * (the first-person view ended by any other route: another selection, a focus, Follow off, a lost position) forces `off`.
 * It is expected while leaving (the leave itself ends the first-person view), so it does not cut that transition short.
 */
export type SkyPhase = 'off' | 'flying' | 'loading' | 'entering' | 'on' | 'leaving';

export interface SkyModeState {
  phase: SkyPhase;
  /** the observatory entity being looked at; null while off */
  obsId: string | null;
  /** Aladin is created, aimed and has a survey server (set early while still flying) */
  ready: boolean;
  /** why the last attempt failed (shown until the next request, a leave or a dismissal); null otherwise */
  error: string | null;
}

export type SkyEvent =
  | { type: 'request'; obsId: string }
  | { type: 'settled' }
  | { type: 'ready' }
  | { type: 'failed'; message: string }
  | { type: 'entered' }
  | { type: 'leave' }
  | { type: 'left' }
  | { type: 'fpEnded' }
  | { type: 'reset' }
  | { type: 'clearError' };

export const SKY_OFF: SkyModeState = { phase: 'off', obsId: null, ready: false, error: null };

const off = (error: string | null = null): SkyModeState => ({ phase: 'off', obsId: null, ready: false, error });

/** The next state; the same object when the event does nothing in this phase. */
export function skyReduce(s: SkyModeState, e: SkyEvent): SkyModeState {
  switch (e.type) {
    case 'request':
      return s.phase === 'off' ? { phase: 'flying', obsId: e.obsId, ready: false, error: null } : s;
    case 'settled':
      return s.phase === 'flying' ? (s.ready ? { ...s, phase: 'entering' } : { ...s, phase: 'loading' }) : s;
    case 'ready':
      if (s.phase === 'flying') return s.ready ? s : { ...s, ready: true };
      return s.phase === 'loading' ? { ...s, phase: 'entering', ready: true } : s;
    case 'failed':
      return s.phase === 'flying' || s.phase === 'loading' || s.phase === 'entering' ? off(e.message) : s;
    case 'entered':
      return s.phase === 'entering' ? { ...s, phase: 'on' } : s;
    case 'leave':
      // before anything is shown there is nothing to reverse
      if (s.phase === 'flying' || s.phase === 'loading') return off();
      return s.phase === 'entering' || s.phase === 'on' ? { ...s, phase: 'leaving' } : s;
    case 'left':
      return s.phase === 'leaving' ? off() : s;
    case 'fpEnded':
      return s.phase === 'leaving' ? s : s.phase === 'off' && !s.error ? s : off();
    case 'reset':
      return s.phase === 'off' && !s.error && s.obsId === null && !s.ready ? s : off(); // the scene is gone (unmount, hot reload): nothing to reverse
    case 'clearError':
      return s.error ? { ...s, error: null } : s;
  }
}

/**
 * Request tokens: an asynchronous step (loading Aladin, probing a survey server) takes a token when it starts and may change the
 * live view only while it is still the latest (`current`); a new request, a leave or `invalidate` makes every earlier one stale, so a
 * slow answer for an observatory that is no longer shown cannot switch the survey or aim the view.
 */
export class RequestTokens {
  private n = 0;
  take(): number {
    return ++this.n;
  }
  current(token: number): boolean {
    return token === this.n;
  }
  invalidate(): void {
    this.n++;
  }
}

/**
 * Should the loading phases aim the Aladin view at the camera's pose now? Only with a real pose (the camera has no pose until its
 * first drawn frame after the first-person view starts: a second start finds `null` for a moment), once the view exists, and once
 * per start. Never with a made-up one: that would turn the view the previous start left (and its prefetched tiles) to nowhere.
 */
export function shouldAim(pose: unknown, viewReady: boolean, alreadyAimed: boolean): boolean {
  return !!pose && viewReady && !alreadyAimed;
}

/** The scene shows the Aladin view (or is about to): scene hotkeys are inert and the scene's labels are hidden. */
export const skyCoversScene = (p: SkyPhase): boolean => p === 'entering' || p === 'on';

/** A sky view is in progress in any phase (the Sky view button and double-click are ignored, Esc leaves). */
export const skyBusy = (p: SkyPhase): boolean => p !== 'off';

/** Longest the whole entry may take (camera blend, Aladin and survey load) before it is given up, ms. */
export const SKY_ENTRY_TIMEOUT_MS = 12_000;
