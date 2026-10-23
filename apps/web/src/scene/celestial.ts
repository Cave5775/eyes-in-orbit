import * as THREE from 'three';
import { MOON, SUN, inertialToFixedMatrix, moonPositionEci, sunPositionEci, transpose } from '@eio/core';
import { createMoonMaterial } from './materials';

/**
 * The Moon and the Sun at true size and position. Like the Earth they are placed camera-relative (float64 position
 * minus the floating origin, which is the camera in Earth-inertial coordinates), so a camera 3,000 km from the Moon or
 * 1.5e8 km from the Earth sees them without float32 jitter. Neither is pickable.
 */
export class CelestialLayer {
  private readonly moon: THREE.Mesh;
  private readonly moonMat: THREE.ShaderMaterial;
  private readonly sun: THREE.Mesh;
  private readonly glow: THREE.Sprite;
  private readonly rot = new THREE.Matrix4();
  private disposed = false;
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

  /** Place both bodies for sim time `t`; `origin` is the camera in Earth-inertial coordinates (the floating origin). */
  update(t: number, origin: THREE.Vector3): void {
    const m = moonPositionEci(t);
    this.moon.position.set(m[0] - origin.x, m[1] - origin.y, m[2] - origin.z);
    // body-fixed to inertial is the transpose of the IAU inertial-to-fixed matrix
    const R = transpose(inertialToFixedMatrix(MOON, t));
    this.rot.set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
    this.moon.quaternion.setFromRotationMatrix(this.rot);

    const s = sunPositionEci(t);
    this.sun.position.set(s[0] - origin.x, s[1] - origin.y, s[2] - origin.z);
    this.glow.position.copy(this.sun.position);
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
