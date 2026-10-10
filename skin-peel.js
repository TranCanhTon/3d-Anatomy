import * as THREE from "three";

const clamp = THREE.MathUtils.clamp;
const smooth = (x) => {
  x = clamp(x, 0, 1);
  return x * x * (3 - 2 * x);
};
const band = (x, a, b) => smooth((x - a) / (b - a));

// Landmarks of the MakeHuman head, in model space (metres, +Z faces the camera).
const EYE = { x: 0.0299, y: 1.593, z: 0.0686 };
const FACE = {
  chinY: 1.465,
  mouthY: 1.5,
  noseY: 1.551,
  noseZ: 0.115,
  eyeY: 1.593,
  topY: 1.703,
};

// The two fixed grab points: one on each cheek. Pulling left drags the left
// point out to the left, pulling right drags the right point out to the right.
const GRAB = {
  point: (side) =>
    side === 2
      ? new THREE.Vector3(0, 1.66, 0.085)
      : side === 3
        ? new THREE.Vector3(0, 1.551, 0.115)
        : new THREE.Vector3(side * 0.058, 1.535, 0.062),
  dir: (side) =>
    side === 2
      ? new THREE.Vector3(0, -1, 0.3).normalize()
      : side === 3
        ? new THREE.Vector3(0, 1, 0.35).normalize()
        : new THREE.Vector3(side * 1, 0.18, 0.38).normalize(),
  reach: (side) => (side === 2 ? 0.055 : side === 3 ? 0.085 : 0.13), // metres the grab point travels at the breaking point
};

// ---------------------------------------------------------------------------
// The rip. Each pull tears its own piece off, with a ragged edge:
//   left/right: that half of the face, down: the whole front of the face,
//   up (nose): the skin above the mouth. Shared with the muscle shader, so the
//   muscles show through the hole. Positive inside the torn piece.
// ---------------------------------------------------------------------------
export const tornGLSL = `
uniform float uTornSide;
float tHash(vec3 p){p=fract(p*0.3183099+vec3(0.71,0.113,0.419));p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float tNoise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
  return mix(mix(mix(tHash(i),tHash(i+vec3(1,0,0)),f.x),mix(tHash(i+vec3(0,1,0)),tHash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(tHash(i+vec3(0,0,1)),tHash(i+vec3(1,0,1)),f.x),mix(tHash(i+vec3(0,1,1)),tHash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float tornJag(vec3 p){ return (tNoise(p * 48.0) - 0.5) * 0.026 + (tNoise(p * 160.0) - 0.5) * 0.009 + (tNoise(p * 520.0) - 0.5) * 0.0035; }
float tornRegion(vec3 p){
  if (uTornSide == 0.0) return -1.0;
  float j = tornJag(p);
  if (abs(uTornSide) < 1.5) {          // that half of the face, brow to jaw
    float s = uTornSide;
    return min(min(p.x * s - 0.004 + j, p.y - 1.458 + j), min(1.652 - p.y + j, p.z + 0.03 + j));
  }
  if (uTornSide < 2.5) {               // the whole front of the face
    return min(min(p.z - 0.022 + j, p.y - 1.46 + j), min(1.692 - p.y + j, 0.083 - abs(p.x) + j));
  }
  return min(p.y - 1.518 + j * 1.2, p.z + 0.015 + j);   // everything above the mouth
}`;

// ---------------------------------------------------------------------------
// Dust. Pulled down or up, the skin doesn't peel: the whole of it goes grey and
// blows away as dust, everywhere at once. dustTime says when each spot goes
// (seconds into the effect); the skin, the muscles underneath and the dust
// particles all use it, so they stay in step.
// ---------------------------------------------------------------------------
export const dustGLSL = `
float dHash(vec3 p){p=fract(p*0.3183099+vec3(0.53,0.29,0.71));p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float dNoise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
  return mix(mix(mix(dHash(i),dHash(i+vec3(1,0,0)),f.x),mix(dHash(i+vec3(0,1,0)),dHash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(dHash(i+vec3(0,0,1)),dHash(i+vec3(1,0,1)),f.x),mix(dHash(i+vec3(0,1,1)),dHash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float dustLow(vec3 p){ return 0.25 + 0.8 * clamp((dNoise(p * 9.0) * 0.65 + dNoise(p * 23.0 + 5.0) * 0.35 - 0.22) / 0.56, 0.0, 1.0); }
float dustTime(vec3 p){ return dustLow(p) + (dNoise(p * 140.0) - 0.5) * 0.18 + (dNoise(p * 420.0) - 0.5) * 0.08; }`;
const isDust = (side) => side === 2 || side === 3;

// ---------------------------------------------------------------------------
// Banana peel. After the tear the skin splits down the middle of the body,
// front and back. Each half peels from the top of the head downwards, curls
// out to its side and falls away; the half that was pulled goes first. The
// same front is used by the muscle shader, so muscles appear exactly where the
// skin has come off.
// ---------------------------------------------------------------------------
export const PEEL_STRIPS = 3;
const PEEL_DONE = 2.4; // seconds until both halves have peeled past the feet and faded
export const peelGLSL = `
uniform float uPeel;
uniform float uPeelSide;
const float PEEL_N = ${PEEL_STRIPS.toFixed(1)};
float peelStrip(float phi){ return clamp(floor((phi + PI) / (2.0 * PI) * PEEL_N), 0.0, PEEL_N - 1.0); }
float peelCenter(float phi){ return uPeelSide > 1.5 ? phi : (peelStrip(phi) + 0.5) / PEEL_N * 2.0 * PI - PI; }
float peelFront(float phi){
  if (uPeel < 0.0 || uPeelSide > 1.5) return 99.0;   // up and down pulls turn to dust instead
  float side = peelStrip(phi) > 0.5 ? 1.0 : -1.0;
  float delay = uPeelSide > 1.5 ? pow(abs(phi) / PI, 1.2) * 0.35
              : (uPeelSide == 0.0 ? 0.05 : (side == uPeelSide ? 0.0 : 0.13));
  float t = max(uPeel - delay, 0.0);
  return 1.76 - (0.35 * t + 0.78 * t * t);
}`;
export function peelFrontJS(phi, t, pulledSide = 0) {
  if (t < 0) return 99;
  if (isDust(pulledSide)) return t > 0.5 ? -99 : 99;
  const side = phi >= 0 ? 1 : -1;
  const delay =
    pulledSide >= 2
      ? Math.pow(Math.abs(phi) / Math.PI, 1.2) * 0.35
      : pulledSide === 0
        ? 0.05
        : side === pulledSide
          ? 0
          : 0.13;
  const s = Math.max(t - delay, 0);
  return 1.76 - (0.35 * s + 0.78 * s * s);
}

// ---------------------------------------------------------------------------
// Pull, flinch and tremble. The expression itself comes from the head's three
// morph targets (wince, grimace, scream); this adds the stretched cheek and the
// head turning away from the pull. Shared by the skin and the teeth.
// ---------------------------------------------------------------------------
const headGLSL = `
uniform vec3 uGrab;
uniform vec3 uPull;
uniform float uExpr;
uniform float uTime;
uniform vec3 uHeadRot;   // tilt, yaw, roll in radians
uniform float uShake;
uniform vec3 uHeadPull;
uniform float uWiden;
vec3 stretchAndFlinch(vec3 p){
  // after the nose rip the mouth is left stretched wide open in shock
  if (uWiden > 0.0) {
    float mz = exp(-pow(p.x / 0.05, 2.0) - pow((p.y - 1.497) / 0.032, 2.0)) * smoothstep(-0.02, 0.05, p.z);
    p.x *= 1.0 + 0.42 * uWiden * mz;
    p.y -= 0.014 * uWiden * mz * smoothstep(1.505, 1.475, p.y);
  }
  // the grabbed cheek is dragged out; the rest of that half of the face follows
  float d = distance(p, uGrab);
  float near = pow(clamp(1.0 - d / 0.1, 0.0, 1.0), 1.5);
  float wide = pow(clamp(1.0 - d / 0.22, 0.0, 1.0), 2.0) * 0.45;
  float faceOnly = smoothstep(1.43, 1.47, p.y);
  // pulled from the forehead, the brows stay raised: only the skin above them is dragged
  float downMode = step(1.64, uGrab.y) * step(abs(uGrab.x), 0.001);
  faceOnly *= mix(1.0, 0.1 + 0.9 * smoothstep(1.6, 1.71, p.y), downMode);
  // the mouth is shielded so the scream stays readable while the cheek stretches
  float mouthZone = exp(-pow(p.x / 0.034, 2.0) - pow((p.y - 1.500) / 0.024, 2.0)) * smoothstep(-0.03, 0.0, p.z);
  p += uPull * max(near, wide) * faceOnly * (1.0 - 0.75 * mouthZone) + uPull * 0.18 * mouthZone * faceOnly;
  // the head is yanked toward the pull, strains against it and trembles
  float h = smoothstep(1.40, 1.50, p.y);
  if (h > 0.0) {
    p += uHeadPull * h;
    vec3 pivot = vec3(0.0, 1.45, -0.01);
    vec3 q = p - pivot;
    float tilt = uHeadRot.x * h, yaw = uHeadRot.y * h, roll = uHeadRot.z * h;
    float c = cos(tilt), s = sin(tilt);
    q = vec3(q.x, c * q.y - s * q.z, s * q.y + c * q.z);
    c = cos(yaw); s = sin(yaw);
    q = vec3(c * q.x + s * q.z, q.y, -s * q.x + c * q.z);
    c = cos(roll); s = sin(roll);
    q = vec3(c * q.x - s * q.y, s * q.x + c * q.y, q.z);
    p = pivot + q;
    p.x += (sin(uTime * 47.0) + sin(uTime * 83.0 + 2.1) * 0.6) * uShake * 0.0026 * h;
    p.y += (sin(uTime * 61.0 + 1.3) + sin(uTime * 97.0) * 0.5) * uShake * 0.0013 * h;
  }
  return p;
}`;

// ---------------------------------------------------------------------------
// Skin shading: matte, uneven tone, warm light bleeding into the shadows, fine
// creases and pores, a dark mouth interior, no plastic rim sheen.
// ---------------------------------------------------------------------------
const skinNoiseGLSL = `
float sHash(vec3 p){p=fract(p*0.3183099+vec3(0.1,0.17,0.13));p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float sNoise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
  return mix(mix(mix(sHash(i),sHash(i+vec3(1,0,0)),f.x),mix(sHash(i+vec3(0,1,0)),sHash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(sHash(i+vec3(0,0,1)),sHash(i+vec3(1,0,1)),f.x),mix(sHash(i+vec3(0,1,1)),sHash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float sFbm(vec3 p){return sNoise(p)*0.55+sNoise(p*2.03+3.1)*0.28+sNoise(p*4.11+7.7)*0.17;}
vec3 skinPerturb(vec3 surfPos,vec3 surfNorm,vec2 dHdxy,float faceDir){
  vec3 sx=normalize(dFdx(surfPos)),sy=normalize(dFdy(surfPos));
  vec3 r1=cross(sy,surfNorm),r2=cross(surfNorm,sx);
  float det=dot(sx,r1)*faceDir;
  vec3 grad=sign(det)*(dHdxy.x*r1+dHdxy.y*r2);
  return normalize(abs(det)*surfNorm-grad);
}`;

// Vertex part shared by skin and teeth: morph, stretch, flinch, then peel.
const peelVertexGLSL = (rest) => `
      vec3 deformed = stretchAndFlinch(transformed);
      float peelPhi = atan(${rest}.x, ${rest}.z);
      float peelY = peelFront(peelPhi);
      float peelD = deformed.y - peelY;
      vSkinRest = ${rest}; vPeelD = peelD; vPhi = peelPhi;
      transformed = deformed;
      if (peelD > 0.0) {
        float pc = peelCenter(peelPhi);
        vec3 peelN = vec3(sin(pc), 0.0, cos(pc));
        float peelTh = clamp(peelD * 8.5, 0.0, 2.75);
        vec3 hinge = vec3(deformed.x, peelY, deformed.z);
        transformed = hinge + vec3(0.0, 1.0, 0.0) * peelD * cos(peelTh)
                    + peelN * (peelD * sin(peelTh) + 0.006 * smoothstep(0.0, 0.04, peelD));
        transformed.y -= peelD * peelD * 0.35;
      }`;
const peelNormalGLSL = `
      {
        float nPhi = atan(position.x, position.z);
        float nD = position.y - peelFront(nPhi);
        if (nD > 0.0) {
          float pc = peelCenter(nPhi);
          vec3 axis = normalize(cross(vec3(0.0, 1.0, 0.0), vec3(sin(pc), 0.0, cos(pc))));
          float th = clamp(nD * 8.5, 0.0, 2.75), cs = cos(th), sn = sin(th);
          objectNormal = objectNormal * cs + cross(axis, objectNormal) * sn + axis * dot(axis, objectNormal) * (1.0 - cs);
        }
      }`;
const peelFragmentGLSL = `
      if (uPeelSide > 1.5 && uPeel >= 0.0 && dustTime(vSkinRest) < uPeel) discard;
      if (vPeelD > 0.0) {
        // ragged tear down the middle
        float f = fract((vPhi + PI) / (2.0 * PI) * ${PEEL_STRIPS.toFixed(1)});
        float border = min(f, 1.0 - f) * (2.0 * PI / ${PEEL_STRIPS.toFixed(1)}) * max(length(vSkinRest.xz), 0.02);
        float ragged = 0.0035 + sNoise(vSkinRest * 160.0) * 0.006;
        if (uPeelSide < 1.5 && border < ragged * smoothstep(0.0, 0.02, vPeelD)) discard;
        // peeled skin breaks apart as it falls
        float holes = sNoise(vSkinRest * 38.0) * 0.65 + sNoise(vSkinRest * 130.0) * 0.35;
        if (holes < smoothstep(0.4, 0.8, vPeelD) * 1.05) discard;
      }`;

function patch(
  material,
  uniforms,
  key,
  { vertexHeader = "", fragmentHeader = "", color = "", extra = (s) => s } = {},
) {
  material.customProgramCacheKey = () => key;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
      varying vec3 vSkinRest;
      varying float vPeelD;
      varying float vPhi;
      ${vertexHeader}
      ${peelGLSL}
      ${headGLSL}
    `,
      )
      .replace(
        "#include <morphnormal_vertex>",
        `#include <morphnormal_vertex>\n${peelNormalGLSL}\n`,
      )
      .replace(
        "#include <morphtarget_vertex>",
        `#include <morphtarget_vertex>\n${peelVertexGLSL("position")}\n`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
      varying vec3 vSkinRest;
      varying float vPeelD;
      varying float vPhi;
      uniform float uPeelSide;
      uniform float uPeel;
      ${fragmentHeader}
      ${skinNoiseGLSL}
      ${dustGLSL}
    `,
      )
      .replace("void main() {", `void main() {${peelFragmentGLSL}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\n${color}\n`,
      );
    extra(shader);
  };
  return material;
}

// Real thickness at the cut. Thin copies of the skin sit just under it, each one
// layer deeper (dermis, then yellow fat), and only the strip along the torn
// edge is drawn. The deeper layers bulge out a little past the edge, so the cut
// shows a ragged wall of flesh instead of a paper edge.
const dustTintGLSL = `
      // turning to dust: it greys and dries out first, and darkens right as it crumbles
      if (uPeelSide > 1.5 && uPeel >= 0.0) {
        float left = dustTime(vSkinRest) - uPeel;
        vec3 ash = mix(vec3(0.34, 0.32, 0.3), vec3(0.6, 0.58, 0.55), sNoise(vSkinRest * 180.0));
        tone = mix(tone, ash, max(smoothstep(0.0, 0.35, uPeel) * 0.35, 1.0 - smoothstep(0.0, 0.45, left)));
        tone *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.05, left));
      }`;
const SKIN_SHELLS = 4,
  SKIN_THICK = 0.0055;
const shellColorGLSL = `
      vec3 r = vSkinRest;
      float torn = tornRegion(r);
      float sd = uTornKeep > 0.5 ? torn : -torn;      // how far into the kept skin, from the cut
      float f = uShell;
      float bulge = f * 0.0024 + (sNoise(r * 420.0 + f * 7.0) - 0.5) * 0.0018 + (sNoise(r * 95.0 + f * 3.0) - 0.5) * 0.0012;
      if (sd < -bulge || sd > 0.009) discard;
      if (uTornKeep > 0.5 && sNoise(r * 38.0) * 0.65 + sNoise(r * 130.0) * 0.35 < uPieceFade * 1.05) discard;
      float lob = sNoise(r * 520.0 + f * 5.0);
      vec3 dermis = mix(vec3(0.74, 0.36, 0.33), vec3(0.86, 0.55, 0.5), sNoise(r * 300.0));
      vec3 fat = mix(vec3(0.95, 0.74, 0.36), vec3(0.8, 0.5, 0.22), smoothstep(0.35, 0.75, lob));
      vec3 tone = mix(dermis, fat, smoothstep(0.22, 0.45, f));
      vec3 blood = mix(vec3(0.42, 0.03, 0.03), vec3(0.2, 0.01, 0.01), sNoise(r * 210.0));
      float bl = smoothstep(0.45, 0.75, sNoise(r * 150.0 + f * 2.0)) * 0.8 + 0.25 * f + 0.1;
      tone = mix(tone, blood, clamp(bl, 0.0, 0.9));
      tone *= 1.0 - 0.3 * f;
      ${dustTintGLSL}
      if (!gl_FrontFacing) tone *= 0.55;
      diffuseColor.rgb = tone;`;

function skinMaterial(uniforms, key = "mh-skin-v2", shell = false) {
  const material = new THREE.MeshPhysicalMaterial({
    color: "#c39079",
    roughness: 0.62,
    metalness: 0,
    specularIntensity: 0.22,
    specularColor: new THREE.Color("#ffe6dc"),
    side: THREE.DoubleSide,
  });
  if (shell) material.defines = { SKIN_SHELL: "" };
  const shellUniform = shell ? " uniform float uShell;" : "";
  return patch(material, uniforms, key, {
    vertexHeader:
      "attribute vec4 skinTag; varying float vCavity; uniform float uTornKeep; uniform float uTornTime;" +
      shellUniform +
      tornGLSL,
    fragmentHeader:
      "varying float vCavity; uniform float uTension; uniform vec3 uGrab; uniform float uExpr; uniform float uTornKeep; uniform float uTornTime; uniform float uPieceFade;" +
      shellUniform +
      tornGLSL,
    color: shell
      ? shellColorGLSL
      : `
      vec3 r = vSkinRest;
      // the torn piece: the body keeps everything outside it, the falling piece only what is inside
      float torn = tornRegion(r);
      if (uTornSide != 0.0) {
        if (uTornKeep > 0.5) { if (torn < 0.0) discard;
          if (sNoise(r * 38.0) * 0.65 + sNoise(r * 130.0) * 0.35 < uPieceFade * 1.05) discard; }
        else if (torn > 0.0) discard;
      }
      float blot = sFbm(r * 7.0);
      float mottle = sNoise(r * 95.0);
      vec3 tone = diffuseColor.rgb;
      tone = mix(tone, tone * vec3(1.08, 0.88, 0.84), smoothstep(0.45, 0.8, blot) * 0.6);
      tone = mix(tone, tone * vec3(0.95, 1.0, 1.05), smoothstep(0.55, 0.2, blot) * 0.3);
      tone *= 0.93 + 0.09 * mottle;
      // redder lips and nose tip
      float lips = exp(-pow(r.x / 0.026, 2.0) - pow((r.y - ${FACE.mouthY.toFixed(3)}) / 0.011, 2.0)) * smoothstep(0.07, 0.095, r.z);
      tone = mix(tone, tone * vec3(1.05, 0.74, 0.72), lips * 0.5);
      float nose = exp(-pow(r.x / 0.012, 2.0) - pow((r.y - ${FACE.noseY.toFixed(3)}) / 0.01, 2.0)) * smoothstep(0.095, ${FACE.noseZ.toFixed(3)}, r.z);
      tone = mix(tone, tone * vec3(1.06, 0.84, 0.82), nose * 0.5);
      // stretched skin around the grabbed cheek pales
      tone = mix(tone, vec3(0.88, 0.76, 0.69), uTension * exp(-pow(distance(r, uGrab) / 0.06, 2.0)) * 0.4);
      // --- eyes: dark lash line where the lids meet the eyeball ---
      {
        vec3 ec = vec3(sign(r.x) * ${EYE.x.toFixed(4)}, ${EYE.y.toFixed(4)}, ${EYE.z.toFixed(4)});
        float de = distance(r, ec);
        float lash = (1.0 - smoothstep(0.0147, 0.0172, de)) * smoothstep(0.06, 0.075, r.z);
        tone = mix(tone, vec3(0.12, 0.07, 0.06), lash * 0.85);
        // a soft darker socket and upper-lid crease that deepen with fear
        float socket = exp(-pow((de - 0.0215) / 0.0045, 2.0)) * step(${EYE.y.toFixed(4)}, r.y) * smoothstep(0.06, 0.08, r.z);
        tone *= 1.0 - socket * (0.16 + 0.22 * uExpr);
      }
      // --- eyebrows: short dark hairs along the brow arch ---
      {
        float ax = abs(r.x);
        float t = clamp((ax - 0.006) / 0.054, 0.0, 1.0);
        float yc = 1.6095 + 0.0072 * sin(3.14159 * pow(t, 0.75)) - 0.0012 * t;
        float th = mix(0.0088, 0.0042, t);
        float inside = 1.0 - smoothstep(th * 0.55, th, abs(r.y - yc));
        inside *= smoothstep(0.004, 0.009, ax) * (1.0 - smoothstep(0.056, 0.062, ax)) * smoothstep(0.07, 0.085, r.z);
        // hairs run outward and slightly up: streak noise stretched along that direction
        vec3 hp = vec3(r.x * 160.0, (r.y - (ax - 0.006) * 0.25) * 1900.0, r.z * 160.0);
        float hair = smoothstep(0.3, 0.7, sNoise(hp)) * 0.45 + 0.55;
        float edge = sNoise(r * 900.0);
        tone = mix(tone, vec3(0.11, 0.07, 0.05), inside * hair * (0.8 + 0.2 * edge) * 0.95);
      }
      // --- fear creases: forehead lines and a frown between the brows ---
      {
        float ax = abs(r.x);
        float fy = r.y - 1.632 + ax * ax * 0.7;   // lines bow slightly with the forehead
        float band = smoothstep(0.0, 0.006, fy) * (1.0 - smoothstep(0.038, 0.05, fy))
                   * (1.0 - smoothstep(0.035, 0.058, ax)) * smoothstep(0.06, 0.08, r.z);
        float ph = fy / 0.0105 * 6.2832 + sNoise(r * 60.0) * 1.4;
        float groove = pow(0.5 + 0.5 * sin(ph), 7.0), lip = pow(0.5 + 0.5 * sin(ph + 1.3), 7.0);
        float w = band * uExpr;
        tone *= 1.0 - groove * 0.32 * w;
        tone += lip * 0.05 * w;
        // two short vertical frown lines between the inner brows
        float frown = exp(-pow((ax - 0.0055) / 0.0011, 2.0)) * smoothstep(1.603, 1.609, r.y) * (1.0 - smoothstep(1.622, 1.63, r.y));
        tone *= 1.0 - frown * 0.38 * uExpr;
        // the skin around a terrified face blanches slightly
        tone = mix(tone, tone * vec3(0.97, 0.94, 0.93), uExpr * 0.4);
      }
      // inside of the mouth
      tone = mix(tone, vec3(0.16, 0.04, 0.04), vCavity);
      // inner side of the skin, seen on the curling halves
      // --- blood ---
      vec3 blood = mix(vec3(0.42, 0.03, 0.03), vec3(0.2, 0.01, 0.01), sNoise(r * 210.0));
      float wet = 0.0;
      if (uTornSide != 0.0) {
        // the cut edge shows the layers of the skin: pale yellow fat, then pink dermis, then blood
        float dEdge = abs(torn) + (sNoise(r * 300.0) - 0.5) * 0.0015;
        float derm = 1.0 - smoothstep(0.0005, 0.0011, dEdge);
        float smear = (1.0 - smoothstep(0.0011, 0.007 + sNoise(r * 90.0) * 0.008, dEdge)) * (1.0 - derm);
        // skin around the wound is inflamed and puffy-red
        float swell = (1.0 - smoothstep(0.004, 0.03, dEdge)) * step(torn, 0.0);
        tone = mix(tone, tone * vec3(1.08, 0.74, 0.68), swell * 0.7);
        tone = mix(tone, vec3(0.9, 0.7, 0.64), derm * 0.8);
        wet = max(wet, smear * 0.9);
        // a few drips running down from the edge on the body
        if (uTornKeep < 0.5) {
          float col = sNoise(vec3(r.x * 95.0, 3.1, r.z * 95.0));
          float len = (0.012 + 0.05 * sNoise(vec3(r.x * 31.0, 7.7, r.z * 31.0))) * smoothstep(0.0, 1.6, uTornTime);
          float above = tornRegion(r + vec3(0.0, len, 0.0));
          float drip = step(0.72, col) * step(0.0, above) * step(torn, 0.0);
          float thin = smoothstep(0.72, 0.8, col);
          wet = max(wet, drip * thin * 0.85);
        }
      }
      // seen through the hole, the inside of the head's skin is dark raw flesh
      if (!gl_FrontFacing && vPeelD <= 0.0 && uTornKeep < 0.5) tone = mix(vec3(0.16, 0.03, 0.03), vec3(0.3, 0.07, 0.06), sNoise(r * 60.0));
      // the inside of the skin is raw and bloody wherever it shows
      if (!gl_FrontFacing && (vPeelD > 0.0 || uTornKeep > 0.5)) {
        vec3 raw = mix(vec3(0.66, 0.24, 0.2), vec3(0.78, 0.5, 0.44), sNoise(r * 70.0));
        tone = mix(raw, blood, smoothstep(0.45, 0.8, sNoise(r * 45.0)) * 0.85);
      }
      // the peeling edge is bloody too
      if (vPeelD > 0.0) wet = max(wet, (1.0 - smoothstep(0.0, 0.012, vPeelD)) * 0.7);
      tone = mix(tone, blood, wet);
      ${dustTintGLSL}
      diffuseColor.rgb = tone;`,
    extra: (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "vSkinRest = position;",
          "vSkinRest = position; vCavity = skinTag.y;",
        )
        .replace(
          "#include <project_vertex>",
          `
          if (uTornSide != 0.0 && uTornKeep < 0.5) {
            float tr = tornRegion(position);
            float lip = (1.0 - smoothstep(0.0, 0.014, -tr)) * step(tr, 0.0) * smoothstep(0.0, 0.25, uTornTime);
            transformed += normalize(objectNormal) * lip * lip * 0.0045;   // the edge rolls up off the flesh
          }
          #ifdef SKIN_SHELL
          transformed -= normalize(objectNormal) * uShell * ${SKIN_THICK.toFixed(4)};   // one layer deeper into the skin
          #endif
          #include <project_vertex>
          #ifdef SKIN_SHELL
          // the layers only exist along the cut: everything else is thrown out before it is drawn
          if (uTornSide == 0.0 || abs(tornRegion(position)) > 0.03) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
          #endif`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * (0.85 + 0.3 * sNoise(vSkinRest * 40.0)), 0.4, 0.9);
        roughnessFactor = mix(roughnessFactor, 0.3, vCavity);
        if (uPeelSide > 1.5 && uPeel >= 0.0) roughnessFactor = mix(roughnessFactor, 0.95, smoothstep(0.0, 0.4, uPeel));
        if (uTornSide != 0.0) roughnessFactor = mix(roughnessFactor, 0.18, 1.0 - smoothstep(0.0, 0.01, abs(tornRegion(vSkinRest))));
      `,
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
        {
          vec3 pr = vSkinRest;
          float hgt = sFbm(pr * 140.0) * 0.0028 + sNoise(pr * 900.0) * 0.0012;
          vec2 dh = vec2(dFdx(hgt), dFdy(hgt)) * (1.0 - vCavity);
          normal = skinPerturb(-vViewPosition, normal, dh * 55.0, faceDirection);
        }
        #ifdef SKIN_SHELL
        {
          // the cut wall faces into the hole, not along the skin (gradient from screen derivatives: cheap)
          vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
          vec3 g = dFdx(sd) * dpx / max(dot(dpx, dpx), 1e-12) + dFdy(sd) * dpy / max(dot(dpy, dpy), 1e-12);
          if (dot(g, g) > 1e-8) normal = normalize(mix(normal, -normalize(g), 0.7));
        }
        #endif
      `,
        )
        .replace(
          "#include <opaque_fragment>",
          `
        // light that enters the skin comes back out warm: lift and redden the shadows
        float lum = dot(outgoingLight, vec3(0.299, 0.587, 0.114));
        float shade = (1.0 - smoothstep(0.06, 0.42, lum)) * (1.0 - vCavity);
        outgoingLight = mix(outgoingLight, outgoingLight * vec3(1.18, 0.84, 0.74) + vec3(0.03, 0.006, 0.0), shade * 0.85);
        #include <opaque_fragment>
      `,
        );
    },
  });
}

function mouthMaterial(uniforms) {
  const material = new THREE.MeshStandardMaterial({
    color: "#a99d8a",
    roughness: 0.45,
    metalness: 0,
  });
  return patch(material, uniforms, "mh-mouth-v2", {
    vertexHeader:
      "attribute vec4 skinTag; varying float vTongue; varying float vEye;",
    fragmentHeader:
      "varying float vTongue; varying float vEye; uniform vec2 uLook; uniform float uExpr; uniform float uRollBack;" +
      tornGLSL,
    color: `
      // whatever sat under the torn-off skin (eyes, teeth) goes with it
      if (uTornSide != 0.0 && tornRegion(vSkinRest) > -0.002) discard;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.11, 0.11), vTongue);
      diffuseColor.rgb *= mix(0.25, 1.0, smoothstep(0.045, 0.1, vSkinRest.z));
      if (vEye > 0.5) {
        // eyeball: white with a small dark iris that darts toward the pull
        vec3 c = vec3(sign(vSkinRest.x) * ${EYE.x.toFixed(4)}, ${EYE.y.toFixed(4)}, ${EYE.z.toFixed(4)});
        vec3 d = normalize(vSkinRest - c);
        vec3 look = normalize(mix(vec3(uLook, 1.0), vec3(0.0, 2.6, 0.35), uRollBack));
        float a = acos(clamp(dot(d, look), -1.0, 1.0));
        float iris = 0.36 - 0.07 * uExpr;   // terror: the iris looks smaller, more white around it
        float pupil = 0.13 + 0.05 * uExpr;
        vec3 white = vec3(0.86, 0.82, 0.77) * mix(1.0, 0.82, smoothstep(0.6, 1.3, a));
        white = mix(white, vec3(0.8, 0.45, 0.42), smoothstep(0.9, 1.4, a) * (0.35 + 0.4 * uExpr)); // bloodshot edges
        vec3 irisCol = mix(vec3(0.33, 0.21, 0.11), vec3(0.16, 0.1, 0.06), smoothstep(iris * 0.5, iris, a));
        vec3 col = mix(irisCol, white, smoothstep(iris - 0.025, iris + 0.01, a));
        col = mix(vec3(0.02), col, smoothstep(pupil - 0.02, pupil + 0.01, a));
        col = mix(col, white, uRollBack * 0.55);
        diffuseColor.rgb = col;
      }
      { vec3 tone = diffuseColor.rgb; ${dustTintGLSL} diffuseColor.rgb = tone; }`,
    extra: (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "vSkinRest = position;",
        "vSkinRest = position; vTongue = skinTag.x; vEye = skinTag.z;",
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.08, vEye);",
      );
    },
  });
}

// The dust itself: flakes scattered over the skin, each one let go when its spot
// of skin crumbles, then carried off by a soft wind.
function makeDust(geometry, uniforms, count = 45000) {
  const P = geometry.attributes.position,
    N = geometry.attributes.normal,
    I = geometry.index.array;
  const tris = I.length / 3,
    cum = new Float32Array(tris),
    a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3();
  let total = 0;
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(P, I[t * 3]);
    b.fromBufferAttribute(P, I[t * 3 + 1]);
    c.fromBufferAttribute(P, I[t * 3 + 2]);
    total += b.sub(a).cross(c.sub(a)).length() / 2;
    cum[t] = total;
  }
  const pos = new Float32Array(count * 3),
    nor = new Float32Array(count * 3),
    seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = Math.random() * total;
    let lo = 0,
      hi = tris - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cum[m] < r) lo = m + 1;
      else hi = m;
    }
    let u = Math.random(),
      v = Math.random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    for (let k = 0; k < 3; k++) {
      const i0 = I[lo * 3] * 3 + k,
        i1 = I[lo * 3 + 1] * 3 + k,
        i2 = I[lo * 3 + 2] * 3 + k;
      pos[i * 3 + k] =
        P.array[i0] * (1 - u - v) + P.array[i1] * u + P.array[i2] * v;
      nor[i * 3 + k] =
        N.array[i0] * (1 - u - v) + N.array[i1] * u + N.array[i2] * v;
    }
    seed[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aNormal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPeel: uniforms.uPeel,
      uTornSide: uniforms.uTornSide,
      uScale: { value: 800 },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute vec3 aNormal; attribute float aSeed;
      uniform float uPeel; uniform float uScale;
      varying float vAge; varying float vSeed; varying float vAlpha;
      ${tornGLSL}
      ${dustGLSL}
      void main() {
        float age = uPeel - dustTime(position);
        vAge = age; vSeed = aSeed; vAlpha = 0.0;
        if (uPeel < 0.0 || age < 0.0 || age > 1.1 || tornRegion(position) > 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
        vec3 n = normalize(aNormal);
        vec3 wind = vec3(0.34, 0.15, -0.05) * (0.5 + 0.9 * fract(aSeed * 7.13));
        vec3 swirl = vec3(sin(aSeed * 31.0 + age * 5.0), 0.6 * sin(aSeed * 17.0 + age * 4.0), cos(aSeed * 23.0 + age * 4.5)) * 0.05 * age;
        vec3 p = position + n * (0.004 + 0.035 * age) + wind * age * (0.35 + age) + swirl;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = (0.0022 + 0.0032 * fract(aSeed * 3.7)) * (1.0 - 0.45 * age);
        gl_PointSize = clamp(size * uScale / -mv.z, 1.0, 10.0);
        vAlpha = (1.0 - smoothstep(0.45, 1.1, age)) * smoothstep(0.0, 0.04, age);
      }`,
    fragmentShader: `
      varying float vAge; varying float vSeed; varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = atan(c.y, c.x);
        if (length(c) > 0.33 + 0.12 * sin(a * 3.0 + vSeed * 40.0) + 0.05 * sin(a * 7.0 + vSeed * 13.0)) discard;   // ragged flake
        vec3 ash = mix(vec3(0.3, 0.29, 0.27), vec3(0.62, 0.6, 0.57), fract(vSeed * 11.3));
        vec3 col = mix(vec3(0.5, 0.36, 0.3), ash, smoothstep(0.0, 0.25, vAge));
        gl_FragColor = vec4(col, vAlpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const points = new THREE.Points(g, material);
  points.frustumCulled = false;
  points.visible = false;
  points.renderOrder = 5;
  return points;
}

// Copy a glTF mesh into world space, keeping its morph targets, and move the
// vertex colours (which carry tags, not colours) to their own attribute.
function bakeMesh(source) {
  source.updateWorldMatrix(true, false);
  const m = source.matrixWorld,
    linear = new THREE.Matrix3().setFromMatrix4(m),
    nm = new THREE.Matrix3().getNormalMatrix(m);
  const src = source.geometry,
    g = new THREE.BufferGeometry(),
    v = new THREE.Vector3();
  const copy = (attr, fn) => {
    const out = new Float32Array(attr.count * 3);
    for (let i = 0; i < attr.count; i++)
      fn(v.fromBufferAttribute(attr, i)).toArray(out, i * 3);
    return new THREE.BufferAttribute(out, 3);
  };
  g.setAttribute(
    "position",
    copy(src.attributes.position, (p) => p.applyMatrix4(m)),
  );
  g.setAttribute(
    "normal",
    copy(src.attributes.normal, (n) => n.applyMatrix3(nm).normalize()),
  );
  const c = src.attributes.color,
    tag = new Float32Array(c.count * 4);
  for (let i = 0; i < c.count; i++) {
    tag[i * 4] = c.getX(i);
    tag[i * 4 + 1] = c.getY(i);
    tag[i * 4 + 2] = c.getZ(i);
    tag[i * 4 + 3] = 1;
  }
  g.setAttribute("skinTag", new THREE.BufferAttribute(tag, 4));
  g.setIndex(src.index.clone());
  if (src.morphAttributes.position) {
    g.morphTargetsRelative = src.morphTargetsRelative;
    g.morphAttributes.position = src.morphAttributes.position.map((a) =>
      copy(a, (p) =>
        src.morphTargetsRelative ? p.applyMatrix3(linear) : p.applyMatrix4(m),
      ),
    );
    if (src.morphAttributes.normal)
      g.morphAttributes.normal = src.morphAttributes.normal.map((a) =>
        copy(a, (n) => n.applyMatrix3(nm)),
      );
  }
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g);
  mesh.morphTargetDictionary = { ...source.morphTargetDictionary };
  mesh.morphTargetInfluences = [...(source.morphTargetInfluences || [0, 0, 0])];
  mesh.frustumCulled = false; // the peel moves vertices far from their rest positions
  return mesh;
}

export function bakeSkin(scene) {
  scene.updateMatrixWorld(true);
  let skin = null,
    mouth = null;
  scene.traverse((o) => {
    if (o.isMesh) {
      if (/mouth/i.test(o.name)) mouth = o;
      else skin = o;
    }
  });
  if (!skin || !mouth) throw new Error("Expected the skin and mouth meshes.");
  const group = new THREE.Group();
  group.userData.skin = bakeMesh(skin);
  group.userData.mouth = bakeMesh(mouth);
  group.add(group.userData.skin, group.userData.mouth);
  return group;
}

// Expression weights along the pull: wince, then grimace, then a full scream.
function expressionWeights(p) {
  return {
    wince: band(p, 0, 0.3) * (1 - band(p, 0.38, 0.62)),
    grimace: band(p, 0.3, 0.58) * (1 - band(p, 0.68, 0.9)),
    scream: band(p, 0.62, 0.95),
  };
}

export class SkinPeel {
  constructor({ mesh, scene, camera, canvas, reducedMotion, onChange }) {
    Object.assign(this, {
      mesh,
      scene,
      camera,
      canvas,
      reducedMotion,
      onChange,
    });
    this.skin = mesh.userData.skin;
    this.mouth = mesh.userData.mouth;
    this.uniforms = {
      uGrab: { value: new THREE.Vector3(0, 99, 0) },
      uPull: { value: new THREE.Vector3() },
      uPeel: { value: -1 },
      uPeelSide: { value: 0 },
      uExpr: { value: 0 },
      uTension: { value: 0 },
      uTime: { value: 0 },
      uHeadRot: { value: new THREE.Vector3() },
      uShake: { value: 0 },
      uHeadPull: { value: new THREE.Vector3() },
      uLook: { value: new THREE.Vector2() },
      uRollBack: { value: 0 },
      uTornSide: { value: 0 },
      uTornKeep: { value: 0 },
      uTornTime: { value: 0 },
      uPieceFade: { value: 0 },
      uWiden: { value: 0 },
    };
    // the piece that tears off: same skin, frozen in its stretched pose, then it drops
    const u0 = this.uniforms;
    this.pieceUniforms = {
      ...u0,
      uPeel: { value: -1 },
      uPull: { value: new THREE.Vector3() },
      uHeadPull: { value: new THREE.Vector3() },
      uHeadRot: { value: new THREE.Vector3() },
      uShake: { value: 0 },
      uTornKeep: { value: 1 },
      uPieceFade: { value: 0 },
      uWiden: { value: 0 },
    };
    this.piece = new THREE.Mesh(
      this.skin.geometry,
      skinMaterial(this.pieceUniforms, "mh-skin-piece-v2"),
    );
    this.piece.morphTargetDictionary = this.skin.morphTargetDictionary;
    this.piece.morphTargetInfluences = [...this.skin.morphTargetInfluences];
    this.piece.frustumCulled = false;
    this.pivot = new THREE.Group();
    this.pivot.add(this.piece);
    this.pivot.visible = false;
    scene.add(this.pivot);
    this.tearT = -1;
    this.peelDelay = 0;
    this.pieceDir = new THREE.Vector3();
    this.pieceAxis = new THREE.Vector3(1, 0, 0);
    this.skin.material = skinMaterial(this.uniforms);
    // layers that give the torn edge its thickness, on the body and on the piece
    this.shells = [];
    for (const [owner, uni] of [
      [this.skin, this.uniforms],
      [this.piece, this.pieceUniforms],
    ]) {
      for (let k = 1; k <= SKIN_SHELLS; k++) {
        const shell = new THREE.Mesh(
          this.skin.geometry,
          skinMaterial(
            { ...uni, uShell: { value: k / SKIN_SHELLS } },
            "mh-skin-shell-v2",
            true,
          ),
        );
        shell.morphTargetDictionary = owner.morphTargetDictionary;
        shell.morphTargetInfluences = owner.morphTargetInfluences; // same array: always in the same pose
        shell.frustumCulled = false;
        shell.visible = false;
        shell.raycast = () => {};
        owner.add(shell);
        this.shells.push(shell);
      }
    }
    this.mouth.material = mouthMaterial(this.uniforms);
    this.dust = makeDust(this.skin.geometry, this.uniforms);
    scene.add(this.dust);
    this.ray = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pullTarget = new THREE.Vector3();
    this.drag = null;
    this.cloth = null;
    this.revealed = false;
    this.side = 0;
    this.snapT = -1;
    this.phase = "covered";
    this.progress = 0;
    this.shown = 0;
    this.elapsed = 0;
  }
  get canExplore() {
    return this.revealed && !this.drag;
  }
  get peeling() {
    return this.tearT >= 0 && !this.revealed;
  }
  notify() {
    this.onChange(this.phase, this.canExplore);
  }
  hit(event) {
    const box = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - box.left) / box.width) * 2 - 1,
      1 - ((event.clientY - box.top) / box.height) * 2,
    );
    this.ray.setFromCamera(this.pointer, this.camera);
    return this.ray.intersectObject(this.skin, false)[0];
  }
  // Only the face can be grabbed.
  isFace(point) {
    return (
      point.y > FACE.chinY - 0.005 &&
      point.y < FACE.topY - 0.03 &&
      point.z > 0.03 &&
      Math.abs(point.x) < 0.08
    );
  }
  begin(event) {
    if (this.revealed || this.peeling || this.drag) return false;
    const hit = this.hit(event);
    if (!hit || !this.isFace(hit.point)) return false;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.side = 0;
    this.progress = 0;
    this.phase = "pulling";
    this.notify();
    return true;
  }
  move(event) {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const box = this.canvas.getBoundingClientRect();
    const dx = event.clientX - this.drag.x,
      dy = event.clientY - this.drag.y;
    // the first clear movement decides: sideways pulls a cheek, downward pulls the forehead
    if (!this.side && Math.hypot(dx, dy) > 14) {
      if (dy > Math.abs(dx)) this.side = 2;
      else if (-dy > Math.abs(dx)) this.side = 3;
      else this.side = Math.sign(dx);
      if (this.side) this.uniforms.uGrab.value.copy(GRAB.point(this.side));
    }
    if (!this.side) return;
    const threshold = clamp(box.width * 0.28, 190, 360);
    const along = this.side === 2 ? dy : this.side === 3 ? -dy : dx * this.side,
      across = this.side >= 2 ? dx : dy;
    this.progress = clamp(
      Math.max(0, along + Math.abs(across) * 0.35) / threshold,
      0,
      1,
    );
    if (this.progress >= 1) this.tear();
  }
  end(event) {
    if (!this.drag || (event && event.pointerId !== this.drag.id)) return;
    this.drag = null;
    this.progress = 0;
    this.phase = "recoiling";
    this.notify();
  }
  tear() {
    const u = this.uniforms,
      pu = this.pieceUniforms,
      side = this.side;
    this.drag = null;
    this.progress = 1;
    u.uPeelSide.value = side;
    u.uTornSide.value = side;
    u.uTornTime.value = 0;
    // freeze the piece in the pose it was torn from
    pu.uPull.value.copy(u.uPull.value);
    pu.uHeadPull.value.copy(u.uHeadPull.value);
    pu.uHeadRot.value.copy(u.uHeadRot.value);
    pu.uPieceFade.value = 0;
    this.piece.morphTargetInfluences.splice(
      0,
      Infinity,
      ...this.skin.morphTargetInfluences,
    );
    const c = GRAB.point(side).add(u.uPull.value);
    this.pivot.position.copy(c);
    this.piece.position.copy(c).negate();
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.visible = true;
    this.pieceT = 0;
    this.pieceDir.copy(GRAB.dir(side));
    this.pieceAxis
      .crossVectors(this.pieceDir, new THREE.Vector3(0, 0, 1))
      .normalize();
    if (this.pieceAxis.lengthSq() < 0.01) this.pieceAxis.set(1, 0, 0);
    for (const shell of this.shells) shell.visible = true;
    this.snapT = 0; // the head springs back into place
    this.tearT = 0;
    this.peelDelay = side === 3 ? 1.0 : 0.35;
    this.phase = "revealing";
    this.notify();
  }
  skip() {
    this.drag = null;
    this.side = 0;
    this.uniforms.uPeelSide.value = 0;
    this.uniforms.uTornSide.value = 0;
    this.tearT = 0;
    this.peelDelay = 0;
    this.phase = "revealing";
    this.notify();
  }
  reset() {
    this.drag = null;
    this.revealed = false;
    this.phase = "covered";
    this.progress = 0;
    this.shown = 0;
    this.side = 0;
    this.snapT = -1;
    this.tearT = -1;
    const u = this.uniforms;
    u.uPull.value.set(0, 0, 0);
    u.uPeel.value = -1;
    u.uPeelSide.value = 0;
    u.uExpr.value = 0;
    u.uTension.value = 0;
    u.uGrab.value.set(0, 99, 0);
    u.uRollBack.value = 0;
    u.uHeadPull.value.set(0, 0, 0);
    u.uHeadRot.value.set(0, 0, 0);
    u.uShake.value = 0;
    u.uTornSide.value = 0;
    u.uTornTime.value = 0;
    u.uWiden.value = 0;
    this.pivot.visible = false;
    for (const shell of this.shells) shell.visible = false;
    this.dust.visible = false;
    this.applyExpression(0);
    this.mesh.visible = true;
    this.notify();
  }
  frontAt(x, z) {
    if (isDust(this.uniforms.uPeelSide.value))
      return this.uniforms.uPeel.value > 0.5 ? -99 : 99;
    return peelFrontJS(
      Math.atan2(x, z),
      this.uniforms.uPeel.value,
      this.uniforms.uPeelSide.value,
    );
  }
  applyExpression(p) {
    const w = expressionWeights(p);
    for (const mesh of [this.skin, this.mouth]) {
      const dict = mesh.morphTargetDictionary,
        inf = mesh.morphTargetInfluences;
      for (const name in w)
        if (dict[name] !== undefined) inf[dict[name]] = w[name];
    }
  }
  update(dt) {
    this.elapsed += dt;
    let active = false;
    const u = this.uniforms;
    u.uTime.value = this.elapsed;
    // the shown pull eases toward the real one, so the animation never jumps
    const target = this.phase === "pulling" || this.peeling ? this.progress : 0;
    const before = this.shown;
    this.shown +=
      (target - this.shown) *
      (1 - Math.exp(-dt * (target > this.shown ? 12 : 6)));
    if (Math.abs(this.shown - target) < 0.0005) this.shown = target;
    const p = this.shown;
    if (p !== before || this.phase === "pulling") active = true;
    // after the rip the head springs back to its rest pose with a small wobble
    let pose = 1;
    if (this.snapT >= 0) {
      this.snapT += dt;
      pose =
        this.snapT > 0.7
          ? 0
          : Math.exp(-this.snapT * 12) *
            Math.cos((this.snapT * 2 * Math.PI) / 0.3);
    }
    const side = this.side,
      down = side === 2,
      up = side === 3,
      vert = down || up,
      e = smooth(p * 1.15);
    // fixed, designed path for the grabbed point
    if (side) {
      const reach = GRAB.reach(side) * (1 - Math.pow(1 - p, 2.2));
      u.uPull.value.copy(GRAB.dir(side)).multiplyScalar(reach * pose);
      u.uHeadPull.value
        .copy(GRAB.dir(side))
        .multiplyScalar((down ? 0.04 : up ? 0.05 : 0.045) * smooth(p) * pose);
    } else {
      u.uPull.value.set(0, 0, 0);
      u.uHeadPull.value.set(0, 0, 0);
    }
    u.uTension.value = p;
    u.uExpr.value = e;
    // pulled sideways the head turns and rolls with the pull; pulled down it bows forward
    u.uHeadRot.value.set(
      (down ? 0.24 : up ? -0.26 : -0.06) * e * pose,
      (side && !vert ? side * 0.11 : 0) * e * pose,
      (side && !vert ? -side * 0.07 : 0) * e * pose,
    );
    u.uShake.value = e * e * Math.max(pose, this.snapT >= 0 ? 0 : 1);
    // eyes dart toward the hand with panicked jumps, then roll back right before the break
    const jitter =
      p > 0.15
        ? Math.sin(this.elapsed * 13.0) *
          Math.sin(this.elapsed * 7.3) *
          0.12 *
          p
        : 0;
    const lookX = vert ? 0 : side ? side * 0.38 : 0,
      lookY = down ? 0.1 : up ? -0.22 : 0.06;
    u.uLook.value.set(
      lookX * smooth(p * 2) + jitter,
      lookY * smooth(p * 2) + jitter * 0.5,
    );
    u.uRollBack.value = band(p, 0.8, 0.97);
    if (this.snapT >= 0 && this.snapT < 0.7) active = true;
    this.applyExpression(p);
    if (this.phase === "recoiling" && p < 0.002) {
      this.shown = 0;
      u.uPull.value.set(0, 0, 0);
      u.uExpr.value = 0;
      this.side = 0;
      this.applyExpression(0);
      u.uRollBack.value = 0;
      this.phase = "covered";
      this.notify();
    }
    if (this.pivot.visible) {
      // the torn piece drops, tumbling, and breaks apart as it falls
      const t = (this.pieceT += dt),
        pu = this.pieceUniforms;
      const offset = this.pieceDir
        .clone()
        .multiplyScalar(0.12 * (1 - Math.exp(-t * 6)));
      if (this.side === 3) {
        offset.y += 1.5 * t - 2.6 * t * t;
        offset.z -= 0.55 * t;
      } // yanked up and over, behind the head
      else {
        offset.y -= 2.6 * t * t;
        offset.z += 0.25 * t;
      }
      this.pivot.position
        .copy(GRAB.point(this.side || 1))
        .add(pu.uPull.value)
        .add(offset);
      this.pivot.setRotationFromAxisAngle(
        this.pieceAxis,
        (this.side === 3 ? 3.4 : -2.4) * t,
      );
      pu.uPieceFade.value = smooth((t - 0.45) / 1.0);
      if (t > 1.6) this.pivot.visible = false;
      active = true;
    }
    if (this.peeling) {
      this.tearT += dt;
      u.uTornTime.value = this.tearT;
      if (u.uTornSide.value === 3) u.uWiden.value = smooth(this.tearT / 0.3);
      if (this.tearT >= this.peelDelay)
        u.uPeel.value =
          Math.max(u.uPeel.value, 0) + (this.reducedMotion ? dt * 4 : dt);
      this.dust.visible = isDust(u.uPeelSide.value) && u.uPeel.value >= 0;
      if (this.dust.visible)
        this.dust.material.uniforms.uScale.value =
          this.canvas.height /
          (2 * Math.tan((this.camera.fov * Math.PI) / 360));
      active = true;
      if (u.uPeel.value >= PEEL_DONE) {
        this.mesh.visible = false;
        this.pivot.visible = false;
        this.dust.visible = false;
        this.revealed = true;
        this.phase = "explore";
        this.notify();
      }
    }
    return active;
  }
}
