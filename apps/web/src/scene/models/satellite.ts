import * as THREE from 'three';
import { ModelKit, solarCellTexture } from './kit';
import type { ModelDef, ModelInstance } from './types';

/**
 * Generic satellite, about 3 m bus and 14 m across the panels: a box bus, two solar panels on booms that turn about the
 * Y axis to face the Sun (joint `panel`; with no joint given they track the sun vector themselves), a dish and an
 * antenna. Body frame +X forward, +Y starboard, +Z nadir.
 */
function buildSatellite(): ModelInstance {
  const k = new ModelKit();
  const bus = k.mat('bus', 0xc8ccd2, { metalness: 0.55, roughness: 0.4 });
  const gold = k.mat('mli', 0xc79a3b, { metalness: 0.6, roughness: 0.45 });
  const dark = k.mat('dark', 0x40444b, { metalness: 0.4, roughness: 0.6 });
  const cell = solarCellTexture();
  cell.repeat.set(5, 14);
  const cells = k.mat('cells', 0xffffff, { metalness: 0.5, roughness: 0.35, map: cell, side: THREE.DoubleSide, emissive: 0x050a14 });
  k.box(k.root, gold, 2.6, 1.8, 1.9, 0, 0, 0);
  k.box(k.root, bus, 2.7, 1.2, 0.3, 0, 0, -1.05);
  k.cyl(k.root, dark, 'z', 0.9, 0.25, 0.4, 0, 1.1, 0.25, 24); // nadir-pointing dish
  k.cyl(k.root, dark, 'z', 0.05, 2.2, -0.9, 0.5, -2.0);
  // panels: a yoke on the Y axis, each panel a thin plate 3 m (x) by 6.2 m (y)
  const yoke = k.group(k.root, 0, 0, 0);
  k.joint('panel', yoke, 'y');
  for (const s of [-1, 1]) {
    k.cyl(yoke, dark, 'y', 0.07, 1.4, 0, s * 1.3, 0);
    const panel = new THREE.Mesh(k.geo(new THREE.BoxGeometry(3, 6.2, 0.06)), cells);
    panel.rotation.x = 0;
    panel.position.set(0, s * (2 + 3.1), 0);
    yoke.add(panel);
  }
  return k.instance((u) => {
    if (u.joints && 'panel' in u.joints) return;
    // face the panels (normal = body Z at zero) toward the Sun by turning about Y
    k.setJoint('panel', Math.atan2(u.sunBody[0], u.sunBody[2]));
  });
}

export const SATELLITE_MODEL: ModelDef = {
  key: 'satellite',
  label: 'Generic satellite',
  radiusM: 8,
  lodKm: 6,
  minViewKm: 0.012,
  fitKm: 0.04,
  attitude: 'lvlh',
  build: buildSatellite,
};
