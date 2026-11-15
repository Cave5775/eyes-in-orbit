/** A real, minimal glTF binary: one triangle (positions only) spanning `size` units, offset by (ox, oy, oz). */
export function triangleGlb(size = 10, [ox, oy, oz] = [0, 0, 0]): ArrayBuffer {
  const pos = new Float32Array([ox, oy, oz, ox + size, oy, oz, ox, oy + size, oz]);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 0.1, 1] } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [ox, oy, oz], max: [ox + size, oy + size, oz] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 }],
    buffers: [{ byteLength: pos.byteLength }],
  };
  let j = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (j.length % 4)) % 4;
  const jp = new Uint8Array(j.length + pad).fill(0x20);
  jp.set(j);
  j = jp;
  const total = 12 + 8 + j.length + 8 + pos.byteLength;
  const out = new ArrayBuffer(total);
  const v = new DataView(out);
  v.setUint32(0, 0x46546c67, true); // 'glTF'
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, j.length, true);
  v.setUint32(16, 0x4e4f534a, true); // JSON
  new Uint8Array(out, 20, j.length).set(j);
  const o = 20 + j.length;
  v.setUint32(o, pos.byteLength, true);
  v.setUint32(o + 4, 0x004e4942, true); // BIN
  new Uint8Array(out, o + 8, pos.byteLength).set(new Uint8Array(pos.buffer));
  return out;
}
