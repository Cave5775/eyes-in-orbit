import * as THREE from 'three';
import { GROUP_SLOTS, offGroup } from '../lib/disc-hide';
import { MAX_OCCLUDERS, type OccluderSet } from '../lib/occlusion';
import { SHOW_EXEMPT_MIN } from '../lib/pick';
import { DEFAULT_NOISE, hexRgb, ringTexture, type BodyStyle, type RingStyle } from '../lib/body-style';

/**
 * Uniforms the point shader needs for body occlusion: ONE array of `MAX_OCCLUDERS` slots, the camera-relative slots of the
 * frame's `OccluderSet` (lib/occlusion.ts; every drawn body, Earth and Mars alike, chosen by apparent size) and the number in use.
 * `uOccS[i]`: xyz = body centre relative to the camera with z scaled by the ellipsoid factor, w = shrunk radius (float64 on
 * the CPU, then rounded); `uOccE[i]`: x = `|centre|^2 - r^2` (> 0: the camera is outside), y = the scale along the pole (1 for a sphere, the
 * Earth's 1 / (1 - f)); `uOccP[i]` the unit pole axis (+z for the Earth, the body's own for a flattened planet; xyz of the centre are already stretched along it). The test is the stable sphere form (`bodyHides`; miss distance `|cross(u, centre)|`): with the camera
 * 1.5e8 km out (the Sun frame) `b^2 - c2` would be pure float32 cancellation (b^2 ~ 2e16, R^2 ~ 4e7). Arrays are built once
 * and mutated (`setOccluderUniforms`): nothing is allocated per frame.
 */
export function occlusionUniforms(): Record<string, THREE.IUniform> {
  return {
    uOccN: { value: 0 },
    uOccS: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector4()) },
    uOccE: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector2(0, 1)) },
    uOccP: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector3(0, 0, 1)) },
  };
}

/**
 * Vertex uniform vectors the point shader declares, counted the way GLSL packs them (a vec4, a vec2, a float and each element of
 * an array of those take one vector; a mat4 takes 4): the occluder arrays (`uOccS` vec4 + `uOccE` vec2 + `uOccP` vec3 per slot), the cone arrays
 * (`uGroup` vec4 + `uGroupD` float + `uGroupE` vec2 per slot), `uOccN`, `uPx`, and three.js's built-ins for a ShaderMaterial
 * (modelMatrix, viewMatrix, modelViewMatrix, projectionMatrix = 16, normalMatrix 3, cameraPosition 1). The assumption is
 * WebGL2's guaranteed minimum of 256 vertex uniform vectors (WebGL1's 128 is also met); a test asserts the sum stays within it.
 */
export const POINT_UNIFORM_VECTORS = 3 * MAX_OCCLUDERS + 3 * GROUP_SLOTS + 2 + (16 + 3 + 1);
/** The vertex uniform vectors WebGL2 guarantees (`MAX_VERTEX_UNIFORM_VECTORS`). */
export const MIN_VERTEX_UNIFORM_VECTORS = 256;

/** Copy the frame's occluder slots into the point material's uniforms (no allocation). */
export function setOccluderUniforms(u: Record<string, THREE.IUniform>, set: OccluderSet): void {
  const s = u.uOccS.value as THREE.Vector4[], e = u.uOccE.value as THREE.Vector2[], pa = u.uOccP.value as THREE.Vector3[];
  for (let i = 0; i < set.count; i++) {
    const v = set.slots[i];
    s[i].set(v.x, v.y, v.z, v.r);
    e[i].set(v.c2, v.k);
    pa[i].set(v.pxa, v.pya, v.pza);
  }
  u.uOccN.value = set.count;
}

/**
 * Per-point colour, pixel size (0 hides), glyph and scope flag; screen-space sized so 12k objects stay legible.
 * Positions arrive camera-relative (floating origin). Points are NOT depth tested: a sprite has one depth for all its
 * pixels, so against a body's depth it was half clipped at the limb (and z-fought on the ground). Instead the vertex
 * shader hides a point whose line of sight crosses any drawn body (analytic ray test against the occluder slots) and `aShow` (scope policy, 0/1) hides
 * out-of-scope points. `aShow >= 1.5` (2) marks a point exempt from the small-disc hiding: `uGroup[i]` is a body's cone
 * (xyz unit direction from the camera, w the sine of its angular radius, > 1 = off) and `uGroupD[i]` the distance to its
 * centre and `uGroupE[i]` the radius of a shell about it (the body's own system, LEO for the Earth) and how far behind the centre
 * plane the cone still hides; a non-exempt point inside a cone and nearer than the body (plus that depth), or inside the shell, is not drawn (lib/disc-hide.ts has the same test for picking).
 */
export function createPointMaterial(pixelRatio: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPx: { value: pixelRatio },
      ...occlusionUniforms(),
      uGroup: { value: Array.from({ length: GROUP_SLOTS }, () => { const g = offGroup(); return new THREE.Vector4(g.x, g.y, g.z, g.sinR); }) },
      uGroupD: { value: new Array<number>(GROUP_SLOTS).fill(0) },
      uGroupE: { value: Array.from({ length: GROUP_SLOTS }, () => new THREE.Vector2(0, 0)) },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aGlyph;
      attribute float aShow;
      uniform float uPx;
      uniform int uOccN;
      uniform vec4 uOccS[${MAX_OCCLUDERS}];
      uniform vec2 uOccE[${MAX_OCCLUDERS}];
      uniform vec3 uOccP[${MAX_OCCLUDERS}];
      uniform vec4 uGroup[${GROUP_SLOTS}];
      uniform float uGroupD[${GROUP_SLOTS}];
      uniform vec2 uGroupE[${GROUP_SLOTS}];
      varying vec3 vColor;
      varying float vGlyph;
      // Small, far body (disc radius <= GROUP_DISC_PX): inside its pick cone and nearer than its centre, or within its shell -> not drawn.
      // Same maths as hiddenByDisc in lib/disc-hide.ts; the sine of the miss angle is |cross(u, dir)| (no cancellation).
      bool discHides(vec3 rel) {
        float L = length(rel);
        if (L <= 0.0) return false;
        vec3 u = rel / L;
        for (int i = 0; i < ${GROUP_SLOTS}; i++) {
          vec4 g = uGroup[i];
          if (g.w > 1.0) continue;
          if (length(rel - g.xyz * uGroupD[i]) < uGroupE[i].x) return true;
          if (dot(u, g.xyz) <= 0.0) continue;
          if (length(cross(u, g.xyz)) >= g.w) continue;
          if (dot(rel, g.xyz) < uGroupD[i] + uGroupE[i].y) return true;
        }
        return false;
      }
      // Any drawn body in front of the point: slot s (xyz camera-relative centre with z scaled by the ellipsoid factor k, w radius,
      // e.x = c2 = |centre|^2 - r^2, e.y = k) from the CPU. The miss distance is |cross(u, centre)| (no |centre|^2 - t^2
      // cancellation: the Sun is 1.5e8 km away, its radius 7e5) and the near hit is c2 / (b + sqrt((r - p)(r + p))).
      // THE same maths as sphereOccludes in lib/occlusion.ts (the CPU test), over the same slots, line for line.
      bool bodyHides(vec3 rel) {
        for (int i = 0; i < ${MAX_OCCLUDERS}; i++) {
          if (i >= uOccN) break;
          vec4 s = uOccS[i];
          vec2 e = uOccE[i];
          if (e.x <= 0.0) continue;
          vec3 pa = uOccP[i];
          vec3 d = rel + (e.y - 1.0) * dot(rel, pa) * pa;
          float L = length(d);
          if (L <= 0.0) continue;
          vec3 u = d / L;
          float b = dot(u, s.xyz);
          if (b <= 0.0) continue;
          float p = length(cross(u, s.xyz));
          if (p >= s.w) continue;
          if (e.x / (b + sqrt((s.w - p) * (s.w + p))) < L) return true;
        }
        return false;
      }
      void main() {
        vColor = aColor;
        vGlyph = aGlyph;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPx;
        // size 0 means hidden: a zero point size is clamped up to 1 px on some GPUs/ANGLE, so also clip the vertex away
        if (aSize <= 0.0 || aShow < 0.5 || bodyHides(position) || (aShow < ${SHOW_EXEMPT_MIN.toFixed(2)} && discHides(position))) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vGlyph;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float a;
        if (vGlyph < 0.5) { a = 1.0 - smoothstep(0.65, 1.0, length(p)); }
        else if (vGlyph < 1.5) { a = 1.0 - smoothstep(0.75, 1.0, abs(p.x) + abs(p.y)); }
        else if (vGlyph < 2.5) { float d = length(p); a = smoothstep(0.55, 0.7, d) * (1.0 - smoothstep(0.88, 1.0, d)); }
        else if (vGlyph < 3.5) { float w = (p.y + 1.0) * 0.5; a = (1.0 - smoothstep(w - 0.12, w, abs(p.x))) * step(p.y, 0.9); }
        else { a = 1.0 - smoothstep(0.8, 1.0, max(abs(p.x), abs(p.y))); }
        if (a < 0.03) discard;
        gl_FragColor = vec4(vColor, a);
      }`,
  });
}

const NOISE = /* glsl */ `
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }`;

/** 1 x 1 transparent texture the detail sampler points at until the detail layer exists. */
const EMPTY_DETAIL = (() => {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.needsUpdate = true;
  return t;
})();

/**
 * Earth surface lit by an ECI sun vector. Body-fixed direction comes from the (z-up) geometry normal,
 * world normal from the model matrix, so the same shader works as the group rotates by GMST.
 * Without a texture a noise land/ocean mask is used (clearly procedural, not geography).
 * The scene uses a logarithmic depth buffer (see SceneController), so every depth-writing material includes the
 * `logdepthbuf` chunks: mixing log and linear depth would make the Earth, atmosphere and lines disagree.
 */
export function createEarthMaterial(sun: THREE.Vector3, texture: THREE.Texture | null): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: sun },
      uTex: { value: texture },
      uHasTex: { value: texture ? 1 : 0 },
      // streamed close-up imagery (scene/earth-detail.ts): premultiplied RGBA atlas, its box in the base map's uv, on/off
      uDetail: { value: EMPTY_DETAIL },
      uDetailBox: { value: new THREE.Vector4(0, 0, 1, 1) },
      uDetailOn: { value: 0 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vL; varying vec3 vN; varying vec2 vUv;
      void main() {
        vUv = uv;
        vL = normal;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSun; uniform sampler2D uTex; uniform float uHasTex;
      uniform sampler2D uDetail; uniform vec4 uDetailBox; uniform float uDetailOn;
      varying vec3 vL; varying vec3 vN; varying vec2 vUv;
      ${NOISE}
      const float FLATTENING = 1.0 / 298.257223563;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 base;
        if (uHasTex > 0.5) {
          // The mesh is a sphere squashed by the flattening, so the sphere's own v is not the geodetic latitude the
          // equirectangular maps are drawn in (up to 0.19 degrees, 21 km, off). Longitude stays the interpolated uv.x,
          // which is continuous across the date line (an atan here would break the mipmap choice along it).
          vec3 n = normalize(vL);
          float phi = atan(n.z, (1.0 - FLATTENING) * length(n.xy));
          vec2 guv = vec2(vUv.x, phi / 3.14159265 + 0.5);
          base = texture2D(uTex, guv).rgb;
          // close-up detail: sampled everywhere (derivatives stay uniform), used inside the atlas box with a soft edge
          vec2 duv = (guv - uDetailBox.xy) / (uDetailBox.zw - uDetailBox.xy);
          vec4 det = texture2D(uDetail, clamp(duv, 0.0, 1.0));
          float edge = smoothstep(0.0, 0.04, min(min(duv.x, 1.0 - duv.x), min(duv.y, 1.0 - duv.y))) * uDetailOn;
          base = base * (1.0 - det.a * edge) + det.rgb * edge;
        } else {
          float h = fbm(vL * 2.4 + 3.1);
          float land = smoothstep(0.50, 0.53, h);
          vec3 ocean = mix(vec3(0.015, 0.07, 0.17), vec3(0.04, 0.15, 0.30), smoothstep(0.25, 0.5, h));
          vec3 ground = mix(vec3(0.14, 0.27, 0.11), vec3(0.45, 0.38, 0.23), smoothstep(0.2, 0.8, fbm(vL * 7.0 + 9.0)));
          ground = mix(ground, vec3(0.86, 0.89, 0.92), smoothstep(0.76, 0.88, abs(vL.z) + (h - 0.5) * 0.25));
          base = mix(ocean, ground, land);
        }
        float d = dot(normalize(vN), normalize(uSun));
        float day = smoothstep(-0.07, 0.16, d);
        vec3 lit = base * (0.30 + 0.80 * smoothstep(-0.1, 1.0, d));
        vec3 night = base * vec3(0.085, 0.11, 0.18);
        vec3 col = mix(night, lit, day);
        col += vec3(0.8, 0.35, 0.12) * 0.07 * exp(-pow(d * 7.0, 2.0));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

/**
 * Surface of the Moon or Mars lit by the Sun: plain Lambert with a trace of ambient light on the night side. Geometry and
 * UVs follow the Earth's convention (z = pole, +x at the centre of an equirectangular map). Without a texture a grey noise
 * surface is used (clearly procedural, not geography; Mars keeps its tinted material until its map has loaded).
 */
export function createMapMaterial(sun: THREE.Vector3, texture: THREE.Texture | null): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: sun },
      uTex: { value: texture },
      uHasTex: { value: texture ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vL; varying vec3 vN; varying vec2 vUv;
      void main() {
        vUv = uv;
        vL = normal;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSun; uniform sampler2D uTex; uniform float uHasTex;
      varying vec3 vL; varying vec3 vN; varying vec2 vUv;
      ${NOISE}
      void main() {
        #include <logdepthbuf_fragment>
        vec3 base = uHasTex > 0.5
          ? texture2D(uTex, vUv).rgb
          : vec3(0.18 + 0.30 * fbm(vL * 3.0 + 1.7) + 0.12 * fbm(vL * 14.0));
        float d = dot(normalize(vN), normalize(uSun));
        float lit = smoothstep(-0.02, 0.35, d) * (0.15 + 0.95 * max(d, 0.0));
        gl_FragColor = vec4(base * (0.012 + 1.05 * lit), 1.0);
      }`,
  });
}

/**
 * A body without a map: a lit sphere in its style's colour (lib/body-style.ts). Gas and ice giants get a latitudinal band
 * pattern (bands run with the pole = local z, a deterministic sine with a little longitudinal turbulence, in the body's own two
 * band colours); solid bodies get slight albedo noise. Terminator as the Moon's (no scene lights). `invB2 = 1 / (1 - f)^2`
 * corrects the normal of a geometry squashed along z by (1 - f) (the oblate giants, scene/celestial.ts); 1 for a sphere.
 */
export function createBodyMaterial(sun: THREE.Vector3, style: BodyStyle, invB2 = 1): THREE.ShaderMaterial {
  const bands = style.bands;
  const a = hexRgb(bands?.colors[0] ?? style.color), b = hexRgb(bands?.colors[1] ?? style.color);
  return new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: sun },
      uTint: { value: new THREE.Vector3(...hexRgb(style.color)) },
      uBandA: { value: new THREE.Vector3(...a) },
      uBandB: { value: new THREE.Vector3(...b) },
      uBandN: { value: bands ? bands.count : 0 },
      uBandK: { value: bands ? bands.contrast : 0 },
      uNoise: { value: bands ? 0.04 : (style.noise ?? DEFAULT_NOISE) },
      uInvB2: { value: invB2 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uInvB2;
      varying vec3 vL; varying vec3 vN;
      void main() {
        vL = normal;
        vN = normalize(mat3(modelMatrix) * vec3(normal.xy, normal.z * uInvB2));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSun; uniform vec3 uTint; uniform vec3 uBandA; uniform vec3 uBandB;
      uniform float uBandN; uniform float uBandK; uniform float uNoise;
      varying vec3 vL; varying vec3 vN;
      ${NOISE}
      void main() {
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vL);
        vec3 col = uTint;
        if (uBandN > 0.0) {
          float lat = n.z;
          float turb = 0.45 * sin(atan(n.y, n.x) * 3.0 + lat * 9.0) + 0.25 * sin(atan(n.y, n.x) * 7.0 - lat * 21.0);
          float w = 0.5 + 0.5 * sin(lat * uBandN * 3.14159265 + turb * 0.6);
          w = mix(w, 0.5 + 0.5 * sin(lat * uBandN * 8.0 + 1.7 * turb), 0.25);
          col = mix(uTint, mix(uBandA, uBandB, smoothstep(0.15, 0.85, w)), min(1.0, uBandK * 1.2));
        }
        col *= 1.0 + uNoise * (fbm(n * 4.0 + 1.3) * 2.0 - 1.0) + 0.5 * uNoise * (fbm(n * 17.0) - 0.5);
        float d = dot(normalize(vN), normalize(uSun));
        float lit = smoothstep(-0.02, 0.35, d) * (0.15 + 0.95 * max(d, 0.0));
        gl_FragColor = vec4(col * (0.012 + 1.05 * lit), 1.0);
      }`,
  });
}

/** The 1-D radial opacity/colour texture of a ring system (\`ringTexture\`), linear filtered, edge clamped. */
export function createRingData(ring: RingStyle): THREE.DataTexture {
  const w = 512;
  const tex = new THREE.DataTexture(ringTexture(ring, w), w, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Ring plane geometry (local z = the body's pole, like the sphere): an annulus of \`ring\`'s radii. Pair with \`createRingMaterial\`.
 */
export const createRingGeometry = (ring: RingStyle): THREE.RingGeometry => new THREE.RingGeometry(ring.innerKm, ring.outerKm, 192, 1);

/**
 * Semi-transparent, double-sided ring lit by the Sun: radial opacity and colour from the data texture; a face seen from the side
 * away from the Sun (light shining through) is dimmer, an edge-on ring faint. No shadow of the ring on the planet nor of the
 * planet on the ring. Not depth-written (no ring edge cuts a body behind it), depth-tested with the same logarithmic depth as the bodies.
 */
export function createRingMaterial(sun: THREE.Vector3, ring: RingStyle, data: THREE.Texture = createRingData(ring)): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sun }, uTex: { value: data }, uInner: { value: ring.innerKm }, uOuter: { value: ring.outerKm } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vR; varying vec3 vN; varying vec3 vW;
      void main() {
        vR = length(position.xy);
        vN = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSun; uniform sampler2D uTex; uniform float uInner; uniform float uOuter;
      varying float vR; varying vec3 vN; varying vec3 vW;
      void main() {
        #include <logdepthbuf_fragment>
        vec4 t = texture2D(uTex, vec2((vR - uInner) / (uOuter - uInner), 0.5));
        if (t.a < 0.01) discard;
        float d = dot(vN, normalize(uSun));
        float side = (dot(vN, -vW) * d > 0.0) ? 1.0 : 0.3;
        float lit = (0.16 + 0.9 * pow(abs(d), 0.5)) * side;
        gl_FragColor = vec4(t.rgb * lit, t.a);
      }`,
  });
}

/** Limb glow drawn on the back faces of a slightly larger sphere. */
export function createAtmosphereMaterial(sun: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sun } },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN; varying vec3 vView; varying vec3 vWN;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vWN = normalize(mat3(modelMatrix) * normal);
        vView = mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSun;
      varying vec3 vN; varying vec3 vView; varying vec3 vWN;
      void main() {
        #include <logdepthbuf_fragment>
        float d = clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
        float a = pow(clamp(d / 0.19, 0.0, 1.0), 1.7);
        float sunlit = 0.2 + 0.8 * smoothstep(-0.5, 0.35, dot(normalize(vWN), normalize(uSun)));
        gl_FragColor = vec4(vec3(0.30, 0.55, 1.0), a * sunlit * 0.9);
      }`,
  });
}

/**
 * Stars pinned to the far plane: the fragment depth is forced to 1.0, the cleared value, so they pass the (LEQUAL) depth
 * test only where nothing else was drawn. They must be depth TESTED: the Earth is opaque and writes depth, but this
 * material is transparent and so is drawn after the opaque pass; with `depthTest: false` every star was painted over the
 * Earth disc whatever `renderOrder` said. The logarithmic depth buffer breaks the usual `w * 0.99999` trick, so the
 * depth is written explicitly.
 */
export function createStarMaterial(pixelRatio: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uPx: { value: pixelRatio } },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute float aSize; attribute float aBright;
      uniform float uPx;
      varying float vB;
      void main() {
        vB = aBright;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPx;
      }`,
    fragmentShader: /* glsl */ `
      varying float vB;
      void main() {
        float d = length(gl_PointCoord * 2.0 - 1.0);
        float a = (1.0 - smoothstep(0.3, 1.0, d)) * vB;
        gl_FragColor = vec4(vec3(0.8, 0.86, 1.0), a);
        gl_FragDepth = 1.0;
      }`,
  });
}
