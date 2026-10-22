import * as THREE from 'three';

const MAX_DIST = 3e7;
const MAX_EL = 1.5;

export interface FlyOptions {
  dist: number;
  az: number;
  el: number;
  durationMs?: number;
}

const ease = (u: number) => u * u * (3 - 2 * u);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Orbit camera around a (possibly moving) target with z-up. Left drag orbits, right/shift drag
 * pans, wheel and pinch zoom logarithmically (distance in km). Any user input cancels a fly-to.
 */
export class OrbitRig {
  az = 0.6;
  el = 0.45;
  dist = 24000;
  minDist = 20;
  /** pan offset added to the followed/free anchor */
  readonly pan = new THREE.Vector3();
  readonly target = new THREE.Vector3();
  onUserInput?: () => void;

  private flight: { t0: number; dur: number; from: THREE.Vector3; fromDist: number; fromAz: number; fromEl: number; to: FlyOptions } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinch = 0;
  private readonly offset = new THREE.Vector3();
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
      this.cancelFlight();
      if (this.pointers.size === 2) {
        const d = this.pinchDistance();
        if (this.lastPinch > 0 && d > 0) this.zoomBy(this.lastPinch / d);
        this.lastPinch = d;
      } else if (e.buttons & 2 || e.buttons & 4 || e.shiftKey) this.panBy(dx, dy);
      else this.orbitBy(dx, dy);
    };
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.lastPinch = this.pinchDistance();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.cancelFlight();
      const unit = e.deltaMode === 1 ? 16 : 1;
      this.zoomBy(Math.exp(e.deltaY * unit * 0.0013));
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
    return this.flight !== null;
  }

  flyTo(to: FlyOptions): void {
    this.flight = { t0: performance.now(), dur: to.durationMs ?? 1300, from: this.target.clone(), fromDist: this.dist, fromAz: this.az, fromEl: this.el, to };
    this.pan.set(0, 0, 0);
  }

  /** Advance one frame. `anchor` is the live world position being followed, or null for the free target. */
  update(anchor: THREE.Vector3 | null, freeTarget: THREE.Vector3, now = performance.now()): void {
    const base = (anchor ?? freeTarget);
    const goal = this.offset.copy(base).add(this.pan);
    const f = this.flight;
    if (f) {
      const u = Math.min(1, (now - f.t0) / f.dur);
      const k = ease(u);
      this.target.lerpVectors(f.from, goal, k);
      this.dist = Math.exp(Math.log(f.fromDist) + (Math.log(f.to.dist) - Math.log(f.fromDist)) * k);
      this.az = f.fromAz + wrapAngle(f.to.az - f.fromAz) * k;
      this.el = f.fromEl + (f.to.el - f.fromEl) * k;
      if (u >= 1) this.flight = null;
    } else this.target.copy(goal);

    this.dist = Math.min(MAX_DIST, Math.max(this.minDist, this.dist));
    const ce = Math.cos(this.el);
    this.camera.position.set(
      this.target.x + this.dist * ce * Math.cos(this.az),
      this.target.y + this.dist * ce * Math.sin(this.az),
      this.target.z + this.dist * Math.sin(this.el),
    );
    this.camera.lookAt(this.target);
  }

  private cancelFlight(): void {
    this.flight = null;
    this.onUserInput?.();
  }

  private orbitBy(dx: number, dy: number): void {
    this.az -= dx * 0.0055;
    this.el = Math.max(-MAX_EL, Math.min(MAX_EL, this.el + dy * 0.0055));
  }

  private panBy(dx: number, dy: number): void {
    const k = (2 * this.dist * Math.tan((this.camera.fov * Math.PI) / 360)) / this.dom.clientHeight;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.pan.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  }

  private zoomBy(factor: number): void {
    this.dist = Math.min(MAX_DIST, Math.max(this.minDist, this.dist * factor));
  }

  private pinchDistance(): number {
    if (this.pointers.size < 2) return 0;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}
