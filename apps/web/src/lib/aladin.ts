/**
 * The only module that knows Aladin Lite (CDS, https://aladin.cds.unistra.fr/AladinLite/). The library is loaded lazily, by a
 * dynamic import of its ES module, the first time the Sky view opens; it is not a dependency of the app (no npm package, nothing in the bundle).
 * The rest of the app uses `SkyView` and never touches `window.A`.
 *
 * Version pinned to an exact release (3.8.2, the latest non-beta on npm/jsDelivr when this was written; 3.9.x are betas).
 * Remote loading, stated plainly: opening the Sky view imports this module from cdn.jsdelivr.net, where it runs in the page with
 * the page's privileges and no subresource-integrity check (none was computed). Aladin then fetches survey properties and tiles
 * from CDS hosts (alasky.cds.unistra.fr and mirrors); a tile request reveals the sky position and survey being viewed. Nothing
 * is requested before the Sky view is first opened.
 */

export const ALADIN_VERSION = '3.8.2';
export const ALADIN_URL = `https://cdn.jsdelivr.net/npm/aladin-lite@${ALADIN_VERSION}/dist/aladin.js`;
export const ALADIN_LOAD_TIMEOUT_MS = 15_000;

/** The slice of Aladin Lite v3 this app calls. */
interface AladinInstance {
  gotoRaDec(raDeg: number, decDeg: number): void;
  setFoV(deg: number): void;
  getFoV(): number[] | number;
  setImageSurvey(idOrUrl: string): void;
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
  /** HiPS id (`CDS/P/DSS2/color`) */
  survey: string;
  raDeg: number;
  decDeg: number;
  fovDeg: number;
}

/** A sky view in one element. */
export interface SkyView {
  gotoRaDec(raDeg: number, decDeg: number): void;
  setSurvey(id: string): void;
  setFov(deg: number): void;
  /** current field of view (the wider side), degrees; null when Aladin does not say */
  fov(): number | null;
}

/** Create a view in `el` from a loaded Aladin (the options turn off everything but pan and zoom). */
export function createSkyView(A: AladinGlobal, el: HTMLElement, init: SkyViewInit): SkyView {
  const a = A.aladin(el, {
    survey: init.survey,
    target: `${init.raDeg} ${init.decDeg}`,
    fov: init.fovDeg,
    cooFrame: 'equatorial',
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
  return {
    gotoRaDec: (ra, dec) => a.gotoRaDec(ra, dec),
    setSurvey: (id) => a.setImageSurvey(id),
    setFov: (deg) => a.setFoV(deg),
    fov: () => {
      const f = a.getFoV();
      const v = Array.isArray(f) ? Math.max(...f) : f;
      return Number.isFinite(v) ? v : null;
    },
  };
}
