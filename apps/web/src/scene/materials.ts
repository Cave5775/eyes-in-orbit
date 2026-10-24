import * as THREE from 'three';

/**
 * Uniforms the point shader needs for the analytic Earth occlusion test (see `lib/occlusion.ts`, same maths):
 * the camera in Earth-scaled space, `|o'|^2 - R'^2` computed in float64 on the CPU, and the ellipsoid z scale.
 * Plus the displayed Moon (`uSph0`) and Sun (`uSph1`) as spheres: xyz = centre relative to the camera (float64 on the
 * CPU), w = radius; `uSphC2` = `|centre|^2 - r^2` per sphere (<= 0 disables it: camera inside, or not placed yet).
 */
export function occlusionUniforms(): Record<string, THREE.IUniform> {
  return {
    uOriginS: { value: new THREE.Vector3() },
    uC2: { value: 0 },
    uOccK: { value: 1 },
    uOcc: { value: 1 },
    uSph0: { value: new THREE.Vector4() },
    uSph1: { value: new THREE.Vector4() },
    uSphC2: { value: new THREE.Vector2() },
  };
}

/**
 * Per-point colour, pixel size (0 hides), glyph and scope flag; screen-space sized so 12k objects stay legible.
 * Positions arrive camera-relative (floating origin). Points are NOT depth tested: a sprite has one depth for all its
 * pixels, so against the Earth's depth it was half clipped at the limb (and z-fought on the ground). Instead the vertex
 * shader hides a point whose line of sight crosses the Earth (analytic ray test) and `aShow` (scope policy, 0/1) hides
 * out-of-scope points.
 */
export function createPointMaterial(pixelRatio: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uPx: { value: pixelRatio }, ...occlusionUniforms() },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aGlyph;
      attribute float aShow;
      uniform float uPx;
      uniform vec3 uOriginS;
      uniform float uC2;
      uniform float uOccK;
      uniform float uOcc;
      uniform vec4 uSph0;
      uniform vec4 uSph1;
      uniform vec2 uSphC2;
      varying vec3 vColor;
      varying float vGlyph;
      bool earthHides(vec3 rel) {
        if (uOcc < 0.5 || uC2 <= 0.0) return false;
        vec3 d = vec3(rel.xy, rel.z * uOccK);
        float L = length(d);
        if (L <= 0.0) return false;
        float b = dot(uOriginS, d / L);
        if (b >= 0.0) return false;
        float disc = b * b - uC2;
        if (disc <= 0.0) return false;
        return uC2 / (-b + sqrt(disc)) < L;
      }
      // Moon / Sun: sphere s (xyz camera-relative centre, w radius) with c2 = |centre|^2 - r^2 from the CPU. The miss
      // distance is |cross(u, centre)| (no |centre|^2 - t^2 cancellation: the Sun is 1.5e8 km away, its radius 7e5) and the
      // near hit is c2 / (b + sqrt((r - p)(r + p))). Same maths as sphereOccludes in lib/occlusion.ts.
      bool sphereHides(vec3 rel, vec4 s, float c2) {
        if (uOcc < 0.5 || c2 <= 0.0) return false;
        float L = length(rel);
        if (L <= 0.0) return false;
        vec3 u = rel / L;
        float b = dot(u, s.xyz);
        if (b <= 0.0) return false;
        float p = length(cross(u, s.xyz));
        if (p >= s.w) return false;
        return c2 / (b + sqrt((s.w - p) * (s.w + p))) < L;
      }
      void main() {
        vColor = aColor;
        vGlyph = aGlyph;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPx;
        // size 0 means hidden: a zero point size is clamped up to 1 px on some GPUs/ANGLE, so also clip the vertex away
        if (aSize <= 0.0 || aShow < 0.5 || earthHides(position) || sphereHides(position, uSph0, uSphC2.x) || sphereHides(position, uSph1, uSphC2.y)) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
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
 * Moon surface lit by the Sun: plain Lambert with a trace of earthshine on the night side. Geometry and UVs follow the
 * Earth's convention (z = pole, +x at the centre of an equirectangular map). Without a texture a grey noise surface is
 * used (clearly procedural, not geography).
 */
export function createMoonMaterial(sun: THREE.Vector3, texture: THREE.Texture | null): THREE.ShaderMaterial {
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
