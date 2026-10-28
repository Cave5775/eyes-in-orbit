import * as THREE from 'three';
import type { V3 } from '../lib/camera';
import { spinOf, toCameraRelative, type Spin } from '../lib/floating-origin';

/**
 * Per-frame render transform of the floating origin: the camera's world position (float64) and the Earth's spin.
 * Every GPU-side position is `world - origin`, computed on the CPU in float64 (see `lib/floating-origin.ts`).
 */
export class RenderFrame {
  readonly origin = new THREE.Vector3();
  gmst = 0;
  spin: Spin = { cos: 1, sin: 0 };

  set(origin: THREE.Vector3, gmstRad: number): void {
    this.origin.copy(origin);
    this.gmst = gmstRad;
    this.spin = spinOf(gmstRad);
  }

  get originV3(): V3 {
    return [this.origin.x, this.origin.y, this.origin.z];
  }
}

/**
 * Vertex positions held in float64 world coordinates (km, Earth-inertial, or Earth-fixed when `fixed`), with a float32
 * attribute that is refilled camera-relative every frame by `upload`. The world array may be supplied (the SGP4
 * worker's buffer) or is owned.
 */
export class RelPositions {
  readonly world: Float64Array;
  readonly attr: THREE.BufferAttribute;
  /** world array holds Earth-fixed coordinates (rotated by the Earth's spin on upload) */
  fixed: boolean;
  /** points to upload (<= capacity) */
  count: number;
  /**
   * World translation added to every inertial point on upload, km (ignored when `fixed`). A path or orbit line built
   * around a moving frame centre is shifted with the centre between rebuilds. Zero by default.
   */
  shift: readonly [number, number, number] = [0, 0, 0];

  constructor(capacityOrWorld: number | Float64Array, fixed = false) {
    this.world = typeof capacityOrWorld === 'number' ? new Float64Array(capacityOrWorld * 3) : capacityOrWorld;
    this.attr = new THREE.BufferAttribute(new Float32Array(this.world.length), 3).setUsage(THREE.DynamicDrawUsage);
    this.fixed = fixed;
    this.count = this.world.length / 3;
  }

  setXYZ(i: number, x: number, y: number, z: number): void {
    this.world[i * 3] = x;
    this.world[i * 3 + 1] = y;
    this.world[i * 3 + 2] = z;
  }

  /** Refill the GPU attribute relative to the frame's origin. */
  upload(f: RenderFrame, count = this.count): void {
    const s = this.shift;
    // world + shift - origin = world - (origin - shift)
    const origin: V3 = this.fixed || (s[0] === 0 && s[1] === 0 && s[2] === 0) ? f.originV3 : [f.origin.x - s[0], f.origin.y - s[1], f.origin.z - s[2]];
    toCameraRelative(this.world, this.attr.array as Float32Array, count, origin, f.spin, this.fixed);
    this.attr.needsUpdate = true;
  }

  /** World (inertial) position of point `i`, float64. */
  worldOf(i: number, spin: Spin, out: THREE.Vector3): THREE.Vector3 {
    const w = this.world, x = w[i * 3], y = w[i * 3 + 1];
    if (this.fixed) return out.set(spin.cos * x - spin.sin * y, spin.sin * x + spin.cos * y, w[i * 3 + 2]);
    return out.set(x + this.shift[0], y + this.shift[1], w[i * 3 + 2] + this.shift[2]);
  }
}
