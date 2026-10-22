import * as THREE from 'three';
import { ModelKit, solarCellTexture } from './kit';
import type { ModelDef, ModelInstance } from './types';

/**
 * Procedural International Space Station at true size: the integrated truss is 108 m across with the array tips
 * (the usual quoted span is 109 m), the pressurized stack 73 m long. Body frame +X forward, +Y starboard, +Z nadir.
 *
 * Joints (names in `ISS_JOINTS`): `sarj.port` / `sarj.stbd` turn each outboard truss with its arrays about the Y axis (zero =
 * arrays' long axes pointing nadir/zenith, cell side facing forward); `bga.<channel>` turn one array wing about its own
 * long axis (zero = cell side facing forward). Four array pairs, two wings each, named by power channel.
 */

/** Power channels in model order: [location, channels carried, side of the pair (+1 stbd, -1 port), |y| of the mast in metres]. */
export const ISS_ARRAY_SITES = [
  { site: 'P6', side: -1, y: 48.6, channels: ['2B', '4B'] },
  { site: 'P4', side: -1, y: 36.4, channels: ['2A', '4A'] },
  { site: 'S4', side: 1, y: 36.4, channels: ['1A', '3A'] },
  { site: 'S6', side: 1, y: 48.6, channels: ['1B', '3B'] },
] as const;

export type IssChannel = (typeof ISS_ARRAY_SITES)[number]['channels'][number];
export const ISS_CHANNELS: readonly IssChannel[] = ['1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B'];
export const ISS_JOINTS: readonly string[] = ['sarj.port', 'sarj.stbd', ...ISS_CHANNELS.map((c) => `bga.${c}`)];

const TRUSS_Z = -4.8;
const TRUSS_X = 0.7;
const TRUSS_HALF = 47.5;
const SARJ_Y = 24;
const WING_LEN = 34;
const WING_W = 11.6;

function trussSpan(k: ModelKit, parent: THREE.Object3D, y0: number, y1: number): void {
  const mat = k.mat('truss', 0xb9bcc0, { metalness: 0.45, roughness: 0.5 });
  const len = Math.abs(y1 - y0), yc = (y0 + y1) / 2, h = 1.45;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(parent, mat, 'y', 0.11, len, sx * h, yc, sz * h, 0.11, 8);
  const frames = Math.max(2, Math.round(len / 4.5));
  const bar = k.geo(new THREE.BoxGeometry(2 * h, 0.1, 0.1));
  const barZ = k.geo(new THREE.BoxGeometry(0.1, 0.1, 2 * h));
  const a = new THREE.InstancedMesh(bar, mat, frames * 2);
  const b = new THREE.InstancedMesh(barZ, mat, frames * 2);
  const m = new THREE.Matrix4();
  for (let i = 0; i < frames; i++) {
    const y = Math.min(y0, y1) + (i + 0.5) * (len / frames);
    for (const s of [-1, 1]) {
      a.setMatrixAt(i * 2 + (s < 0 ? 0 : 1), m.makeTranslation(0, y, s * h));
      b.setMatrixAt(i * 2 + (s < 0 ? 0 : 1), m.makeTranslation(s * h, y, 0));
    }
  }
  parent.add(a, b);
  // equipment plates so the truss reads as more than wire
  k.box(parent, k.mat('truss-dark', 0x4a4d52, { metalness: 0.5, roughness: 0.5 }), 1.6, len, 0.12, 0, yc, -h + 0.2);
}

function solarWing(k: ModelKit, parent: THREE.Object3D, zSign: number, front: THREE.Material, back: THREE.Material): void {
  const mast = k.mat('mast', 0x9a9ea3, { metalness: 0.5, roughness: 0.5 });
  const zc = zSign * (3.0 + WING_LEN / 2);
  k.box(parent, mast, 0.5, 0.6, WING_LEN, 0, 0, zc);
  k.box(parent, mast, 0.5, WING_W, 0.5, 0, 0, zSign * (3.0 + WING_LEN)); // outer tension bar
  k.box(parent, mast, 0.5, WING_W, 0.5, 0, 0, zSign * 3.25); // inner bar
  const blanketW = (WING_W - 0.8) / 2;
  const g = k.geo(new THREE.PlaneGeometry(blanketW, WING_LEN - 0.5));
  g.rotateX(Math.PI / 2);
  g.rotateZ(Math.PI / 2); // normal +X, width along Y, length along Z
  for (const sy of [-1, 1]) {
    const yc = sy * (0.4 + blanketW / 2);
    const f = new THREE.Mesh(g, front);
    f.position.set(0.02, yc, zc);
    const bk = new THREE.Mesh(g, back);
    bk.rotation.y = Math.PI;
    bk.position.set(-0.02, yc, zc);
    parent.add(f, bk);
  }
}

function buildIss(): ModelInstance {
  const k = new ModelKit();
  const root = k.root;
  const hull = k.mat('hull', 0xdedcd4, { metalness: 0.25, roughness: 0.55 });
  const hullDark = k.mat('hull-dark', 0x8d9096, { metalness: 0.35, roughness: 0.55 });
  const gold = k.mat('gold', 0xb98a3c, { metalness: 0.6, roughness: 0.4, side: THREE.DoubleSide });
  const white = k.mat('radiator', 0xf0f0ec, { metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide });
  const cell = solarCellTexture();
  cell.repeat.set(Math.round(((WING_W - 0.8) / 2) / 0.45), Math.round(WING_LEN / 0.45));
  const cells = k.mat('cells', 0xffffff, { metalness: 0.5, roughness: 0.35, map: cell, emissive: 0x050a14 });
  const back = k.mat('wing-back', 0xa77f3c, { metalness: 0.3, roughness: 0.7 });

  // ---- pressurized stack along X (Zvezda aft ... Harmony / PMA-2 forward)
  k.cyl(root, hull, 'x', 2.2, 13, -29.5, 0, 0);
  k.cyl(root, hullDark, 'x', 1.5, 2.5, -37.25, 0, 0, 2.2); // Zvezda aft cone
  k.cyl(root, hull, 'x', 1.1, 6.5, -41.7, 0, 0); // docked Progress
  k.cyl(root, hull, 'x', 2.0, 12.5, -16.75, 0, 0); // Zarya
  k.cyl(root, hull, 'x', 2.2, 6.5, -7.25, 0, 0); // Unity
  k.cyl(root, hull, 'x', 2.2, 9.5, -1.25, 0, 0); // Destiny
  k.cyl(root, hull, 'x', 2.2, 6.5, 8.75, 0, 0); // Harmony
  k.cyl(root, hullDark, 'x', 1.3, 3.0, 13.4, 0, 0, 1.0); // PMA-2 / docking adapter
  for (const x of [-23, -10.5, -4, 5.5, 12]) k.cyl(root, hullDark, 'x', 2.32, 0.4, x, 0, 0);
  // Nauka under Zvezda
  k.cyl(root, hull, 'x', 2.0, 12.5, -29, 0, 3.6);
  // lateral modules
  k.cyl(root, hull, 'y', 2.2, 6.9, 8.75, 5.65, 0); // Columbus (starboard)
  k.cyl(root, hull, 'y', 2.2, 11.2, 8.75, -7.8, 0); // Kibo pressurized module (port)
  k.box(root, hullDark, 5, 5, 4, 8.75, -16.9, 0.2); // Kibo exposed facility
  k.cyl(root, hull, 'y', 2.2, 4.5, -7.25, -4.45, 0); // Tranquility (port of Unity)
  k.sphere(root, hullDark, 1.55, -7.25, -4.45, 3.1); // Cupola
  k.cyl(root, hull, 'y', 1.8, 5.5, -7.25, 4.75, 0); // Quest airlock (starboard)
  // Zarya's fixed Russian solar wings
  const flat = k.mat('flat-cells', 0x233f82, { metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide });
  for (const s of [-1, 1]) k.box(root, flat, 3.6, 11, 0.05, -16.75, s * 7.5, 0);

  // ---- integrated truss above Destiny, fixed inboard parts
  const truss = k.group(root, TRUSS_X, 0, TRUSS_Z);
  for (const x of [-1.6, 1.6]) for (const y of [-1.6, 1.6]) k.box(root, hullDark, 0.12, 0.12, 2.4, TRUSS_X + x, y, -3.4); // S0 mounting struts
  for (const s of [-1, 1]) {
    trussSpan(k, truss, s * 0.2, s * SARJ_Y);
    k.cyl(truss, hullDark, 'y', 2.5, 1.4, 0, s * SARJ_Y, 0, 2.5, 28); // SARJ bearing ring
    // thermal control radiators (S1 / P1): three deployed panels each
    for (const dx of [-3.7, 0, 3.7]) k.box(truss, white, 3.4, 0.2, 11.4, dx, s * 14, 2.2 + 5.7);
    k.box(truss, hullDark, 3.4, 1.4, 1.0, 0, s * 14, 2.0);
  }
  k.box(truss, hullDark, 3.2, 3.2, 3.2, 0, 0, 0); // S0 core

  // ---- Canadarm2, folded
  const arm = k.mat('arm', 0xd4d4d0, { metalness: 0.3, roughness: 0.5 });
  const armG = k.group(truss, 3.4, 3, 2.4);
  k.sphere(armG, arm, 0.55, 0, 0, 0);
  k.cyl(armG, arm, 'z', 0.2, 7, 0, 0, 3.5);
  k.sphere(armG, arm, 0.45, 0, 0, 7);
  k.cyl(armG, arm, 'x', 0.2, 7, 3.5, 0, 7);
  k.sphere(armG, arm, 0.35, 7, 0, 7);
  k.cyl(armG, arm, 'z', 0.17, 2.5, 7, 0, 8.25);

  // ---- outboard trusses with the arrays, one SARJ each
  for (const side of [-1, 1] as const) {
    const sarj = k.group(root, TRUSS_X, 0, TRUSS_Z);
    k.joint(side < 0 ? 'sarj.port' : 'sarj.stbd', sarj, 'y');
    trussSpan(k, sarj, side * SARJ_Y, side * TRUSS_HALF);
    k.box(sarj, hullDark, 3.2, 2.2, 3.2, 0, side * 27, 0); // S3/S4 equipment block
    for (const site of ISS_ARRAY_SITES.filter((s) => s.side === side)) {
      k.box(sarj, hullDark, 3.0, 3.0, 3.0, 0, side * site.y, 0); // BGA / PVR housing on the truss
      const [chA, chB] = site.channels;
      // wings: first channel on the nadir side (+Z), second on the zenith side (-Z); visual placement only
      for (const [ch, zSign] of [[chA, 1], [chB, -1]] as const) {
        const bga = k.group(sarj, 0, side * site.y, zSign * 2.2);
        k.joint(`bga.${ch}`, bga, 'z');
        solarWing(k, bga, zSign, cells, back);
      }
      // photovoltaic radiator folded beside the pair
      k.box(sarj, gold, 3.2, 0.15, 6, 0, side * (site.y - 3.3), -3.0);
    }
  }

  return k.instance();
}

export const ISS_MODEL: ModelDef = {
  key: 'iss',
  label: 'International Space Station',
  radiusM: 65,
  lodKm: 45,
  minViewKm: 0.025,
  fitKm: 0.26,
  attitude: 'lvlh',
  build: buildIss,
};
