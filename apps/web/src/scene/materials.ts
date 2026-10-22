import * as THREE from 'three';

/** Per-point colour, pixel size (0 hides) and glyph; screen-space sized so 12k objects stay legible. */
export function createPointMaterial(pixelRatio: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uPx: { value: pixelRatio } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aGlyph;
      uniform float uPx;
      varying vec3 vColor;
      varying float vGlyph;
      void main() {
        vColor = aColor;
        vGlyph = aGlyph;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPx;
        // size 0 means hidden: a zero point size is clamped up to 1 px on some GPUs/ANGLE, so also clip the vertex away
        if (aSize <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
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

/**
 * Earth surface lit by an ECI sun vector. Body-fixed direction comes from the (z-up) geometry normal,
 * world normal from the model matrix, so the same shader works as the group rotates by GMST.
 * Without a texture a noise land/ocean mask is used (clearly procedural, not geography).
 */
export function createEarthMaterial(sun: THREE.Vector3, texture: THREE.Texture | null): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: sun },
      uTex: { value: texture },
      uHasTex: { value: texture ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vL; varying vec3 vN; varying vec2 vUv;
      void main() {
        vUv = uv;
        vL = normal;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform sampler2D uTex; uniform float uHasTex;
      varying vec3 vL; varying vec3 vN; varying vec2 vUv;
      ${NOISE}
      void main() {
        vec3 base;
        if (uHasTex > 0.5) {
          base = texture2D(uTex, vUv).rgb;
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

/** Limb glow drawn on the back faces of a slightly larger sphere. */
export function createAtmosphereMaterial(sun: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sun } },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vView; varying vec3 vWN;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vWN = normalize(mat3(modelMatrix) * normal);
        vView = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      varying vec3 vN; varying vec3 vView; varying vec3 vWN;
      void main() {
        float d = clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
        float a = pow(clamp(d / 0.19, 0.0, 1.0), 1.7);
        float sunlit = 0.2 + 0.8 * smoothstep(-0.5, 0.35, dot(normalize(vWN), normalize(uSun)));
        gl_FragColor = vec4(vec3(0.30, 0.55, 1.0), a * sunlit * 0.9);
      }`,
  });
}

/**
 * Stars pinned to the far plane (xyww trick, depth just inside 1.0), unaffected by near/far changes
 * while zooming. They must be depth TESTED: the Earth is opaque and writes depth, but this material is
 * transparent and so is drawn after the opaque pass. With `depthTest: false` (the old setting) every
 * star was painted over the Earth disc whatever `renderOrder` said; with the test on, the far-plane
 * depth loses to the Earth (and to anything else drawn in front) and the stars are occluded.
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
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
        gl_PointSize = aSize * uPx;
      }`,
    fragmentShader: /* glsl */ `
      varying float vB;
      void main() {
        float d = length(gl_PointCoord * 2.0 - 1.0);
        float a = (1.0 - smoothstep(0.3, 1.0, d)) * vB;
        gl_FragColor = vec4(vec3(0.8, 0.86, 1.0), a);
      }`,
  });
}
