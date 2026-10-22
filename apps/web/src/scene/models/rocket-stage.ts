import * as THREE from 'three';
import { ModelKit } from './kit';
import type { ModelDef, ModelInstance } from './types';

/**
 * Generic reusable booster stage, Falcon 9 first-stage proportions: 41 m long, 3.7 m wide, nose along +X, a nine-engine
 * cluster at the tail, four landing legs and four grid fins. Body frame +X forward, +Y starboard, +Z nadir.
 */
function buildRocketStage(): ModelInstance {
  const k = new ModelKit();
  const white = k.mat('body', 0xe8e8e4, { metalness: 0.15, roughness: 0.6 });
  const black = k.mat('interstage', 0x1e2024, { metalness: 0.2, roughness: 0.7 });
  const metal = k.mat('metal', 0x7d8087, { metalness: 0.7, roughness: 0.4 });
  const soot = k.mat('soot', 0x30302f, { metalness: 0.3, roughness: 0.8 });
  const L = 41.2, R = 1.83;
  const x0 = -L / 2;
  k.cyl(k.root, white, 'x', R, L - 7.5, x0 + (L - 7.5) / 2, 0, 0, R, 32);
  k.cyl(k.root, black, 'x', R, 7.5, L / 2 - 3.75, 0, 0, R * 0.98, 32); // interstage
  k.cyl(k.root, black, 'x', R * 0.5, 0.5, L / 2 + 0.2, 0, 0, R, 24); // adapter
  // engine bay: octaweb plate and nine bells
  k.cyl(k.root, soot, 'x', R, 0.5, x0 - 0.1, 0, 0, R, 32);
  const bell = (y: number, z: number) => k.cyl(k.root, metal, 'x', 0.55, 1.6, x0 - 0.9, y, z, 0.2, 14);
  bell(0, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    bell(Math.cos(a) * 1.12, Math.sin(a) * 1.12);
  }
  // landing legs: a strut from the lower body to a foot, 45 degrees apart from the fins
  const leg = new THREE.CylinderGeometry(0.1, 0.12, 9, 8);
  k.geo(leg);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const dir = new THREE.Vector3(0, Math.cos(a), Math.sin(a));
    const start = new THREE.Vector3(x0 + 5, dir.y * R, dir.z * R);
    const end = new THREE.Vector3(x0 - 1.4, dir.y * 7.2, dir.z * 7.2);
    const m = new THREE.Mesh(leg, metal);
    m.position.copy(start).add(end).multiplyScalar(0.5);
    m.scale.y = start.distanceTo(end) / 9;
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());
    k.root.add(m);
    k.sphere(k.root, metal, 0.45, end.x, end.y, end.z, 8);
  }
  // grid fins near the top
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const fin = k.box(k.root, metal, 1.2, 0.12, 1.8, L / 2 - 2, 0, 0);
    fin.position.set(L / 2 - 2, Math.cos(a) * (R + 0.9), Math.sin(a) * (R + 0.9));
    fin.rotation.x = a;
  }
  return k.instance();
}

export const ROCKET_STAGE_MODEL: ModelDef = {
  key: 'rocket-stage',
  label: 'Booster stage',
  radiusM: 22,
  lodKm: 12,
  minViewKm: 0.012,
  fitKm: 0.12,
  attitude: 'rocket',
  build: buildRocketStage,
};
