import { DEFAULT_HIPS_SURVEY } from '@eio/core';
import { createSkyView, loadAladin, type SkyView, type SkyViewPose } from '../lib/aladin';
import { RequestTokens } from '../lib/sky-mode';
import { mirrors } from '../lib/hips-mirror';
import { surveyOf } from '../lib/observatories';
import { chooseSurvey, type SurveyPlan } from '../lib/survey-fallback';
import { curtainEasing, curtainKeyframes, scanKeyframes, TRANSITION_MS, type SkyTransitionId } from '../lib/sky-transition';

/** The elements the driver works on (rendered by SkyOverlay). */
export interface SkyDriverEls {
  /** where Aladin Lite is created */
  host: HTMLElement;
  /** the animated layer holding the host (opacity / clip-path) */
  curtain: HTMLElement;
  /** the sweep's scanline */
  scan: HTMLElement;
}

/** Durations are multiplied by `window.__eioSkyScale` in a dev build (a browser check slows them down to look at a frame mid-way). */
function timeScale(): number {
  if (!import.meta.env.DEV || typeof window === 'undefined') return 1;
  const k = (window as unknown as { __eioSkyScale?: number }).__eioSkyScale;
  return typeof k === 'number' && k > 0 ? k : 1;
}

const NO_SURVEY = (id: string) => `${surveyOf(id)?.label ?? id} is unavailable right now: none of its servers answered. Try another survey.`;
const NONE_ANSWER = 'No sky survey server answers right now (the survey servers or the network are down)';

/** What `prepare` ended up with: the survey in use, the one asked for first, and the surveys ahead of the used one that had no server. */
export interface PrepareResult { used: string; requested: string; unavailable: string[] }

/**
 * The imperative half of the Sky view: Aladin Lite (created once, then kept for the session: Aladin has no destroy) and the
 * curtain animations. SkyOverlay calls it from its phase effects; it holds no React state. Everything that can fail rejects with
 * an Error whose message is meant for the person.
 */
export class SkyDriver {
  private v: SkyView | null = null;
  private surveyId: string | null = null;
  private active = true;
  private anims: Animation[] = [];
  private frame = 0;
  private tweenEnd: (() => void) | null = null;
  /** the latest prepare / survey change: an older one that finishes later must not touch the view (see `RequestTokens`) */
  private readonly tokens = new RequestTokens();

  constructor(private readonly els: SkyDriverEls) {}

  get view(): SkyView | null {
    return this.v;
  }

  /**
   * Load Aladin Lite and a server for the first survey of `target` that has one (a survey id, or a plan: the observatory's own
   * surveys in order, then all-sky fallbacks; lib/survey-fallback.ts), then create the view (once) or point the existing one at
   * that survey. Rejects only when no survey of the plan has a server, or Aladin does not load. `pose` is
   * asked for when the view is created, so it starts where the camera will end up and its first tiles load during the camera blend.
   * A pose of `null` (the camera has not drawn a frame yet) aims nothing: a NEW view is created at a placeholder (the caller aims
   * it when a pose exists), an existing one stays where it is. Does nothing, and resolves, when a later `prepare`, `useSurvey` or
   * `invalidate` has taken over while it was waiting (then it resolves null).
   */
  async prepare(target: string | SurveyPlan, pose: () => SkyViewPose | null): Promise<PrepareResult | null> {
    const token = this.tokens.take();
    const plan: SurveyPlan = typeof target === 'string' ? { own: [target], fallbacks: [] } : target;
    // both start at once: the library and the survey servers are independent, and either failing ends the attempt
    const [choice, A] = await Promise.all([chooseSurvey(plan, (id) => this.tryMirror(id)), loadAladin()]);
    if (!this.tokens.current(token)) return null;
    if (!choice) throw new Error(plan.own.length + plan.fallbacks.length === 1 ? NO_SURVEY(plan.own[0] ?? plan.fallbacks[0]) : NONE_ANSWER);
    const surveyId = choice.id, url = choice.value;
    const p = pose();
    if (!this.v) {
      const at = p ?? { raDeg: 0, decDeg: 0, hFovDeg: 60, rotationDeg: 0 };
      this.v = createSkyView(A, this.els.host, { survey: url, raDeg: at.raDeg, decDeg: at.decDeg, fovDeg: at.hFovDeg });
      this.surveyId = surveyId;
    } else if (this.surveyId !== surveyId) {
      this.v.setSurvey(url);
      this.surveyId = surveyId;
    }
    if (p) this.v.setPose(p);
    this.v.setActive(this.active);
    return { used: choice.id, requested: choice.requested, unavailable: choice.unavailable };
  }

  /** Run Aladin's render loop (a sky view starts) or park it (nothing is shown: a hidden view costs main-thread time every frame otherwise, see lib/aladin.ts). */
  setActive(on: boolean): void {
    this.active = on;
    this.v?.setActive(on);
  }

  /** Make every `prepare` and `useSurvey` still waiting stale (the sky view was left or a new one requested). */
  invalidate(): void {
    this.tokens.invalidate();
  }

  /** Switch the survey of the live view; rejects with a readable message when none of its servers answer. A later call or `invalidate` makes it a no-op. */
  async useSurvey(surveyId: string): Promise<void> {
    const token = this.tokens.take();
    const url = await this.mirrorOf(surveyId);
    if (!this.tokens.current(token)) return;
    if (this.v && this.surveyId !== surveyId) this.v.setSurvey(url);
    this.surveyId = surveyId;
  }

  /** The working server of a survey, or null (an unknown id, or no server answers). */
  private async tryMirror(surveyId: string): Promise<string | null> {
    const s = surveyOf(surveyId);
    return s ? mirrors.pick(s.id, s.urls) : null;
  }

  private async mirrorOf(surveyId: string): Promise<string> {
    const s = surveyOf(surveyId) ?? surveyOf(DEFAULT_HIPS_SURVEY);
    if (!s) throw new Error(NO_SURVEY(surveyId));
    const url = await mirrors.pick(s.id, s.urls);
    if (!url) throw new Error(NO_SURVEY(s.id));
    return url;
  }

  aim(p: SkyViewPose): void {
    this.v?.setPose(p);
  }

  /**
   * Tell `cb` when the person moves or zooms the view themselves: a drag (a press that travels more than 4 px) or the wheel, seen
   * in the capture phase on the Aladin host (nothing is stopped). Returns the unsubscribe function.
   */
  watchUser(cb: (kind: 'drag' | 'zoom') => void): () => void {
    const host = this.els.host;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onMove = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) {
        down = null;
        cb('drag');
      }
    };
    const onUp = () => { down = null; };
    const onWheel = () => cb('zoom');
    host.addEventListener('pointerdown', onDown, true);
    host.addEventListener('pointermove', onMove, true);
    host.addEventListener('pointerup', onUp, true);
    host.addEventListener('pointercancel', onUp, true);
    host.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => {
      host.removeEventListener('pointerdown', onDown, true);
      host.removeEventListener('pointermove', onMove, true);
      host.removeEventListener('pointerup', onUp, true);
      host.removeEventListener('pointercancel', onUp, true);
      host.removeEventListener('wheel', onWheel, true);
    };
  }

  /** True while a curtain animation is running. */
  get animating(): boolean {
    return this.anims.some((a) => a.playState === 'running');
  }

  /**
   * Play the curtain animation of `kind` (in: from hidden to shown, out: back). It starts synchronously (the first frame is
   * already the hidden state: `fill: both`), resolves when finished, and leaves the curtain shown (in) or hidden (out) for the
   * caller to settle. A cut resolves at once. `delayMs` waits before the first change (the zoom's scene phase).
   */
  curtain(kind: SkyTransitionId, dir: 'in' | 'out', delayMs = 0): Promise<void> {
    this.clearAnims();
    const frames = curtainKeyframes(kind);
    if (!frames) return Promise.resolve();
    const k = timeScale();
    const opts: KeyframeAnimationOptions = {
      duration: TRANSITION_MS[kind] * k, delay: delayMs * k, easing: curtainEasing(kind), fill: 'both', direction: dir === 'in' ? 'normal' : 'reverse',
    };
    const anims = [this.els.curtain.animate(frames, opts)];
    const scan = scanKeyframes(kind);
    // the scanline shows only while the wipe runs
    if (scan) anims.push(this.els.scan.animate(scan, { ...opts, fill: 'none', easing: 'linear', direction: opts.direction }));
    this.anims = anims;
    return Promise.all(anims.map((a) => a.finished)).then(() => undefined, () => undefined);
  }

  /** Turn a running curtain animation around (leaving while still entering); resolves when it has run back. False when none is running. */
  reverse(): Promise<void> | null {
    if (!this.animating) return null;
    for (const a of this.anims) a.reverse();
    return Promise.all(this.anims.map((a) => a.finished)).then(() => undefined, () => undefined);
  }

  /** Drop the animations and show the curtain fully (no inline style left over). */
  settle(): void {
    this.clearAnims();
  }

  private clearAnims(): void {
    for (const a of this.anims) {
      try {
        a.cancel();
      } catch { /* already gone */ }
    }
    this.anims = [];
  }

  /** Run `fn(p)` for p = 0..1 over `ms` (a requestAnimationFrame loop); resolves at the end, or when `cancelTween` is called. */
  tween(ms: number, fn: (p: number) => void): Promise<void> {
    this.cancelTween();
    const total = ms * timeScale();
    return new Promise<void>((resolve) => {
      const t0 = performance.now();
      const step = () => {
        const p = total <= 0 ? 1 : Math.min(1, (performance.now() - t0) / total);
        fn(p);
        if (p >= 1) {
          this.tweenEnd = null;
          this.frame = 0;
          resolve();
        } else this.frame = requestAnimationFrame(step);
      };
      this.tweenEnd = () => {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.tweenEnd = null;
        resolve();
      };
      step();
    });
  }

  cancelTween(): void {
    this.tweenEnd?.();
  }
}
