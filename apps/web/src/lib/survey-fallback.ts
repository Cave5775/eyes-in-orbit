/**
 * Which survey the Sky view starts with (pure). An observatory lists its own surveys in order (lib/observatories.ts `surveyPlan`),
 * followed by general all-sky fallbacks. Starting never fails because one survey's servers are down: the first survey with a
 * working server is used, and the person is told when it is not the one the observatory asked for.
 *
 * The probes of one stage run at once (a down server can take its whole timeout to give up) and the answer is the first in the
 * stage's order that worked, so a quick fallback never overtakes a slower survey of the observatory itself. The fallbacks are asked only
 * when no own survey answered, which keeps the request count to what the observatory needs.
 */

export interface SurveyPlan {
  /** the observatory's own survey ids, in order of preference */
  own: readonly string[];
  /** general all-sky surveys, asked only when no own survey works */
  fallbacks: readonly string[];
}

export interface SurveyChoice<T> {
  /** the survey that has a server */
  id: string;
  /** what the probe returned for it (the server URL) */
  value: T;
  /** the survey that was wanted first */
  requested: string;
  /** the surveys ahead of `id` that had no working server */
  unavailable: string[];
}

/** Longest a stage waits for its probes; a survey still waiting then counts as unavailable (its answer is kept by the mirror cache for later). */
export const SURVEY_STAGE_CAP_MS = 4500;

/**
 * Choose the survey to start with. `probe(id)` resolves to the server (or whatever the caller needs) or null when the survey has
 * none; a probe that rejects counts as null. Null result: nothing answered at all.
 */
export async function chooseSurvey<T>(plan: SurveyPlan, probe: (id: string) => Promise<T | null>, capMs = SURVEY_STAGE_CAP_MS): Promise<SurveyChoice<T> | null> {
  const own = [...new Set(plan.own)];
  const stages = [own, [...new Set(plan.fallbacks)].filter((id) => !own.includes(id))].filter((s) => s.length > 0);
  const requested = stages[0]?.[0];
  if (!requested) return null;
  const unavailable: string[] = [];
  for (const ids of stages) {
    const answers = await Promise.all(ids.map((id) => withCap(probe(id), capMs)));
    const at = answers.findIndex((a) => a !== null);
    if (at >= 0) return { id: ids[at], value: answers[at] as T, requested, unavailable: [...unavailable, ...ids.slice(0, at)] };
    unavailable.push(...ids);
  }
  return null;
}

/** The promise's value, or null when it rejects, resolves null or takes longer than `ms`. */
function withCap<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v ?? null); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/** "DSS2 colour is unavailable right now, showing 2MASS", or null when the wanted survey is the one in use. */
export function fallbackNote(requestedLabel: string, usedLabel: string, same: boolean): string | null {
  return same ? null : `${requestedLabel} is unavailable right now, showing ${usedLabel}.`;
}
