import * as THREE from 'three';
import { localAngles, localOffsetDir, type LocalBasis } from '../lib/traverse';
import { FP_LOOK_KM, clampFpEl, firstPersonDrag, firstPersonEye, firstPersonLookDir, zoomFov } from '../lib/first-person';
import {
  MAX_DIST_KM, MIN_ALT_KM, advanceSurfaceFrame, altitudeOf, blendPosition, ellipsoidUp, groundPanDelta, minElevation, slerpDir, zoomDistance, type SurfaceFrame, type V3,
} from '../lib/camera';
import { Damper, frameDt, type SmoothParams } from '../lib/smoothing';

const MAX_EL = 1.5;

export interface FlyOptions {
  dist: number;
  az: number;
  el: number;
  durationMs?: number;
  /**
   * Globe mode: `az` and `el` are measured in this local east/north/up frame (a surface site's, which the planet's rotation turns)
   * instead of the world axes, re-read every frame while following, so the camera keeps its side and height over the site. Any
   * later fly-to without it (and a mode switch) goes back to world angles.
   */
  local?: () => LocalBasis | null;
}

export type RigMode = 'globe' | 'surface' | 'firstPerson';

const ease = (u: number) => u * u * (3 - 2 * u);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const tup = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];

/**
 * Orbit camera around a (possibly moving) target. Two modes:
 *  - `globe`: world z is up (the Earth's axis); az/el are measured in the world frame.
 *  - `surface`: the target is an object (or a ground point) and the frame is its local east/north/up, so "up" on screen is
 *    the local vertical, the horizon is level and az = -90 deg looks north. The frame is north-up but carried along the
 *    ground (see `advanceSurfaceFrame`), so the view does not spin when the target passes over a pole.
 *  - `firstPerson`: the camera stands at the followed object (its eye, see `firstPersonEye`) and looks outward in the same local
 *    east/north/up frame; `az` is a compass bearing (0 = north, clockwise) and `el` the elevation above the horizon. Left drag turns
 *    the view, wheel and pinch change the camera's field of view (the camera does not move), pan is off. The look-at `target` is
 *    `FP_LOOK_KM` ahead of the eye (for the scope policy and the mode transition's aim); `dist` is that distance.
 * Left drag orbits, right/shift drag pans (in surface mode it slides the target along the ground, see `onGroundPan`), wheel and pinch zoom with a step proportional to the height
 * above the surface (see `zoomDistance`). Any user input cancels a fly-to or a mode transition.
 *
 * Smoothing (`smoothing` returns its parameters, null = off = input is applied the moment it arrives, as it always was): orbit,
 * pan and zoom input is added to dampers (lib/smoothing.ts) and a fraction `1 - exp(-dt / tau)` of it is applied each `update`, so
 * the motion eases in and, once the pointer is released, glides to a stop (inertia). The first-person view is never smoothed: it
 * drags the sky, which must stay under the pointer (and the Sky view mirrors its az/el). Every limit (altitude floor, distance and
 * elevation clamps, the surface frame) is applied to the damped motion exactly as to direct input. A fly-to, a mode switch and
 * `stopInertia` drop what is still gliding.
 */
export class OrbitRig {
  az = 0.6;
  el = 0.45;
  dist = 24000;
  /** closest camera-to-target distance; the controller sets it per frame (Earth centre vs an object vs the ground) */
  minDist = 20;
  /** farthest camera-to-target distance; 3e7 km, or 1e11 km when probes are drawn at their real distances */
  maxDist = MAX_DIST_KM;
  mode: RigMode = 'globe';
  /** pan offset added to the followed/free anchor */
  readonly pan = new THREE.Vector3();
  readonly target = new THREE.Vector3();
  onUserInput?: () => void;
  /** the camera smoothing parameters for this moment, or null when input must be applied directly (see the class comment) */
  smoothing: (() => SmoothParams | null) | null = null;
  /** surface mode: a pan drag asks to move the ground target by this many km along the frame's east and north axes */
  onGroundPan?: (eastKm: number, northKm: number, frame: SurfaceFrame) => void;
  /** surface mode: the horizontal frame of the last update (null until the first update after entering the mode) */
  frame: SurfaceFrame | null = null;
  /** the local frame the globe-mode angles are in (see `FlyOptions.local`); null: world axes */
  offsetFrame: (() => LocalBasis | null) | null = null;

  private flight: { t0: number; dur: number; from: THREE.Vector3; fromDist: number; fromAz: number; fromEl: number; to: FlyOptions } | null = null;
  private blend: { t0: number; dur: number; pos: THREE.Vector3; up: THREE.Vector3; fresh: boolean } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private readonly orbitD = new Damper(2);
  private readonly panD = new Damper(2);
  /** pending zoom as a log factor (wheel: deltaY * 0.0013, the same unit the wheel always used) */
  private readonly zoomD = new Damper(1);
  private lastNow = -1;
  private lastPinch = 0;
  private readonly offset = new THREE.Vector3();
  private readonly natOffset = new THREE.Vector3();
  private readonly endPos = new THREE.Vector3();
  private readonly natUp = new THREE.Vector3(0, 0, 1);
  private readonly dispose: () => void;

  constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement) {
    camera.up.set(0, 0, 1);
    const down = (e: PointerEvent) => {
      dom.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.lastPinch = this.pinchDistance();
    };
    const move = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      this.cancelMotion();
      const smooth = this.smooth() !== null;
      if (this.pointers.size === 2) {
        const d = this.pinchDistance();
        if (this.lastPinch > 0 && d > 0) {
          if (smooth) this.zoomD.add(Math.log(this.lastPinch / d));
          else this.zoomBy(this.lastPinch / d);
        }
        this.lastPinch = d;
      } else if (e.buttons & 2 || e.buttons & 4 || e.shiftKey) {
        if (smooth) this.panD.add(dx, dy);
        else this.panBy(dx, dy);
      } else if (smooth) this.orbitD.add(dx, dy);
      else this.orbitBy(dx, dy);
    };
    const up = (e: PointerEvent) => {
      const had = this.pointers.delete(e.pointerId);
      this.lastPinch = this.pinchDistance();
      if (had) this.releaseGlide();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.cancelMotion();
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (this.smooth()) this.zoomD.add(e.deltaY * unit * 0.0013);
      else this.zoomBy(Math.exp(e.deltaY * unit * 0.0013));
    };
    const ctxMenu = (e: Event) => e.preventDefault();
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', wheel, { passive: false });
    dom.addEventListener('contextmenu', ctxMenu);
    this.dispose = () => {
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('pointercancel', up);
      dom.removeEventListener('wheel', wheel);
      dom.removeEventListener('contextmenu', ctxMenu);
    };
  }

  destroy(): void {
    this.dispose();
  }

  get flying(): boolean {
    return this.flight !== null || this.blend !== null;
  }

  /** Camera height above the ellipsoid, km (from the last update). */
  get altitudeKm(): number {
    return altitudeOf(tup(this.camera.position));
  }

  flyTo(to: FlyOptions): void {
    if (this.blend?.fresh) {
      // asked in the same tick as the mode switch (leaving the surface view for the globe view of a new subject): no frame has been
      // drawn yet, so the destination is simply the transition's end pose, instead of a flight that starts from the old mode's angles
      this.dist = to.dist;
      this.az = to.az;
      this.el = to.el;
      this.offsetFrame = to.local ?? null;
      this.flight = null;
      this.pan.set(0, 0, 0);
      return;
    }
    // the angles the flight starts from, in the frame it ends in: a flight into a local frame starts from where the camera is now
    let fromAz = this.az, fromEl = this.el;
    const basis = to.local?.() ?? null;
    if (basis) {
      const d = this.camera.position.clone().sub(this.target);
      if (d.lengthSq() > 0) ({ az: fromAz, el: fromEl } = localAngles([d.x, d.y, d.z], basis));
    }
    this.offsetFrame = basis ? to.local! : null;
    this.stopInertia();
    this.flight = { t0: performance.now(), dur: to.durationMs ?? 1300, from: this.target.clone(), fromDist: this.dist, fromAz, fromEl, to };
    this.pan.set(0, 0, 0);
  }

  /**
   * Switch mode with a smooth transition: the camera pose (position, up vector) at the moment of the call is blended into the
   * new mode's pose over `durationMs`. The target does not blend: the camera looks at the new mode's target (the followed
   * object, the ground point, or the Earth's centre) from the first frame to the last. The up vector slerps, the camera position
   * goes round the Earth along a great circle with its height scaled steadily (`blendPosition`), so it stays above the ground
   * and the horizon of that target. Set az/el/dist for the new mode afterwards.
   */
  switchMode(mode: RigMode, durationMs = 1500): void {
    this.stopInertia();
    this.blend = {
      t0: performance.now(),
      dur: durationMs,
      pos: this.camera.position.clone(),
      up: this.camera.up.clone(),
      fresh: true,
    };
    this.flight = null;
    this.pan.set(0, 0, 0);
    this.mode = mode;
    this.frame = null;
    this.offsetFrame = null;
  }

  /** Advance one frame. `anchor` is the live world position being followed, or null for the free target. */
  update(anchor: THREE.Vector3 | null, freeTarget: THREE.Vector3, now = performance.now()): void {
    this.advanceSmoothing(this.lastNow < 0 ? 0 : frameDt(now, this.lastNow));
    this.lastNow = now;
    const base = anchor ?? freeTarget;
    const goal = this.offset.copy(base).add(this.pan);
    const f = this.flight;
    if (f) {
      const u = Math.min(1, (now - f.t0) / f.dur);
      const k = ease(u);
      // a fly-to that runs during a mode transition keeps the transition's constant target (see below), its distance/angles still blend
      if (this.blend) this.target.copy(goal);
      else this.target.lerpVectors(f.from, goal, k);
      this.dist = Math.exp(Math.log(f.fromDist) + (Math.log(f.to.dist) - Math.log(f.fromDist)) * k);
      this.az = f.fromAz + wrapAngle(f.to.az - f.fromAz) * k;
      this.el = f.fromEl + (f.to.el - f.fromEl) * k;
      if (u >= 1) this.flight = null;
    } else this.target.copy(goal);

    this.dist = Math.min(this.maxDist, Math.max(this.minDist, this.dist));

    // the mode's own ("natural") pose
    if (this.mode === 'firstPerson') {
      const eye = firstPersonEye(tup(base));
      const basis = (this.frame = advanceSurfaceFrame(this.frame, ellipsoidUp(eye)));
      this.el = clampFpEl(this.el);
      const d = firstPersonLookDir(basis, this.az, this.el);
      this.dist = FP_LOOK_KM;
      this.natOffset.set(-d[0] * FP_LOOK_KM, -d[1] * FP_LOOK_KM, -d[2] * FP_LOOK_KM);
      this.target.set(eye[0] - this.natOffset.x, eye[1] - this.natOffset.y, eye[2] - this.natOffset.z);
      this.natUp.set(basis.u[0], basis.u[1], basis.u[2]);
    } else if (this.mode === 'surface') {
      const basis = (this.frame = advanceSurfaceFrame(this.frame, ellipsoidUp(tup(this.target))));
      this.el = this.clampSurfaceEl(this.el);
      const ce = Math.cos(this.el), se = Math.sin(this.el), ca = Math.cos(this.az), sa = Math.sin(this.az);
      const { e, n, u } = basis;
      this.natOffset.set(
        this.dist * (ce * (ca * e[0] + sa * n[0]) + se * u[0]),
        this.dist * (ce * (ca * e[1] + sa * n[1]) + se * u[1]),
        this.dist * (ce * (ca * e[2] + sa * n[2]) + se * u[2]),
      );
      this.natUp.set(u[0], u[1], u[2]);
    } else {
      const local = this.offsetFrame?.() ?? null;
      if (local) {
        const d = localOffsetDir(local, this.az, this.el);
        this.natOffset.set(this.dist * d[0], this.dist * d[1], this.dist * d[2]);
      } else {
        const ce = Math.cos(this.el);
        this.natOffset.set(this.dist * ce * Math.cos(this.az), this.dist * ce * Math.sin(this.az), this.dist * Math.sin(this.el));
      }
      this.natUp.set(0, 0, 1);
    }

    const b = this.blend;
    if (b) {
      const u = Math.min(1, (now - b.t0) / b.dur);
      const k = ease(u);
      // where the mode's own pose puts the camera now (the object moves, so it is recomputed every frame)
      // the camera aims at the end pose's target (the object, the ground point or the Earth's centre) for the whole transition:
      // `this.target` is not blended, so the look direction does not sweep and a followed object stays at the screen centre
      const endTarget = tup(this.target);
      const end = this.endPos.copy(this.target).add(this.natOffset);
      const pos = blendPosition(tup(b.pos), tup(end), k, MIN_ALT_KM, endTarget);
      this.camera.position.set(pos[0], pos[1], pos[2]);
      const up = slerpDir(tup(b.up), tup(this.natUp), k);
      this.camera.up.set(up[0], up[1], up[2]);
      b.fresh = false;
      if (u >= 1) this.blend = null;
    } else {
      this.camera.position.copy(this.target).add(this.natOffset);
      this.camera.up.copy(this.natUp);
    }

    // never closer to the ground than MIN_ALT_KM, whatever the mode or pan did: lift radially and keep `dist` honest
    const p = this.camera.position;
    const alt = altitudeOf(tup(p));
    if (alt < MIN_ALT_KM && p.lengthSq() > 0) {
      p.multiplyScalar((p.length() + (MIN_ALT_KM - alt)) / p.length());
      if (!this.blend) this.dist = Math.max(this.minDist, p.distanceTo(this.target));
    }
    this.camera.lookAt(this.target);
  }

  /** The smoothing parameters, or null where input is applied directly: smoothing off, or the first-person view (see the class comment). */
  private smooth(): SmoothParams | null {
    return this.mode === 'firstPerson' ? null : this.smoothing?.() ?? null;
  }

  private get gliding(): boolean {
    return this.orbitD.active || this.panD.active || this.zoomD.active;
  }

  /** Drop what is still gliding (a new selection, a fly-to, a mode switch, the Sky view), or with `apply` apply it at once. */
  stopInertia(apply = false): void {
    if (apply) {
      this.applyOrbit(this.orbitD.flush());
      this.applyPan(this.panD.flush());
      this.applyZoom(this.zoomD.flush()[0]);
    } else {
      this.orbitD.clear();
      this.panD.clear();
      this.zoomD.clear();
    }
  }

  /** Pointer released: without inertia what is pending is applied at once, so the view ends where the pointer did. */
  private releaseGlide(): void {
    const sm = this.smooth();
    if (!sm || sm.inertia) return;
    if (this.pointers.size === 0) {
      this.applyOrbit(this.orbitD.flush());
      this.applyPan(this.panD.flush());
    }
    if (this.pointers.size < 2) this.applyZoom(this.zoomD.flush()[0]);
  }

  /** One frame of damping: apply the share of each pending motion that `dtS` seconds release. */
  private advanceSmoothing(dtS: number): void {
    if (!this.gliding) return;
    const sm = this.smooth();
    if (!sm) {
      this.stopInertia(true); // smoothing went off (or the first-person view began) with motion pending: apply it, never lose it
      return;
    }
    this.applyOrbit(this.orbitD.step(dtS, sm.orbitTau, sm.cutoff));
    this.applyPan(this.panD.step(dtS, sm.panTau, sm.cutoff));
    this.applyZoom(this.zoomD.step(dtS, sm.zoomTau, sm.cutoff * 0.0013)[0]);
  }

  private applyOrbit(v: number[]): void {
    if (v[0] === 0 && v[1] === 0) return;
    const want = this.el + v[1] * 0.0055;
    this.orbitBy(v[0], v[1]);
    // pushed against the elevation limit: what is still pending in that direction would only wind up and have to be undone later
    if (this.mode !== 'firstPerson' && Math.abs(this.el - want) > 1e-9) this.orbitD.pending[1] = 0;
  }

  private applyPan(v: number[]): void {
    if (v[0] !== 0 || v[1] !== 0) this.panBy(v[0], v[1]);
  }

  private applyZoom(logFactor: number): void {
    if (logFactor === 0) return;
    const before = this.dist;
    this.zoomBy(Math.exp(logFactor));
    // stopped by the zoom limit: drop the rest instead of letting it wind up
    if (this.mode !== 'firstPerson' && this.dist === before) this.zoomD.clear();
  }

  private cancelMotion(): void {
    this.flight = null;
    this.blend = null;
    this.onUserInput?.();
  }

  private orbitBy(dx: number, dy: number): void {
    if (this.mode === 'firstPerson') {
      const v = firstPersonDrag(this.az, this.el, dx, dy, this.camera.fov, this.dom.clientHeight);
      this.az = v.az;
      this.el = v.el;
      return;
    }
    this.az -= dx * 0.0055;
    const el = this.el + dy * 0.0055;
    this.el = this.mode === 'surface' ? this.clampSurfaceEl(el) : Math.max(-MAX_EL, Math.min(MAX_EL, el));
  }

  /** Lowest surface-view elevation: above the horizon for a ground target, lower for a high object (the camera still clears the ground). */
  private minSurfaceEl(): number {
    return minElevation(this.dist, MIN_ALT_KM, altitudeOf(tup(this.target)));
  }

  /** Surface elevation limits: above the ground limit, and never straight up or down (the vertical would be parallel to the view). */
  private clampSurfaceEl(el: number): number {
    return Math.min(MAX_EL, Math.max(this.minSurfaceEl(), -MAX_EL, el));
  }

  private panBy(dx: number, dy: number): void {
    if (this.mode === 'firstPerson') return; // no pan: the camera stays at the observatory
    const k = (2 * this.dist * Math.tan((this.camera.fov * Math.PI) / 360)) / this.dom.clientHeight;
    if (this.mode === 'surface') {
      // the target slides along the ground at its own height: the owner moves it (and stops following whatever it followed)
      const d = groundPanDelta(this.az, this.el, dx, dy, k);
      if (this.frame) this.onGroundPan?.(d.east, d.north, this.frame);
      return;
    }
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.pan.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  }

  private zoomBy(factor: number): void {
    if (this.mode === 'firstPerson') {
      // zoom is the field of view (wheel down / pinch in: wider), the camera does not move
      this.camera.fov = zoomFov(this.camera.fov, factor);
      this.camera.updateProjectionMatrix();
      return;
    }
    this.dist = zoomDistance(this.dist, factor, this.altitudeKm, {
      minDist: this.minDist,
      maxDist: this.maxDist,
      minRefFrac: this.mode === 'surface' ? 0.25 : 0,
    });
  }

  private pinchDistance(): number {
    if (this.pointers.size < 2) return 0;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}
