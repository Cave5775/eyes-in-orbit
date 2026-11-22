/**
 * Begin the push stream after the first full load, then load once more from the last cursor: the worker pushes only once it has been
 * started, so whatever changed between the initial paged load and the start would otherwise never reach the page. The start message
 * is queued before the incremental request, so a change either shows in that answer or arrives as a push.
 */
export async function beginStream(initialLoad: Promise<unknown>, start: () => void, resync: () => Promise<unknown>): Promise<void> {
  await initialLoad;
  start();
  try {
    await resync();
  } catch (err) {
    console.warn('[eio] entity resync after the stream start failed:', err);
  }
}
