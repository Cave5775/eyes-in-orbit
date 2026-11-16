/**
 * The only module that knows Aladin Lite (CDS, https://aladin.cds.unistra.fr/AladinLite/). The library is loaded lazily, by a
 * dynamic import of its ES module, the first time the Sky view starts; it is not a dependency of the app (no npm package, nothing in the bundle).
 * The rest of the app uses `SkyView` and never touches `window.A`.
 *
 * Version pinned to an exact release (3.8.2, the latest non-beta on npm/jsDelivr when this was written; 3.9.x are betas).
 * Remote loading, stated plainly: starting the Sky view imports this module from cdn.jsdelivr.net, where it runs in the page with
 * the page's privileges and no subresource-integrity check (none was computed). Aladin then fetches survey properties and tiles
 * from CDS hosts (alasky.cds.unistra.fr and mirrors); a tile request reveals the sky position and survey being viewed. Nothing
 * is requested before the Sky view is first started.
 *
 * What the real 3.8.2 bundle does (probed in a browser, survey hosts blocked, 800x500 and 500x800 elements, TAN projection):
 * - `setFoV(d)` sets the HORIZONTAL field (the element's width) as a true angle: the centre-to-left-edge distance on the sky is d / 2
 *   (20.0 deg for d = 40), also for a portrait element. The pixel scale is gnomonic (tan), so it equals the scene's pinhole camera.
 * - `getFoV()` returns [horizontal, vertical]; the vertical one is the horizontal times height / width (linear, not the true
 *   tan angle), so only [0] is used. A horizontal field of 120 is accepted (it reports [120, 180] for a 500x800 element).
 * - The method is `getFoV` (capital F; there is no `getFov`); `setFov` is an alias of `setFoV`.
 * - `setRotation(deg)` exists (alias `setViewCenter2NorthPoleAngle`), `getRotation()` too. `setRotation(0)` does nothing (its
 *   `!deg` check warns and returns), so zero is sent as 1e-6. A positive angle turns the sky counter-clockwise on the screen
 *   (setRotation(30): north points 30 deg left of screen-up, east 30 deg below the left direction): Aladin's angle is minus the
 *   position angle of screen-up (see `aladinRotationDeg`). The view centre stays put.
 * - `world2pix(ra, dec)` returns CSS pixels in the element (x right, y down, origin top left; the centre of an 800x500 view is
 *   (400, 250)), `pix2world(x, y)` the inverse with RA in [0, 360). Both answer at once after `gotoRaDec`, `setFoV` or
 *   `setRotation`, which apply immediately (no animation); `getRaDec()` reads the centre back.
 * - `animateToRaDec(ra, dec, seconds)` and `stopAnimation()` exist: the centre moves along the sky in steps of Aladin's own render
 *   loop (0.6 s took about 0.75 s from the call: (100, 20) -> (130, 40) passed (104.9, 24.3), (109, 27.6), (117.3, 33.4), (126.0, 38.2)),
 *   and the field of view and the rotation are untouched (40 and 30 stayed 40 and 30). `world2pix` follows the moving centre, so
 *   a layer that projects every frame stays on the sky. `SkyView.animateTo` uses it; a build without it gets an eased `gotoRaDec`.
 * - There is NO pause, stop or destroy call, and `aladin.remove` only removes a layer. The view's render loop (`view.redraw`) calls
 *   `wasm.update` and re-arms itself with `requestAnimationFrame(this.redrawClbk)` on every frame, hidden or not. Measured here
 *   (headless Edge, scene paused, 5 s): never opened 0 rAF/s and 3.6 ms/s of main-thread tasks; opened once and hidden 130 rAF/s
 *   and 54 ms/s. Removing the host from the DOM does not stop it. `SkyView.setActive(false)` parks it: the loop reads
 *   `view.redrawClbk` at every re-arm, so a gate installed there lets the loop die while off and starts it again on demand (a
 *   build without `view.redrawClbk` is left running).
 */

import { easeInOut, slerpRaDec } from './sky-markers';

export const ALADIN_VERSION = '3.8.2';
export const ALADIN_URL = `https://cdn.jsdelivr.net/npm/aladin-lite@${ALADIN_VERSION}/dist/aladin.js`;
export const ALADIN_LOAD_TIMEOUT_MS = 15_000;

/** The slice of Aladin Lite v3 this app calls. */
interface AladinInstance {
  gotoRaDec(raDeg: number, decDeg: number): void;
  setFoV(deg: number): void;
  getFoV(): number[] | number;
  setImageSurvey(idOrUrl: string): void;
  on(event: string, cb: (...args: number[]) => void): void;
  getRaDec?(): ArrayLike<number> | null | undefined;
  setRotation?(deg: number): void;
  view?: { redrawClbk?: unknown; prevTime?: number; requestRedraw?(): void };
  animateToRaDec?(raDeg: number, decDeg: number, seconds: number): void;
  stopAnimation?(): void;
  getRotation?(): number;
  world2pix?(raDeg: number, decDeg: number): ArrayLike<number> | null | undefined;
  pix2world?(x: number, y: number): ArrayLike<number> | null | undefined;
}
export interface AladinGlobal {
  init?: Promise<unknown>;
  aladin(el: string | HTMLElement, options: Record<string, unknown>): AladinInstance;
}

/** Loads an ES module by URL; injectable for tests. */
export type ModuleImporter = (url: string) => Promise<unknown>;

const browserImport: ModuleImporter = (url) => import(/* @vite-ignore */ url);

let pending: Promise<AladinGlobal> | null = null;

/** The Aladin object of the loaded module: the default export (what the v3 ESM build has), else a named `A`, else the module. */
function aladinOf(mod: unknown): AladinGlobal | null {
  const m = mod as { default?: unknown; A?: unknown } | null;
  for (const c of [m?.default, m?.A, m]) {
    if (c && typeof (c as AladinGlobal).aladin === 'function') return c as AladinGlobal;
  }
  return null;
}

/**
 * Load Aladin Lite once, by a dynamic `import()` of the pinned ES module (the jsDelivr `dist/aladin.js` of 3.8.2 is an ES module,
 * a classic script tag fails on its `export`). A failed load (offline, blocked, timeout) rejects with a readable Error and is
 * retried by the next call.
 */
export function loadAladin(importer: ModuleImporter | null = typeof window === 'undefined' ? null : browserImport, url = ALADIN_URL, timeoutMs = ALADIN_LOAD_TIMEOUT_MS): Promise<AladinGlobal> {
  if (!importer) return Promise.reject(new Error('Sky view needs a browser'));
  if (pending) return pending;
  pending = new Promise<AladinGlobal>((resolve, reject) => {
    let done = false;
    const fail = (why: string) => {
      if (done) return;
      done = true;
      pending = null;
      reject(new Error(`Could not load Aladin Lite ${ALADIN_VERSION} (${why}). The Sky view needs a network connection to cdn.jsdelivr.net.`));
    };
    const timer = setTimeout(() => fail('timed out'), timeoutMs);
    importer(url).then(
      (mod) => {
        clearTimeout(timer);
        const A = aladinOf(mod);
        if (!A) return fail('the module has no Aladin export');
        Promise.resolve(A.init).then(() => {
          if (done) return;
          done = true;
          resolve(A);
        }, () => fail('initialisation failed'));
      },
      (err: unknown) => {
        clearTimeout(timer);
        fail(err instanceof Error && err.message ? err.message : 'request failed');
      },
    );
  });
  return pending;
}

/** Forget a cached load (tests). */
export function resetAladinLoader(): void {
  pending = null;
}

export interface SkyViewInit {
  /** HiPS id (`CDS/P/DSS2/color`) or a survey base URL */
  survey: string;
  raDeg: number;
  decDeg: number;
  /** horizontal field of view, degrees */
  fovDeg: number;
}

/** A pose for the view: the J2000 centre, the horizontal field of view and the position angle of screen-up (lib/sky-pose.ts `SkyPose`). */
export interface SkyViewPose {
  raDeg: number;
  decDeg: number;
  /** horizontal (screen width) field of view, degrees */
  hFovDeg: number;
  /** position angle of the screen's up direction from celestial north toward east, degrees */
  rotationDeg: number;
}

/** A sky view in one element. */
export interface SkyView {
  gotoRaDec(raDeg: number, decDeg: number): void;
  /** move the centre to a J2000 position over `ms`, keeping the field of view and the rotation (Aladin's own animation, else an eased `gotoRaDec`); a new call or `stopAnimation` replaces a running one */
  animateTo(raDeg: number, decDeg: number, ms: number): void;
  /** stop a running `animateTo` where it is (the user starts dragging) */
  stopAnimation(): void;
  /** run (default) or park Aladin's render loop: parked it costs nothing, and the view keeps its state; false when this build cannot be parked */
  setActive(on: boolean): boolean;
  setSurvey(id: string): void;
  /** sets the HORIZONTAL (screen width) field of view, degrees */
  setFov(deg: number): void;
  /** current horizontal field of view, degrees; null when Aladin does not say */
  fov(): number | null;
  /** centre of the view, J2000 degrees; null when Aladin does not say */
  center(): { raDeg: number; decDeg: number } | null;
  /** centre, field of view and rotation in one call (the sign convention of Aladin's rotation stays in this module) */
  setPose(p: SkyViewPose): void;
  /** the rotation Aladin reports, in ITS convention (degrees); null when the build has no rotation */
  rotation(): number | null;
  /** CSS pixel (x right, y down, origin the top left of the Aladin element) of a J2000 position; null when it has none */
  world2pix(raDeg: number, decDeg: number): [number, number] | null;
  /** J2000 position under a CSS pixel of the Aladin element; null when the pixel is off the sky */
  pix2world(x: number, y: number): [number, number] | null;
}

/**
 * Widest horizontal field of view the Sky view allows: 150 degrees, which is Aladin Lite 3.8.2's own limit (probed: `setFoV(152)`
 * through `setFoV(175)` all answer `getFoV()[0] = 150`, with the pixels of the 150 degree view). The first-person view reaches
 * 120 degrees vertical, which is 140.3 horizontal at 16:10, 144.0 at 16:9 and 152.2 at 21:9: the first two fit, and on entering
 * the scene's own field is cut to what the viewer can show (`maxVFovFor`), so the match holds at any aspect.
 */
export const MAX_FOV_DEG = 150;

const clampFovDeg = (deg: number): number => (Number.isFinite(deg) ? Math.min(MAX_FOV_DEG, Math.max(0.001, deg)) : 60);

/**
 * Aladin's `setRotation` for a position angle of screen-up. Checked against the real 3.8.2 widget (see the header): a positive
 * Aladin rotation turns the sky counter-clockwise on the screen, so the direction that ends up at screen-up moves from north
 * toward WEST: Aladin's angle is minus the position angle. Zero is ignored by `setRotation`, so it becomes a rotation too small to see.
 */
export function aladinRotationDeg(positionAngleDeg: number): number {
  const r = -positionAngleDeg;
  if (!Number.isFinite(r)) return 1e-6;
  return Math.abs(r) < 1e-6 ? 1e-6 : r;
}

const pairOf = (v: ArrayLike<number> | null | undefined): [number, number] | null => {
  if (!v || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null;
  return [v[0], v[1]];
};

let live: SkyView | null = null;

/**
 * The view the app created (Aladin has no destroy, so there is at most one, kept for the whole session), or null before
 * `createSkyView` ran. A layer drawn over the Aladin element (annotations) projects with its `world2pix` / `pix2world`.
 */
export function liveSkyView(): SkyView | null {
  return live;
}

/** Forget the live view (tests). */
export function resetLiveSkyView(): void {
  live = null;
}

/** Create a view in `el` from a loaded Aladin (the options turn off everything but pan and zoom). */
export function createSkyView(A: AladinGlobal, el: HTMLElement, init: SkyViewInit): SkyView {
  try {
    return buildSkyView(A, el, init);
  } catch (e) {
    // Aladin may have added its container and canvases before it threw: a retry must start from an empty host
    el.replaceChildren?.();
    throw e;
  }
}

function buildSkyView(A: AladinGlobal, el: HTMLElement, init: SkyViewInit): SkyView {
  const a = A.aladin(el, {
    survey: init.survey,
    target: `${init.raDeg} ${init.decDeg}`,
    fov: clampFovDeg(init.fovDeg),
    cooFrame: 'equatorial',
    // gnomonic (TAN), what a camera sees: the default orthographic projection draws the sky as a ball that turns under the cursor
    projection: 'TAN',
    // no usage logging to the CDS server (it would send the page URL and the target)
    log: false,
    showReticle: false,
    showCooGridControl: false,
    showSimbadPointerControl: false,
    showLayersControl: false,
    showGotoControl: false,
    showFullscreenControl: false,
    showProjectionControl: false,
    showFrame: false,
    showZoomControl: false,
    showCooLocation: false,
    showFov: false,
    showContextMenu: false,
  });
  a.on('zoomChanged', (fov) => {
    if (fov > MAX_FOV_DEG) a.setFoV(MAX_FOV_DEG);
  });
  // the render loop gate (see the header): `running` is true while a frame of the loop is queued or executing
  let loopOn = true;
  let running = true;
  const loop = a.view?.redrawClbk;
  const canPark = typeof loop === 'function' && !!a.view;
  if (canPark) {
    const real = loop as (t: number) => void;
    a.view!.redrawClbk = (t: number) => {
      if (!loopOn) {
        running = false; // not re-armed: the loop stops here
        return;
      }
      real(t);
    };
  }
  const setActive = (on: boolean): boolean => {
    if (!canPark) return false;
    loopOn = on;
    if (on && !running) {
      running = true;
      if (a.view) a.view.prevTime = performance.now(); // no huge time step for the first frame back
      a.view?.requestRedraw?.();
      requestAnimationFrame(a.view!.redrawClbk as (t: number) => void);
    }
    return true;
  };
  let fallback = 0;
  const stopAnimation = () => {
    if (fallback) cancelAnimationFrame(fallback);
    fallback = 0;
    try {
      a.stopAnimation?.();
    } catch { /* nothing was running */ }
  };
  const view: SkyView = {
    gotoRaDec: (ra, dec) => a.gotoRaDec(ra, dec),
    setActive,
    stopAnimation,
    animateTo: (ra, dec, ms) => {
      stopAnimation();
      if (typeof a.animateToRaDec === 'function') {
        a.animateToRaDec(ra, dec, ms / 1000);
        return;
      }
      const from = pairOf(a.getRaDec?.());
      if (!from || ms <= 0) {
        a.gotoRaDec(ra, dec);
        return;
      }
      const start = performance.now(), a0 = { raDeg: from[0], decDeg: from[1] }, a1 = { raDeg: ra, decDeg: dec }, tmp = { raDeg: 0, decDeg: 0 };
      const step = () => {
        const p = Math.min(1, (performance.now() - start) / ms);
        const q = slerpRaDec(a0, a1, easeInOut(p), tmp);
        a.gotoRaDec(q.raDeg, q.decDeg);
        fallback = p < 1 ? requestAnimationFrame(step) : 0;
      };
      step();
    },
    setSurvey: (id) => a.setImageSurvey(id),
    setFov: (deg) => a.setFoV(clampFovDeg(deg)),
    fov: () => {
      const f = a.getFoV();
      const v = Array.isArray(f) ? f[0] : f;
      return Number.isFinite(v) ? v : null;
    },
    center: () => {
      const c = pairOf(a.getRaDec?.());
      return c ? { raDeg: c[0], decDeg: c[1] } : null;
    },
    setPose: (p) => {
      a.gotoRaDec(p.raDeg, p.decDeg);
      view.setFov(p.hFovDeg);
      a.setRotation?.(aladinRotationDeg(p.rotationDeg));
    },
    rotation: () => {
      const r = a.getRotation?.();
      return typeof r === 'number' && Number.isFinite(r) ? r : null;
    },
    world2pix: (ra, dec) => {
      try {
        return pairOf(a.world2pix?.(ra, dec));
      } catch {
        return null;
      }
    },
    pix2world: (x, y) => {
      try {
        return pairOf(a.pix2world?.(x, y));
      } catch {
        return null;
      }
    },
  };
  live = view;
  return view;
}
