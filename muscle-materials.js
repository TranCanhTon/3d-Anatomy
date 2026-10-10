import * as THREE from 'three';
import { peelGLSL, tornGLSL, dustGLSL } from './skin-peel.js';

// Filled in by app.js with the skin peel's uniforms. While any skin remains,
// muscles are only drawn where the skin has already peeled away, so they can
// never show through intact skin.
export const maskUniforms = { uMaskOn: { value: 1 } };

const C = s => new THREE.Color(s);
const MUSCLE = C('#86251f'), TENDON = C('#e9e0d2'), BONE = C('#d9cfb4');
// Highlight colour (hover, select and working muscles). Teal is opposite red on the colour wheel,
// so it reads clearly on the muscles. It is blended in, not added: red plus teal light comes out grey.
export const HIGHLIGHT = C('#33d1c1');
const hiColor = { value: HIGHLIGHT };

// Fiber stripes: run along the baked fiber direction, only on muscle tissue.
function fiberShader(shader) {
  Object.assign(shader.uniforms, maskUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 fiber; attribute float kind; attribute float belly; varying vec3 vFib; varying vec3 vWN; varying vec3 vWP; varying float vKind;\nuniform float uMaskOn; uniform float uBulge;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normal * belly * uBulge * 0.0065;\nvFib = mat3(modelMatrix) * fiber; vWN = mat3(modelMatrix) * normal; vWP = (modelMatrix * vec4(position, 1.0)).xyz; vKind = kind;')
    // while skin is on, muscles sit 1.2 cm further back in depth (same place on screen), so the
    // thick torn edge of the skin always draws over the flesh it lies on
    .replace('#include <project_vertex>', `#include <project_vertex>
      if (uMaskOn > 0.5) gl_Position = projectionMatrix * vec4(mvPosition.xyz * (1.0 + 0.012 / max(length(mvPosition.xyz), 0.01)), 1.0);`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vFib; varying vec3 vWN; varying vec3 vWP; varying float vKind;\nuniform float uMaskOn; uniform float uHi; uniform float uDim; uniform vec3 uHiColor;\nfloat vTornShade = 0.0;\n' + peelGLSL + tornGLSL + dustGLSL)
    .replace('void main() {', `void main() {
      if (uMaskOn > 0.5) {
        // peeled away, or (up and down pulls) its spot of skin is about to turn to dust
        bool peeled = uPeel >= 0.0 && (uPeelSide > 1.5 ? dustLow(vWP) - 0.4 < uPeel : vWP.y >= peelFront(atan(vWP.x, vWP.z)) - 0.004);
        float tr = tornRegion(vWP);
        if (!peeled && tr < 0.004) discard;
        vTornShade = peeled ? 0.0 : 1.0 - smoothstep(0.004, 0.022, tr);
      }`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      vec3 f = length(vFib) > 0.001 ? normalize(vFib) : vec3(0.0, 1.0, 0.0);
      vec3 t = cross(normalize(vWN), f); t = length(t) > 0.001 ? normalize(t) : vec3(1.0, 0.0, 0.0);
      float u = dot(vWP, t) * 1100.0 + sin(dot(vWP, f) * 55.0) * 1.6;
      float fade = clamp(1.0 - fwidth(u) * 0.45, 0.0, 1.0);
      float stripe = (sin(u) * 0.5 + 0.5) * 0.6 + (sin(u * 2.7 + 1.3) * 0.5 + 0.5) * 0.4;
      float m = 1.0 - smoothstep(0.0, 0.45, vKind);
      diffuseColor.rgb *= mix(1.0, 0.62 + 0.5 * stripe, m * fade);
      // highlight: blend the muscle (not its tendons) toward teal, keeping the fiber stripes;
      // dim: darken muscles that are not working during an exercise
      diffuseColor.rgb = mix(diffuseColor.rgb, uHiColor * mix(1.0, 0.7 + 0.42 * stripe, fade), uHi * m);
      diffuseColor.rgb *= 1.0 - uDim * 0.45;
      // contact shadow where the torn skin still overlaps the flesh, and a little blood in it
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.35, 0.12, 0.1), vTornShade * 0.85);`);
}
const mats = new Map();
function matFor(k) {
  if (!mats.has(k)) {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.0 });
    // per material: highlight amount (0 to 1), dim amount, and contraction bulge
    Object.assign(m.userData, { uHi: { value: 0 }, uDim: { value: 0 }, uBulge: { value: 0 } });
    m.customProgramCacheKey = () => 'muscle-masked-v8';
    m.onBeforeCompile = (shader) => {
      fiberShader(shader);
      Object.assign(shader.uniforms, { uHi: m.userData.uHi, uDim: m.userData.uDim, uBulge: m.userData.uBulge, uHiColor: hiColor });
    };
    mats.set(k, m);
  }
  return mats.get(k);
}
function recolor(mesh) {
  const g = mesh.geometry, k = g.attributes.kind, col = g.attributes.color, tmp = new THREE.Color();
  for (let i = 0; i < k.count; i++) { const v = k.getX(i); if (v < 0.5) tmp.copy(MUSCLE).lerp(TENDON, v * 2); else tmp.copy(TENDON).lerp(BONE, (v - 0.5) * 2); col.setXYZ(i, tmp.r, tmp.g, tmp.b); }
  col.needsUpdate = true;
}
function prep(mesh) {
  const g = mesh.geometry, c = g.attributes.color, n = c.count;
  const col = new Float32Array(n * 3), fib = new Float32Array(n * 3), kind = new Float32Array(n), tmp = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const k = c.itemSize > 3 ? c.getW(i) : 0; kind[i] = k;
    if (k < 0.5) tmp.copy(MUSCLE).lerp(TENDON, k * 2); else tmp.copy(TENDON).lerp(BONE, (k - 0.5) * 2);
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
    const x = c.getX(i) * 2 - 1, y = c.getY(i) * 2 - 1, z = c.getZ(i) * 2 - 1;
    fib.set(Math.hypot(x, y, z) > 0.2 ? [x, y, z] : [0, 0, 0], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('fiber', new THREE.BufferAttribute(fib, 3));
  g.setAttribute('kind', new THREE.BufferAttribute(kind, 1));
  const u = mesh.userData;
  mesh.material = matFor(u.kind === 'clickable' ? u.group + '/' + u.part : u.kind);
}


export { mats, prep };
