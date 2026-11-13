/**
 * Pick a working server for a HiPS survey. Each survey is published at several mirrors (the CDS MocServer record lists them as
 * `hips_service_url`, `_1`, `_2`...); Aladin Lite, given a survey id, resolves it itself through a lookup host that no longer
 * resolves (alasky.unistra.fr), and CDS's own alasky has answered every survey with a "Page unavailable" 404 since
 * 2026-11-12. So the Sky view hands Aladin a base URL instead: the first mirror whose `properties` file answers.
 *
 * Request budget: at most one probe per mirror per survey per session, in order, stopping at the first that works. A survey
 * with no working mirror is not asked again for FAILED_RETRY_MS.
 */

/** true when `<base>/properties` answers with a HiPS properties file */
export type HipsProbe = (base: string) => Promise<boolean>;

export const FAILED_RETRY_MS = 5 * 60_000;
export const PROBE_TIMEOUT_MS = 8_000;

/** The first base URL the probe accepts, in order; null when none does. A probe that throws counts as a miss. */
export async function firstReachable(bases: readonly string[], probe: HipsProbe): Promise<string | null> {
  for (const b of bases) {
    let ok = false;
    try {
      ok = await probe(b);
    } catch {
      ok = false;
    }
    if (ok) return b;
  }
  return null;
}

/** Browser probe: GET the properties file (CORS is open on the CDS, IRSA, ESA and CASDA mirrors) and check it is one. */
const browserProbe: HipsProbe = async (base) => {
  const r = await fetch(`${base}/properties`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'force-cache', referrerPolicy: 'no-referrer' });
  if (!r.ok) return false;
  return /hips_/i.test(await r.text());
};

interface Entry { at: number; result: Promise<string | null> }

/** Remembers the answer per survey id: a found mirror for the session, a failure for FAILED_RETRY_MS. */
export class MirrorPicker {
  private readonly cache = new Map<string, Entry>();
  private readonly found = new Map<string, string>();
  constructor(private readonly probe: HipsProbe = browserProbe, private readonly now: () => number = Date.now) {}

  pick(id: string, bases: readonly string[]): Promise<string | null> {
    const hit = this.cache.get(id);
    if (hit) {
      // a pending or found answer is reused; a failure only until it is old enough to try again
      const stale = this.now() - hit.at >= FAILED_RETRY_MS;
      if (!stale) return hit.result;
      return hit.result.then((url) => (url ? url : this.ask(id, bases)));
    }
    return this.ask(id, bases);
  }

  private ask(id: string, bases: readonly string[]): Promise<string | null> {
    const result = firstReachable(bases, this.probe);
    this.cache.set(id, { at: this.now(), result });
    void result.then((url) => {
      if (url) this.found.set(id, url);
    });
    return result;
  }

  /** The server last found for a survey, for display; undefined until one answered. */
  current(id: string): string | undefined {
    return this.found.get(id);
  }
}

export const mirrors = new MirrorPicker();
