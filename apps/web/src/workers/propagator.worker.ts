import { json2satrec, sgp4, type SatRec } from 'satellite.js';
import { TICK_MS, type FromWorker, type SatInit, type ToWorker } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const JD_UNIX_EPOCH = 2440587.5;

interface Sat {
  satrec: SatRec;
  epochMs: number;
  /** cheap change detector for incoming element sets */
  key: string;
}

const sats = new Map<string, Sat>();
let ids: string[] = [];
let index = new Map<string, number>();
let recs: Sat[] = [];
let version = 0;
let layoutDirty = false;
const pool: Float64Array[] = [];
let clock: { anchorSim: number; anchorWall: number; rate: number } | null = null;
let lastPostedSim = NaN;
let forcePost = false;

function rebuildLayout(): void {
  ids = [...sats.keys()];
  recs = ids.map((id) => sats.get(id)!);
  index = new Map(ids.map((id, i) => [id, i]));
  version++;
  pool.length = 0;
  layoutDirty = true;
}

function upsert(list: SatInit[]): void {
  let changedLayout = false;
  for (const { id, omm } of list) {
    const key = `${omm.EPOCH}|${omm.MEAN_MOTION}`;
    const prev = sats.get(id);
    if (prev?.key === key) continue;
    // satrecs are built once per element set, never per tick
    const satrec = json2satrec(omm as never);
    sats.set(id, { satrec, epochMs: (satrec.jdsatepoch - JD_UNIX_EPOCH) * 86_400_000, key });
    if (!prev) changedLayout = true;
    else recs[index.get(id)!] = sats.get(id)!;
  }
  if (changedLayout) rebuildLayout();
  forcePost = true;
}

function tick(): void {
  if (!clock || !recs.length) return;
  if (layoutDirty) {
    ctx.postMessage({ type: 'layout', version, ids } satisfies FromWorker);
    layoutDirty = false;
  }
  const simMs = clock.anchorSim + (Date.now() - clock.anchorWall) * clock.rate;
  if (simMs === lastPostedSim && !forcePost) return;
  forcePost = false;
  lastPostedSim = simMs;

  const n = recs.length;
  const t0 = performance.now();
  const buf = pool.pop() ?? new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = recs[i];
    const out = sgp4(s.satrec, (simMs - s.epochMs) / 60_000);
    const p = out && out.position;
    if (p && typeof p !== 'boolean' && Number.isFinite(p.x)) {
      buf[i * 3] = p.x;
      buf[i * 3 + 1] = p.y;
      buf[i * 3 + 2] = p.z;
    } else {
      buf[i * 3] = buf[i * 3 + 1] = buf[i * 3 + 2] = 0;
    }
  }
  ctx.postMessage({ type: 'positions', version, simMs, buffer: buf, ms: performance.now() - t0 } satisfies FromWorker, [buf.buffer]);
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'upsert':
      upsert(m.entities);
      break;
    case 'remove': {
      let removed = false;
      for (const id of m.ids) removed = sats.delete(id) || removed;
      if (removed) rebuildLayout();
      forcePost = true;
      break;
    }
    case 'clock':
      clock = { anchorSim: m.anchorSim, anchorWall: m.anchorWall, rate: m.rate };
      forcePost = true;
      break;
    case 'recycle':
      if (m.buffer.length === recs.length * 3 && pool.length < 4) pool.push(m.buffer);
      break;
  }
};

setInterval(tick, TICK_MS);
