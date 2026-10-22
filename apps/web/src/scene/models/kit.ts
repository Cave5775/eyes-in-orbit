import * as THREE from 'three';
import type { ModelInstance, ModelUpdate } from './types';

/** Axis a named joint turns about, in the joint node's parent frame. */
export type JointAxis = 'x' | 'y' | 'z';

/**
 * Small construction kit for procedural models: shared materials (dimmable), primitives positioned in one call, and
 * named joints. Units are metres; the layer scales the finished group.
 */
export class ModelKit {
  readonly root = new THREE.Group();
  private mats = new Map<string, { mat: THREE.MeshStandardMaterial; base: THREE.Color }>();
  private disposables: { dispose(): void }[] = [];
  private jointNodes = new Map<string, { node: THREE.Object3D; axis: JointAxis }>();

  /** Shared material by name (created on first use). Colours are display-space (no colour management). */
  mat(name: string, color: number, opts: { metalness?: number; roughness?: number; emissive?: number; side?: THREE.Side; map?: THREE.Texture } = {}): THREE.MeshStandardMaterial {
    const have = this.mats.get(name);
    if (have) return have.mat;
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness: opts.metalness ?? 0.2,
      roughness: opts.roughness ?? 0.6,
      emissive: opts.emissive ?? 0x000000,
      side: opts.side ?? THREE.FrontSide,
      map: opts.map ?? null,
    });
    this.mats.set(name, { mat, base: mat.color.clone() });
    this.disposables.push(mat);
    if (opts.map) this.disposables.push(opts.map);
    return mat;
  }

  geo<T extends THREE.BufferGeometry>(g: T): T {
    this.disposables.push(g);
    return g;
  }

  box(parent: THREE.Object3D, mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
    const m = new THREE.Mesh(this.geo(new THREE.BoxGeometry(sx, sy, sz)), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  /** Cylinder along +X (`axis` x), +Y or +Z with radius `r` and length `len`, centred at (x, y, z). */
  cyl(parent: THREE.Object3D, mat: THREE.Material, axis: JointAxis, r: number, len: number, x = 0, y = 0, z = 0, rTop = r, segs = 20): THREE.Mesh {
    const g = this.geo(new THREE.CylinderGeometry(rTop, r, len, segs));
    // CylinderGeometry stands along +Y: tip it onto the requested axis
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  sphere(parent: THREE.Object3D, mat: THREE.Material, r: number, x = 0, y = 0, z = 0, segs = 16): THREE.Mesh {
    const m = new THREE.Mesh(this.geo(new THREE.SphereGeometry(r, segs, segs / 2)), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  group(parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  }

  /** Register a node as a named joint turning about `axis`. */
  joint(name: string, node: THREE.Object3D, axis: JointAxis): THREE.Object3D {
    this.jointNodes.set(name, { node, axis });
    return node;
  }

  get jointNames(): string[] {
    return [...this.jointNodes.keys()];
  }

  setJoint(name: string, rad: number): void {
    const j = this.jointNodes.get(name);
    if (!j || !Number.isFinite(rad)) return;
    j.node.rotation[j.axis] = rad;
  }

  dim(on: boolean): void {
    const k = on ? 0.3 : 1;
    for (const { mat, base } of this.mats.values()) mat.color.copy(base).multiplyScalar(k);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  /** ModelInstance for a kit whose joints are driven only through `ModelUpdate.joints`; `extra` runs each update. */
  instance(extra?: (u: ModelUpdate) => void): ModelInstance {
    return {
      root: this.root,
      joints: this.jointNames,
      update: (u) => {
        if (u.joints) for (const [name, rad] of Object.entries(u.joints)) this.setJoint(name, rad);
        extra?.(u);
      },
      setDim: (on) => this.dim(on),
      dispose: () => this.dispose(),
    };
  }
}

/** Canvas-drawn solar-cell texture (no image assets): dark blue cells with lighter grid lines. */
export function solarCellTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1c3a78';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#244a96';
  g.fillRect(2, 2, 60, 60);
  g.strokeStyle = '#8fa8d8';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 62, 62);
  g.beginPath();
  g.moveTo(32, 0);
  g.lineTo(32, 64);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}
