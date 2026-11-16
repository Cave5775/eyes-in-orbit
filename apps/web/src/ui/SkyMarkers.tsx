import { useEffect, useRef } from 'react';
import { bodyOf, type EntityRecord } from '@eio/core';
import { colorKeyOf } from '../lib/entity';
import { labelText } from '../lib/labels';
import { classify, isDrawn } from '../lib/query';
import { liveSkyView } from '../lib/aladin';
import { declutter, lookDirTo, nearestMarker, selectBodies, type Placed, type SkyMarker, type SkyObserver } from '../lib/sky-annotations';
import { MARKER_HIT_PX, TURN_MS, isDragMove, markerAzEl, markerClick, markerTip, observerFor, separationDeg } from '../lib/sky-markers';
import { clock, graph, ensureInGraph, runtime } from '../state/runtime';
import { leaveSkyView } from '../state/sky-flow';
import { useStore } from '../state/store';
import { useView } from '../state/view';
import { LabelLayer, type LabelItem } from '../scene/LabelLayer';

/** Marker positions are recomputed at most this often, ms of wall time, unless the sim clock has moved by more than `SIM_STEP_MS`. */
const RECOMPUTE_MS = 200;
const SIM_STEP_MS = 2000;
/** The ring is this wide, px (CSS `.sky-ring`); the label starts this far to its right. */
const RING_PX = 14;
const LABEL_DX = 10;
const LABEL_DY = -8;
/** A body below the horizon or behind the Earth is drawn this faint. */
const DIM_OPACITY = 0.38;
/** A gnomonic view never shows a point this far from its centre; beyond it Aladin's `world2pix` may fold back, so it is dropped first. */
const MAX_SEP_DEG = 88;

/**
 * The annotation layer of the Sky view: a ring, and with View > Labels a name, at the exact position of every solar-system body
 * (lib/sky-annotations.ts `selectBodies`: the Sun, Moon, planets, dwarf planets and the moons that have a streamed position; no
 * satellites or probes). Rendered into the `.sky-annotations` slot of SkyOverlay, the same box as the Aladin canvas.
 *
 * While the sky view is entering or on it runs its own requestAnimationFrame loop (the scene's is paused): the markers are
 * recomputed about five times a second (every frame when the sim clock runs fast), projected with Aladin's `world2pix` every
 * frame the view or the markers changed, thinned by `declutter`, and drawn with the pooled DOM labels of the scene
 * (scene/LabelLayer.ts; the category colour is the stripe and the ring colour, as in the scene). Nothing runs while the tab is hidden.
 *
 * The pointer events of the Aladin canvas are never taken: listeners sit on its container, in the capture phase, and let
 * everything through, so Aladin keeps panning and zooming. A click without a drag (under 4 px) within 12 px of a ring
 * selects the body (`selectObject`) and turns the view to it (Aladin's own animation); a double click on the same ring selects it and leaves the
 * sky view, and the normal selection behaviour (the camera flies to the body) takes over. Hover shows a tooltip.
 */
export function SkyMarkers() {
  const phase = useView((s) => s.sky.phase);
  const obsId = useView((s) => s.sky.obsId);
  const active = (phase === 'entering' || phase === 'on') && !!obsId;
  const root = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current, tipEl = tip.current;
    const container = el?.closest<HTMLElement>('.sky-curtain');
    if (!active || !obsId || !el || !tipEl || !container) return;
    const store = useStore;
    const tint = (id: string): string | undefined => {
      const rec = store.getState().entities.get(id);
      return rec ? `var(--c-${colorKeyOf(rec)})` : undefined;
    };
    const rings = new LabelLayer(el, 'sky-ring', tint);
    const labels = new LabelLayer(el, 'scene-label sky-label mono', tint);
    const ringItems: LabelItem[] = [];
    const labelItems: LabelItem[] = [];
    const placed: Placed[] = [];
    /** the placed markers as hit-test points (reused) */
    const pts: { id: string; x: number; y: number }[] = [];
    let markers: SkyMarker[] = [];
    let ground: { lat: number; lon: number } | null = null;
    let bodyRecs: EntityRecord[] = [];
    let shapeKey = -1;
    let ctxKey: unknown[] = [];
    let ctx = { focus: new Set<string>(), text: null as ReadonlySet<string> | null };
    let lastWall = -1e9, lastSim = NaN, rev = 0;
    let sig = '';
    let hoverId: string | null = null;
    let tipText = '';
    let ptr: { x: number; y: number } | null = null;
    let down: { x: number; y: number } | null = null;
    let lastTurn: string | null = null;
    let pressed = false;
    let raf = 0;

    // --- markers
    const isHidden = (rec: EntityRecord): boolean => !isDrawn(classify(rec, store.getState().query, ctx));
    const recompute = (t: number): void => {
      const s = store.getState();
      if (s.catalogShape !== shapeKey || bodyRecs.length === 0) {
        shapeKey = s.catalogShape;
        bodyRecs = [];
        for (const r of s.entities.values()) if (bodyOf(r) !== undefined) bodyRecs.push(r);
      }
      if (ctxKey[0] !== s.selectedId || ctxKey[1] !== s.textIds) {
        ctxKey = [s.selectedId, s.textIds];
        ctx = { focus: s.selectedId ? new Set([s.selectedId]) : new Set<string>(), text: s.textIds };
      }
      const rec = s.entities.get(obsId);
      let obs: SkyObserver | null = null;
      if (rec) {
        ensureInGraph(rec);
        obs = observerFor(rec, t, (id, tt) => graph.stateIn(id, tt, 'EARTH:inertial'));
        const p = rec.provider;
        ground = p && p.type === 'geodetic' && p.bodyId === 'EARTH' ? { lat: p.latDeg, lon: p.lonDeg } : null;
      }
      markers = obs ? selectBodies(bodyRecs, { tMs: t, observer: obs, isHidden }) : [];
      rev++;
    };
    const markerById = (id: string): SkyMarker | undefined => markers.find((m) => m.id === id);

    // --- projection
    let center = { raDeg: 0, decDeg: 0 };
    const project = (ra: number, dec: number, out: [number, number]): boolean => {
      const v = liveSkyView();
      if (!v) return false;
      if (separationDeg(center, { raDeg: ra, decDeg: dec }) > MAX_SEP_DEG) return false;
      const p = v.world2pix(ra, dec);
      if (!p) return false;
      out[0] = p[0];
      out[1] = p[1];
      return true;
    };

    // --- tooltip
    const showTip = (): void => {
      const m = hoverId ? markerById(hoverId) : undefined;
      if (!m || !ptr) {
        tipText = '';
        tipEl.style.display = 'none';
        return;
      }
      const text = markerTip(m, ground ? markerAzEl(m, clock.now(), ground.lat, ground.lon) : null).join('\n');
      if (text !== tipText) {
        tipText = text;
        tipEl.textContent = text;
      }
      tipEl.style.display = 'block';
      const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
      const x = ptr.x + 14 + w > el.clientWidth ? ptr.x - 14 - w : ptr.x + 14;
      const y = ptr.y + 14 + h > el.clientHeight ? ptr.y - 14 - h : ptr.y + 14;
      tipEl.style.transform = `translate(${Math.max(0, Math.round(x))}px, ${Math.max(0, Math.round(y))}px)`;
    };

    // --- one frame
    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const v = liveSkyView();
      const W = el.clientWidth, H = el.clientHeight;
      if (!v || W === 0 || H === 0) return;
      const fov = v.fov(), c = v.center();
      if (fov === null || !c) return;
      center = c;
      const t = clock.now(), wall = performance.now();
      if (wall - lastWall >= RECOMPUTE_MS || Math.abs(t - lastSim) > SIM_STEP_MS) {
        lastWall = wall;
        lastSim = t;
        recompute(t);
      }
      const sel = store.getState().selectedId;
      const showLabels = useView.getState().labels;
      const key = `${rev}|${c.raDeg}|${c.decDeg}|${fov}|${v.rotation()}|${W}|${H}|${sel}|${hoverId}|${showLabels}`;
      if (key === sig) return;
      sig = key;
      declutter(markers, fov, W, H, project, placed);
      let n = 0;
      for (let i = 0; i < placed.length; i++) {
        const { marker: m, x, y } = placed[i];
        const cls = (m.id === sel ? 'selected ' : '') + (m.id === hoverId ? 'hover ' : '') + (m.hidden ? 'dim' : '');
        const opacity = m.hidden ? DIM_OPACITY : 1;
        const r = (ringItems[n] ??= { id: '', text: '', x: 0, y: 0 });
        r.id = m.id; r.x = x - RING_PX / 2; r.y = y - RING_PX / 2; r.opacity = opacity; r.cls = cls.trim();
        const l = (labelItems[n] ??= { id: '', text: '', x: 0, y: 0 });
        l.id = m.id; l.text = labelText(m.name); l.x = x + LABEL_DX; l.y = y + LABEL_DY; l.opacity = opacity; l.cls = cls.trim();
        const pt = (pts[n] ??= { id: '', x: 0, y: 0 });
        pt.id = m.id; pt.x = x; pt.y = y;
        n++;
      }
      pts.length = n;
      rings.update(ringItems, n);
      labels.update(labelItems, showLabels ? n : 0);
      // the markers moved under a resting pointer (the clock, a turn): what is hovered now is not what was
      if (ptr && !pressed) {
        const id = hitAt(ptr);
        if (id !== hoverId) setHover(id);
      }
      if (hoverId || tipText) showTip(); // and the tooltip says where the marker is now (or goes)
    };

    // --- pointer: listen on the Aladin container, never stop an event
    const local = (e: MouseEvent): { x: number; y: number } => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onAladin = (e: Event): boolean => !(e.target as HTMLElement).closest('.sky-bar, .sky-msg');
    const hitAt = (p: { x: number; y: number }): string | null => nearestMarker(pts, p.x, p.y, MARKER_HIT_PX);
    const setHover = (id: string | null): void => {
      hoverId = id;
      container.classList.toggle('sky-hit', id !== null);
      sig = ''; // redraw the hovered ring
    };
    const onDown = (e: PointerEvent): void => {
      if (!onAladin(e)) return;
      down = local(e);
      pressed = true;
      liveSkyView()?.stopAnimation(); // the user takes the view over
    };
    const onMove = (e: PointerEvent): void => {
      if (!onAladin(e)) return;
      ptr = local(e);
      pressed = e.buttons !== 0;
      const id = pressed ? null : hitAt(ptr);
      if (id !== hoverId) setHover(id);
      showTip();
    };
    const onUp = (): void => { pressed = false; };
    const onLeave = (): void => {
      ptr = null;
      if (hoverId) setHover(null);
      showTip();
    };
    const onClick = (e: MouseEvent): void => {
      if (e.button !== 0 || !onAladin(e)) return;
      const p = local(e);
      if (down && isDragMove(p.x - down.x, p.y - down.y)) return; // Aladin panned
      const act = markerClick(hitAt(p), e.detail, lastTurn);
      lastTurn = act?.kind === 'turn' ? act.id : null;
      if (!act) return;
      store.getState().selectObject(act.id); // the only way to select
      if (act.kind === 'leave') {
        leaveSkyView();
        return;
      }
      const m = markerById(act.id);
      const v = liveSkyView();
      if (!m || !v) return;
      v.animateTo(m.raDeg, m.decDeg, TURN_MS);
      // the paused scene looks the same way, so a later leave or transition starts from the same direction
      const cam = runtime.camera, pose = cam?.firstPersonPose();
      if (cam && pose) cam.setFirstPersonLook(lookDirTo(m.raDeg, m.decDeg, clock.now()), pose.vFovDeg);
    };
    container.addEventListener('pointerdown', onDown, true);
    container.addEventListener('pointermove', onMove, true);
    container.addEventListener('pointerup', onUp, true);
    container.addEventListener('pointerleave', onLeave); // not in the capture phase: it would fire for every child that is left
    container.addEventListener('click', onClick, true);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener('pointerdown', onDown, true);
      container.removeEventListener('pointermove', onMove, true);
      container.removeEventListener('pointerup', onUp, true);
      container.removeEventListener('pointerleave', onLeave);
      container.removeEventListener('click', onClick, true);
      container.classList.remove('sky-hit');
      tipEl.style.display = 'none';
      rings.dispose();
      labels.dispose();
    };
  }, [active, obsId]);

  return (
    <div ref={root} className="sky-markers">
      <div ref={tip} className="sky-tip" />
    </div>
  );
}
