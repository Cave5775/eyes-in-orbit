import { useEffect, useState } from 'react';
import { perf, type PerfSnapshot } from '../lib/perf';

const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');

/** `?perf=1` readout: rolling frame time, per-stage cost, store updates, entity count, heap. Refreshes twice a second. */
export function PerfOverlay() {
  const [s, setS] = useState<PerfSnapshot | null>(null);
  useEffect(() => {
    if (!perf.on) return;
    const id = setInterval(() => setS(perf.snapshot()), 500);
    return () => clearInterval(id);
  }, []);
  if (!perf.on || !s) return null;
  const row = (k: string, v: string) => (
    <div className="perf-row"><span>{k}</span><b>{v}</b></div>
  );
  const pair = (st: { p50: number; p95: number }) => `${f(st.p50, 2)} / ${f(st.p95, 2)} ms`;
  return (
    <div className="perf-overlay" aria-label="Performance readout">
      {row('frame p50/p95', pair(s.frame))}
      {row('draw JS p50/p95', pair(s.draw))}
      {row('point upload', pair(s.upload))}
      {row('propagate (worker)', pair(s.propagate))}
      {row('buffer copy', pair(s.positionsCopy))}
      {row('scope scan', pair(s.scope))}
      {row('store updates/s', f(s.storeUpdatesPerSec, 1))}
      {row('ingest (last)', `${f(s.last.ingest ?? NaN, 1)} ms`)}
      {row('scene setEntities', `${f(s.last.sceneEntities ?? NaN, 1)} ms`)}
      {row('text search', `${f(s.last.textSearch ?? NaN, 1)} ms`)}
      {row('tree / rows', `${f(s.last.tree ?? NaN, 1)} / ${f(s.last.rows ?? NaN, 1)} ms`)}
      {row('entities / sats', `${s.entities} / ${s.satellites}`)}
      {row('JS heap', s.heapMB === null ? 'n/a' : `${f(s.heapMB, 0)} MB`)}
    </div>
  );
}
