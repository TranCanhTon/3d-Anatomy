import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mats, prep, maskUniforms } from '../muscle-materials.js';
import { Rig } from './rig.js';

// Shared scene setup: renderer, camera, lights, floor shadow, the rigged muscle model and dumbbells.
// Used by the pose editor (the viewer in main.js has its own copy of the same setup).

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setClearColor(0, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, .05, 50);
  camera.position.set(1.2, 1.45, 3.4);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.15, 0); controls.enableDamping = true; controls.enablePan = false;
  controls.minDistance = .6; controls.maxDistance = 6; controls.update();

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d2cf, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(1.5, 3, 4); scene.add(key);
  const fill = new THREE.DirectionalLight(0xfff1ea, .9); fill.position.set(-3, 1, -2.5); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xfff0e6, 1.6); rim.position.set(.4, 2.2, -4); scene.add(rim);
  maskUniforms.uMaskOn.value = 0;

  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 64); g.addColorStop(0, 'rgba(20,18,16,.55)'); g.addColorStop(1, 'rgba(20,18,16,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(.9, .55), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = .001; scene.add(floor);

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas); resize();
  return { renderer, scene, camera, controls, mats };
}

async function loadGLB(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status);
  const { glb } = await r.json(); const s = atob(glb), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return new Promise((res, rej) => new GLTFLoader().parse(b.buffer, '', (gl) => res(gl.scene), rej));
}

// muscle swell on contraction (belly attribute from rig.bin)
function patch(m) {
  if (m.userData.patched) return; m.userData.patched = true;
  const base = m.onBeforeCompile; m.userData.uBulge = { value: 0 };
  m.onBeforeCompile = (s, r) => {
    base(s, r); s.uniforms.uBulge = m.userData.uBulge;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float belly; uniform float uBulge;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normal * belly * uBulge * 0.0065;');
  };
  m.customProgramCacheKey = () => 'muscle-proto-bulge-v1';
}

function dumbbell() {
  const g = new THREE.Group();
  const clay = new THREE.MeshStandardMaterial({ color: '#9b968f', roughness: .62, metalness: .05 });
  const grip = new THREE.MeshStandardMaterial({ color: '#6c6863', roughness: .8, metalness: .05 });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(.0135, .0135, .15, 20), grip); handle.rotation.z = Math.PI / 2; g.add(handle);
  for (const s of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.CylinderGeometry(.046, .046, .055, 6), clay); head.rotation.z = Math.PI / 2; head.position.x = s * .1; g.add(head);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(.022, .022, .012, 20), clay); collar.rotation.z = Math.PI / 2; collar.position.x = s * .069; g.add(collar);
  }
  return g;
}

// Load the muscles and rig, skin them, put dumbbells in the hands. Returns the Rig.
export async function loadBody(scene) {
  const [muscles, data, bin] = await Promise.all([loadGLB('../muscles.json'), fetch('rig.json').then((r) => r.json()), fetch('rig.bin').then((r) => r.arrayBuffer())]);
  const rig = new Rig(data, bin), body = new THREE.Group(); scene.add(body); body.add(rig.root);
  const meshes = []; muscles.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) { prep(o); patch(o.material); const sm = rig.skin(o); if (sm) body.add(sm); }
  for (const s of ['L', 'R']) {
    const d = dumbbell(), sign = s === 'L' ? 1 : -1;
    d.position.copy(new THREE.Vector3(sign * .279, .787, .056).sub(rig.pivot['hand_' + s]));
    const ax = rig.h0.clone(); if (s === 'R') ax.x *= -1;
    d.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), ax.multiplyScalar(sign));
    rig.bones['hand_' + s].add(d);
  }
  return rig;
}
