import * as THREE from 'three';
import { MOON, SUN, inertialToFixedMatrix, transpose } from '@eio/core';
import type { DistanceScale } from '../lib/deepspace';
import type { OccluderSphere } from '../lib/occlusion';
import { refDisplay } from '../lib/ref-body';
import { createMoonMaterial } from './materials';

/**
 * The Moon and the Sun at true size, at their true positions or (compressed distance scale) on the deep-space shell.
 * Like the Earth they are placed camera-relative (float64 position minus the floating origin, which is the camera in
 * display coordinates), so a camera 3,000 km from the Moon or 1.5e8 km from the Earth sees them without float32 jitter.
 * Neither is pickable.
 */
export class CelestialLayer {
  private readonly moon: THREE.Mesh;
  private readonly moonMat: THREE.ShaderMaterial;
  private readonly sun: THREE.Mesh;
  private readonly glow: THREE.Sprite;
  private readonly rot = new THREE.Matrix4();
  private disposed = false;
  /** displayed Moon and Sun, for the point shader's and the pickers' occlusion test; radius 0 until the first update */
  private readonly spheres: OccluderSphere[] = [
    { c: [0, 0, 0], r: 0 },
    { c: [0, 0, 0], r: 0 },
  ];
  /** 'texture' once /textures/moon.jpg has loaded */
  mode: 'texture' | 'procedural' = 'procedural';

  constructor(scene: THREE.Scene, sunDir: THREE.Vector3) {
    // same convention as the Earth: local z = pole, +x = prime meridian
    const mg = new THREE.SphereGeometry(MOON.radiusKm, 128, 64);
    mg.rotateX(Math.PI / 2);
    this.moonMat = createMoonMaterial(sunDir, null);
    this.moon = new THREE.Mesh(mg, this.moonMat);

    this.sun = new THREE.Mesh(
      new THREE.SphereGeometry(SUN.radiusKm, 64, 32),
      new THREE.MeshBasicMaterial({ color: 0xfff1cf, toneMapped: false }),
    );

    const glowMat = new THREE.SpriteMaterial({
      map: radialGlow(),
      color: 0xffe2a8,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.glow = new THREE.Sprite(glowMat);
    this.glow.scale.setScalar(SUN.radiusKm * 9);

    for (const o of [this.moon, this.sun, this.glow]) {
      o.frustumCulled = false; // positions are huge and re-derived every frame; three's bounding sphere would be stale
      scene.add(o);
    }
    this.loadMoonTexture();
  }

  private loadMoonTexture(): void {
    new THREE.TextureLoader().load(
      '/textures/moon.jpg',
      (tex) => {
        if (this.disposed) return tex.dispose();
        tex.colorSpace = THREE.NoColorSpace;
        this.moonMat.uniforms.uTex.value = tex;
        this.moonMat.uniforms.uHasTex.value = 1;
        this.mode = 'texture';
      },
      undefined,
      () => undefined, // missing/invalid texture: procedural shading stays
    );
  }

  /**
   * Place both bodies for sim time `t`; `origin` is the camera in display space (the floating origin). Positions follow
   * the distance scale like any entity: in compressed mode the Sun is drawn on the deep-space shell and shrunk by the
   * same factor (same direction, same angular size); the Moon is inside the shell threshold and stays put.
   */
  update(t: number, origin: THREE.Vector3, scale: DistanceScale): void {
    const m = refDisplay('MOON', t, scale);
    this.moon.position.set(m.r[0] - origin.x, m.r[1] - origin.y, m.r[2] - origin.z);
    this.moon.scale.setScalar(m.k);
    // body-fixed to inertial is the transpose of the IAU inertial-to-fixed matrix
    const R = transpose(inertialToFixedMatrix(MOON, t));
    this.rot.set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
    this.moon.quaternion.setFromRotationMatrix(this.rot);

    const s = refDisplay('SUN', t, scale);
    this.sun.position.set(s.r[0] - origin.x, s.r[1] - origin.y, s.r[2] - origin.z);
    this.sun.scale.setScalar(s.k);
    this.glow.position.copy(this.sun.position);
    this.glow.scale.setScalar(SUN.radiusKm * 9 * s.k);

    this.spheres[0].c = m.r;
    this.spheres[0].r = MOON.radiusKm * m.k;
    this.spheres[1].c = s.r;
    this.spheres[1].r = SUN.radiusKm * s.k;
  }

  /** The Moon and the Sun as displayed at the last `update` (display-space centre, displayed radius): [moon, sun]. */
  occluders(): readonly OccluderSphere[] {
    return this.spheres;
  }

  dispose(): void {
    this.disposed = true;
    (this.glow.material as THREE.SpriteMaterial).map?.dispose();
  }
}

/** Soft white-to-transparent disc for the Sun's glow. */
function radialGlow(): THREE.Texture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.12, 'rgba(255,255,255,0.45)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}
