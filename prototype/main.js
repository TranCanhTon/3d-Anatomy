import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mats, prep, maskUniforms } from '../muscle-materials.js';
import { Rig } from './rig.js';
import { EXERCISES, EQUIPMENT_EFFORT } from './exercises.js';
import { HAND_POSES, repProgress } from './hand-poses.js';
import { MuscleTracker } from './effort.js';
import { ClipPlayer, recordClip } from './clip.js';
import { Xray } from './xray.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setClearColor(0, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, .05, 50);
camera.position.set(1.35, 1.45, 3.6);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.12, 0); controls.enableDamping = true; controls.enablePan = false;
controls.minDistance = .8; controls.maxDistance = 6; controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d2cf, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(1.5, 3, 4); scene.add(key);
const fill = new THREE.DirectionalLight(0xfff1ea, .9); fill.position.set(-3, 1, -2.5); scene.add(fill);
const rim = new THREE.DirectionalLight(0xfff0e6, 1.6); rim.position.set(.4, 2.2, -4); scene.add(rim);
maskUniforms.uMaskOn.value = 0; // no skin on this page

// soft contact shadow under the feet
{
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 64); g.addColorStop(0, 'rgba(20,18,16,.55)'); g.addColorStop(1, 'rgba(20,18,16,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(.9, .55), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = .001; scene.add(m);
}

// Dumbbell: grey clay so the muscles stay the only colour on screen.
function dumbbell() {
  const g = new THREE.Group();
  const clay = new THREE.MeshStandardMaterial({ color: '#9b968f', roughness: .62, metalness: .05 });
  const grip = new THREE.MeshStandardMaterial({ color: '#6c6863', roughness: .8, metalness: .05 });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(.0135, .0135, .15, 20), grip); handle.rotation.z = Math.PI / 2; g.add(handle);
  for (const s of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.CylinderGeometry(.046, .046, .055, 6), clay);
    head.rotation.z = Math.PI / 2; head.position.x = s * .1; g.add(head);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(.022, .022, .012, 20), clay);
    collar.rotation.z = Math.PI / 2; collar.position.x = s * .069; g.add(collar);
  }
  return g;
}

let rig, tracker, xray, motion = null, effort = {}, current = 'curl', time = 0, paused = false, speed = 1, fixedTime = null;
const clipCache = {}, dumbbells = [];

// Pull up bar: fixed in the room; its position comes from the clip (where the hands grip).
const bar = new THREE.Group(); bar.visible = false; scene.add(bar);
{
  const clay = new THREE.MeshStandardMaterial({ color: '#9b968f', roughness: .62, metalness: .05 });
  const steel = new THREE.MeshStandardMaterial({ color: '#7a7671', roughness: .45, metalness: .3 });
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(.016, .016, 1.3, 20), steel); rod.rotation.z = Math.PI / 2; bar.add(rod);
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(.06, 1, .06), clay); post.name = 'post'; post.position.x = s * .62; bar.add(post);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(.08, .03, .7), clay); foot.name = 'foot'; foot.position.x = s * .62; bar.add(foot);
  }
}
// Barbell: follows the hands every frame (it sits on both grip points). Bench: placed from the clip.
const barbell = new THREE.Group(), bench = new THREE.Group(); barbell.visible = bench.visible = false; scene.add(barbell, bench);
{
  const clay = new THREE.MeshStandardMaterial({ color: '#9b968f', roughness: .62, metalness: .05 });
  const steel = new THREE.MeshStandardMaterial({ color: '#7a7671', roughness: .45, metalness: .3 });
  const along = (m) => { m.rotation.z = Math.PI / 2; return m; };
  barbell.add(along(new THREE.Mesh(new THREE.CylinderGeometry(.014, .014, 1.9, 20), steel)));
  for (const s of [-1, 1]) {
    const sleeve = along(new THREE.Mesh(new THREE.CylinderGeometry(.025, .025, .38, 20), steel)); sleeve.position.x = s * .76; barbell.add(sleeve);
    const collar = along(new THREE.Mesh(new THREE.CylinderGeometry(.04, .04, .03, 20), steel)); collar.position.x = s * .585; barbell.add(collar);
    for (const [r, x] of [[.225, .63], [.225, .67], [.16, .705]]) { const plate = along(new THREE.Mesh(new THREE.CylinderGeometry(r, r, .032, 40), clay)); plate.position.x = s * x; barbell.add(plate); }
  }
  const pad = new THREE.Mesh(new THREE.BoxGeometry(.3, .06, 1), new THREE.MeshStandardMaterial({ color: '#6c6863', roughness: .85 })); pad.name = 'pad'; bench.add(pad);
  for (const z of [-.42, .42]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(.26, 1, .06), clay); leg.name = 'leg'; leg.position.z = z; bench.add(leg); }
}
const _ga = new THREE.Vector3(), _gb = new THREE.Vector3();
function placeBarbell() {
  if (!barbell.visible) return;
  dumbbells[0].getWorldPosition(_ga); dumbbells[1].getWorldPosition(_gb); // grip points in the palms
  barbell.position.copy(_ga).add(_gb).multiplyScalar(.5);
  barbell.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), _ga.sub(_gb).normalize());
}
function placeEquipment(clip, type) {
  dumbbells.forEach((d) => { d.visible = type === 'dumbbells'; });
  barbell.visible = type === 'barbell';
  const b = clip?.equipment?.bench; bench.visible = !!b;
  if (b) { // pad on top, legs down to the floor
    bench.position.set(b.at[0], 0, b.at[2]);
    bench.children.forEach((c) => {
      if (c.name === 'pad') { c.scale.z = b.length; c.position.y = b.at[1] - .03; }
      if (c.name === 'leg') { c.scale.y = b.at[1] - .06; c.position.y = (b.at[1] - .06) / 2; c.position.z = Math.sign(c.position.z) * (b.length / 2 - .1); }
    });
  }
  bar.visible = type === 'bar' && !!clip?.equipment;
  if (bar.visible) {
    const [x, y, z] = clip.equipment.at; bar.position.set(x, y, z);
    // posts run from the floor up to the bar
    bar.children.forEach((c) => { if (c.name === 'post') { c.scale.y = y + .08; c.position.y = -(y + .08) / 2 + .08; } if (c.name === 'foot') c.position.y = -y + .015; });
  }
  // frame the camera for hanging exercises
  if (type === 'bar') { camera.position.set(1.6, 1.75, 4.4); controls.target.set(0, 1.45, 0); }
  else if (b) { camera.position.set(b.at[0] + 2.7, 1.55, b.at[2] + 2.2); controls.target.set(b.at[0], .62, b.at[2] + .2); } // lying on a bench
  else if (clip?.bones.includes('thigh_L')) { camera.position.set(1.8, 1.35, 4.6); controls.target.set(0, .82, 0); } // whole body moves
  else { camera.position.set(1.35, 1.45, 3.6); controls.target.set(0, 1.12, 0); }
  controls.update();
}
const bodyGroup = new THREE.Group(); scene.add(bodyGroup);

async function loadGLB(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status);
  const { glb } = await r.json(); const s = atob(glb), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return new Promise((res, rej) => new GLTFLoader().parse(b.buffer, '', (g) => res(g.scene), rej));
}

// highlight and bulge live in the shared muscle shader (../muscle-materials.js)

Promise.all([loadGLB('../muscles.json'), fetch('rig.json').then((r) => r.json()), fetch('rig.bin').then((r) => r.arrayBuffer())])
  .then(([muscles, data, bin]) => {
    rig = new Rig(data, bin);
    bodyGroup.add(rig.root);
    const meshes = []; muscles.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const debug = new URLSearchParams(location.search).get('debug');
    for (const o of meshes) {
      prep(o); const sm = rig.skin(o); if (!sm) continue;
      if (debug === 'weights') debugWeights(sm);
      if (debug === 'nobones' && sm.userData.kind === 'bones') continue;
      bodyGroup.add(sm);
    }
    // dumbbells ride on the hand bones; the grip point is in the hand's rest frame
    for (const s of ['L', 'R']) {
      const d = dumbbell(), sign = s === 'L' ? 1 : -1;
      const grip = new THREE.Vector3(sign * .279, .787, .056).sub(rig.pivot['hand_' + s]);
      d.position.copy(grip);
      const ax = rig.h0.clone(); if (s === 'R') ax.x *= -1;
      d.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), ax.multiplyScalar(sign));
      rig.bones['hand_' + s].add(d); dumbbells.push(d);
    }
    tracker = new MuscleTracker(rig);
    xray = new Xray(scene, rig, tracker, mats);
    const rec = new URLSearchParams(location.search).get('record');
    if (rec) downloadClip(rec);
    $('load').hidden = true; setExercise(current).then(() => { window.proto.ready = true; });
  })
  .catch((e) => { $('load-text').textContent = 'Could not load. Run a local server in the project folder.'; console.error(e); });

// colour each vertex by the bones it follows (debug view: ?debug=weights)
function debugWeights(sm) {
  const g = sm.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, n = si.count;
  const col = new Float32Array(n * 3), c = new THREE.Color(), acc = new THREE.Color();
  const pal = (i) => c.setHSL(((i * 0.618034) % 1), .75, .5);
  for (let v = 0; v < n; v++) {
    acc.setRGB(0, 0, 0);
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(v, k); if (w > 0) { pal(si.getComponent(v, k)); acc.r += c.r * w; acc.g += c.g * w; acc.b += c.b * w; } }
    col.set([acc.r, acc.g, acc.b], v * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  sm.material = new THREE.MeshLambertMaterial({ vertexColors: true });
}

// A motion is anything that can pose the skeleton at time t: a recorded clip, or a hand
// written pose played live. Both report rep progress k and whether the weight is going up.
function poseMotion(ex) {
  const T = ex.rep.up + ex.rep.hold + ex.rep.down + ex.rep.rest, n = 16;
  return {
    duration: T,
    apply(t) { const p = repProgress(t, ex.rep); rig.reset(); rig.arms(ex.pose(p.k)); rig.apply(); return p; },
    liftCount: n,
    liftPose(i) { rig.reset(); rig.arms(ex.pose(i / (n - 1))); rig.apply(); },
  };
}
function clipMotion(clip) {
  const player = new ClipPlayer(clip, rig), frames = player.liftFrames();
  return { duration: player.duration, apply: (t) => player.apply(t), liftCount: frames.length, liftPose: (i) => player.applyFrame(frames[i]) };
}
async function loadMotion(ex) {
  if (!ex.clip) return poseMotion(ex);
  clipCache[ex.clip] ??= await fetch(ex.clip).then((r) => { if (!r.ok) throw new Error(ex.clip + ' ' + r.status); return r.json(); });
  return clipMotion(clipCache[ex.clip]);
}

async function setExercise(name) {
  current = name; time = 0;
  document.querySelectorAll('[data-ex]').forEach((b) => b.classList.toggle('on', b.dataset.ex === name));
  const ex = EXERCISES[name];
  motion = await loadMotion(ex);
  placeEquipment(ex.clip ? clipCache[ex.clip] : null, ex.equipment);
  // play through the lift once: the listed muscles work, the motion picks the hardest working parts
  effort = tracker.analyze(motion.liftCount, motion.liftPose, { ...EQUIPMENT_EFFORT[ex.equipment], ...ex.extraEffort }, ex);
  const ranked = Object.entries(effort).sort((a, b) => b[1] - a[1]);
  $('name').textContent = ranked.length ? bigLabel(ranked[0][0]) : '';
  $('ex-title').textContent = ex.title;
  $('working').innerHTML = ranked.slice(0, 4).map(([k, v]) => `<li><span style="--w:${v}"></span>${label(k)}</li>`).join('');
  update(0);
}
// muscles.json has the upper and lower traps labels swapped; show the real names
const NAMES = { 'traps/lower': 'Upper traps', 'traps/upper': 'Lower traps' };
function label(k) {
  if (NAMES[k]) return NAMES[k];
  const [g, p] = k.split('/'); const n = (s) => s.replace(/_/g, ' ');
  return p === g ? n(g) : p === 'brachialis' ? 'brachialis' : n(p) + ' ' + n(g);
}
const bigLabel = (k) => k.split('/')[0].replace(/_/g, ' ').toUpperCase();

function update(dt) {
  if (!rig || !motion) return;
  if (!paused && fixedTime === null) time += dt * speed;
  const { k, lifting } = motion.apply(fixedTime ?? time);
  placeBarbell();
  tracker.update();
  mats.forEach((m, key) => {
    const e = effort[key] || 0;
    const work = e * (lifting ? .45 + .55 * Math.sin(Math.PI * Math.min(1, k * 1.15)) : .3 + .25 * k);
    m.userData.uHi.value = Math.min(1, work * 1.05); // teal blend, pulsing with the rep
    if (m.userData.uBulge) m.userData.uBulge.value = e ? tracker.bulge(key) : tracker.bulge(key) * .35;
  });
  $('bar').style.transform = `scaleX(${k})`;
  xray.update();
  if (xray.mode !== 'off' && (fixedTime !== null || performance.now() - lastPanel > 120)) { lastPanel = performance.now(); drawPanel(); }
}

// X-ray side panel: every muscle whose length changed right now. Hover a row to highlight its line.
let lastPanel = 0;
function drawPanel() {
  const rows = xray.rows().slice(0, 14);
  $('xray-rows').innerHTML = rows.map(({ key, change }) => {
    const pct = (change * 100).toFixed(1), w = Math.min(1, Math.abs(change) / .3);
    return `<li data-key="${key}" class="${change < 0 ? 'short' : 'long'}${effort[key] ? ' work' : ''}${xray.focus === key ? ' focus' : ''}">
      <span class="n">${label(key)}</span><span class="b"><i style="--w:${w}"></i></span><span class="v">${change < 0 ? '' : '+'}${pct}%</span></li>`;
  }).join('') || '<li class="empty">No muscle has changed length</li>';
}
$('xray-rows').addEventListener('mouseover', (e) => { const li = e.target.closest('li[data-key]'); xray.focus = li ? li.dataset.key : null; });
$('xray-rows').addEventListener('mouseleave', () => { xray.focus = null; });
const XRAY_MODES = ['off', 'bones', 'lines', 'both'], XRAY_TEXT = { off: 'X-ray: off', bones: 'X-ray: bones', lines: 'X-ray: muscle lines', both: 'X-ray: both' };
function setXray(mode) {
  xray.setMode(mode); $('xray').textContent = XRAY_TEXT[mode];
  $('xray-panel').hidden = !(mode === 'lines' || mode === 'both'); document.body.classList.toggle('xray', mode !== 'off');
  if (mode !== 'off') { xray.update(); drawPanel(); }
}

// ?record=curl turns a hand written pose from hand-poses.js into a clip file and downloads it
function downloadClip(name) {
  const clip = recordClip(name, HAND_POSES[name], rig, repProgress);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(clip)], { type: 'application/json' }));
  a.download = name + '.json'; document.body.append(a); a.click(); a.remove();
  window.proto.lastClip = clip;
}

function resize() {
  const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();
let prev = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(.05, (now - prev) / 1000); prev = now;
  update(dt); controls.update(); renderer.render(scene, camera);
});

document.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => setExercise(b.dataset.ex)));
$('pause').addEventListener('click', () => { paused = !paused; $('pause').textContent = paused ? 'Play' : 'Pause'; });
$('xray').addEventListener('click', () => setXray(XRAY_MODES[(XRAY_MODES.indexOf(xray.mode) + 1) % XRAY_MODES.length]));
$('slow').addEventListener('click', () => { speed = speed === 1 ? .3 : 1; $('slow').textContent = speed === 1 ? 'Slow motion' : 'Normal speed'; });

// test hooks
window.proto = {
  ready: false,
  async set(name) { await setExercise(name); },
  at(t) { fixedTime = t; update(0); controls.update(); renderer.render(scene, camera); },
  record: (name) => recordClip(name, HAND_POSES[name], rig, repProgress),
  get effort() { return effort; }, get raw() { return tracker.raw; },
  bulge: (key) => tracker.bulge(key),
  xray: (mode) => setXray(mode),
  view(pos, target) { camera.position.set(...pos); controls.target.set(...target); controls.update(); },
  live() { fixedTime = null; },
  get rig() { return rig; },
  get meshes() { return bodyGroup.children.filter((o) => o.isSkinnedMesh); },
};
