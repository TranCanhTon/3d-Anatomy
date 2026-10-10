import * as THREE from 'three';
import { createStage, loadBody } from './stage.js';
import { MuscleTracker } from './effort.js';
import { ClipPlayer, recordFrames } from './clip.js';

// Pose editor. You drag hand and elbow handles to pose the arms at a few moments
// (keyframes); the editor fills in the motion between them, plays it, shows which muscles
// work, and saves a clip in the same format the viewer plays.

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180, FPS = 30;
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const arr = (v) => [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
const flipX = (a) => [-a[0], a[1], a[2]];
const ease = (u) => u * u * (3 - 2 * u);
// palm directions for the left arm; the right arm uses the mirror image
const PALMS = { forward: [0, 0, 1], back: [0, 0, -1], in: [-1, 0, 0], out: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };

const { scene, camera, controls, renderer, mats } = createStage($('c'));
let rig, tracker, effort = {};

// ---------------------------------------------------------------------------
// Editor state.
// A keyframe is { t, L, R } where each arm is
//   { wrist: [x,y,z] where the wrist should be,
//     pole: [x,y,z] direction from shoulder to elbow (where the elbow points),
//     palm: 'forward' | ... | [x,y,z] | null (automatic),
//     wristFlex: degrees, grip: 0 open to 1 closed }
// ---------------------------------------------------------------------------
const S = { duration: 3, lift: [0, 1.2], keys: [], time: 0, playing: false, side: 'L', mirror: true };

function restArm(side) {
  const p = rig.pivot, s = '_' + side;
  return { wrist: arr(p['hand' + s]), pole: arr(p['forearm' + s].clone().sub(p['upperarm' + s])), palm: null, wristFlex: 0, grip: 1 };
}
const copyArm = (a) => ({ ...a, wrist: [...a.wrist], pole: [...a.pole], palm: Array.isArray(a.palm) ? [...a.palm] : a.palm });
const mirrorArm = (a) => ({ ...copyArm(a), wrist: flipX(a.wrist), pole: flipX(a.pole), palm: Array.isArray(a.palm) ? flipX(a.palm) : a.palm });

function palmVec(arm, side) {
  if (!arm.palm) return null;
  if (Array.isArray(arm.palm)) return V(arm.palm);
  const p = PALMS[arm.palm]; return V(side === 'R' ? flipX(p) : p);
}

function lerpArm(a, b, e, side) {
  const L = (x, y) => x + (y - x) * e, L3 = (x, y) => x.map((v, i) => +L(v, y[i]).toFixed(4));
  const pa = palmVec(a, side), pb = palmVec(b, side);
  let palm = null;
  if (pa && pb) palm = arr(pa.lerp(pb, e).normalize()); else if (pa || pb) palm = arr(pa || pb);
  if (a.palm === b.palm && !Array.isArray(a.palm)) palm = a.palm; // same named direction stays a name
  return { wrist: L3(a.wrist, b.wrist), pole: L3(a.pole, b.pole), palm, wristFlex: L(a.wristFlex, b.wristFlex), grip: L(a.grip, b.grip) };
}

// The pose at time t: blend between the keyframes around it (the motion loops, so after the
// last keyframe it blends back to the first).
function poseAt(t) {
  const K = S.keys;
  if (!K.length) return { L: restArm('L'), R: restArm('R') };
  if (K.length === 1) return { L: copyArm(K[0].L), R: copyArm(K[0].R) };
  let a, b, u;
  const i = K.findIndex((k) => k.t > t);
  if (i > 0) { a = K[i - 1]; b = K[i]; u = (t - a.t) / (b.t - a.t); }
  else { a = K[K.length - 1]; b = K[0]; const span = S.duration - a.t + b.t; u = span > 0 ? ((t - a.t + S.duration) % S.duration) / span : 0; }
  const e = ease(THREE.MathUtils.clamp(u, 0, 1));
  return { L: lerpArm(a.L, b.L, e, 'L'), R: lerpArm(a.R, b.R, e, 'R') };
}

function armToRig(arm, side) {
  const palm = palmVec(arm, side);
  return { wrist: V(arm.wrist), pole: V(arm.pole), palm: palm || undefined, wristFlex: arm.wristFlex * DEG, grip: arm.grip };
}
function applyPose(p) { rig.reset(); rig.arms({ ...armToRig(p.L, 'L'), right: armToRig(p.R, 'R') }); rig.apply(); }

// Where in the rep time t is: inside the lift k runs 0 to 1, afterwards it runs back to 0.
function repAt(t) {
  const [a, b] = S.lift, D = S.duration;
  if (t >= a && t <= b) return { k: b > a ? (t - a) / (b - a) : 1, lifting: true };
  const back = ((t - b + D) % D) / (((a - b + D) % D) || D);
  return { k: 1 - back, lifting: false };
}

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------
const sortKeys = () => S.keys.sort((a, b) => a.t - b.t);
const keyAtPlayhead = () => S.keys.findIndex((k) => Math.abs(k.t - S.time) < .5 / FPS);
function ensureKey() {
  let i = keyAtPlayhead();
  if (i < 0) { const p = poseAt(S.time); S.keys.push({ t: +S.time.toFixed(3), L: p.L, R: p.R }); sortKeys(); i = keyAtPlayhead(); }
  return S.keys[i];
}
// change one arm of the keyframe at the playhead (and mirror it to the other arm if mirroring)
function editArm(side, change) {
  const key = ensureKey(); change(key[side]);
  if (S.mirror) key[side === 'L' ? 'R' : 'L'] = mirrorArm(key[side]);
  changed();
}
function changed() { drawTimeline(); syncPanel(); scheduleEffort(); }

// ---------------------------------------------------------------------------
// Handles: dots on the hands and elbows you can drag
// ---------------------------------------------------------------------------
const handles = new THREE.Group(); scene.add(handles);
const HANDLE = { hand: { r: .026, color: '#ffd27a', bone: 'hand_' }, elbow: { r: .021, color: '#5aa9ff', bone: 'forearm_' } };
for (const side of ['L', 'R']) for (const kind of ['hand', 'elbow']) {
  const h = HANDLE[kind];
  const m = new THREE.Mesh(new THREE.SphereGeometry(h.r, 18, 14), new THREE.MeshBasicMaterial({ color: h.color, depthTest: false, transparent: true, opacity: .95 }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(h.r * 1.25, h.r * 1.5, 32), new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true, opacity: .9, side: THREE.DoubleSide }));
  m.add(ring); m.renderOrder = ring.renderOrder = 20; m.userData = { side, kind, ring }; handles.add(m);
}
function placeHandles() {
  for (const m of handles.children) {
    rig.bones[HANDLE[m.userData.kind].bone + m.userData.side].getWorldPosition(m.position);
    const sel = m.userData.side === S.side;
    m.scale.setScalar(sel ? 1 : .8); m.material.opacity = sel ? .95 : .55;
    m.userData.ring.visible = sel; m.userData.ring.quaternion.copy(camera.quaternion);
  }
}

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(), hitPoint = new THREE.Vector3();
let drag = null;
function setRay(e) { const r = renderer.domElement.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); }
function handleUnder(e) { setRay(e); return ray.intersectObjects(handles.children, false)[0]?.object || null; }

// move a handle to a point in the world
function dragTo(side, kind, point) {
  editArm(side, (arm) => {
    if (kind === 'hand') arm.wrist = arr(point);
    else { const sh = rig.bones['upperarm_' + side].getWorldPosition(new THREE.Vector3()); arm.pole = arr(point.clone().sub(sh)); }
  });
}

const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  if (!rig || e.button !== 0) return;
  const h = handleUnder(e); if (!h) return;
  pause(); selectSide(h.userData.side);
  drag = { side: h.userData.side, kind: h.userData.kind };
  plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), h.position);
  controls.enabled = false; canvas.setPointerCapture(e.pointerId); canvas.classList.add('drag');
});
canvas.addEventListener('pointermove', (e) => {
  if (!rig) return;
  if (drag) { setRay(e); if (ray.ray.intersectPlane(plane, hitPoint)) dragTo(drag.side, drag.kind, hitPoint); return; }
  canvas.classList.toggle('over', !!handleUnder(e));
});
const endDrag = () => { if (!drag) return; drag = null; controls.enabled = true; canvas.classList.remove('drag'); };
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------------------
// Side panel: palm, wrist, grip for the selected arm, and the working muscles
// ---------------------------------------------------------------------------
function selectSide(side) {
  S.side = side; $('side-title').textContent = side === 'L' ? 'Left arm' : 'Right arm';
  $('pickL').classList.toggle('on', side === 'L'); $('pickR').classList.toggle('on', side === 'R'); syncPanel();
}
function syncPanel() {
  if (!rig) return;
  const arm = poseAt(S.time)[S.side];
  $('palm').value = typeof arm.palm === 'string' ? arm.palm : Array.isArray(arm.palm) ? 'custom' : '';
  $('wrist').value = Math.round(arm.wristFlex); $('wrist-v').textContent = Math.round(arm.wristFlex) + '°';
  $('grip').value = arm.grip; $('grip-v').textContent = (+arm.grip).toFixed(2);
}
$('pickL').onclick = () => selectSide('L'); $('pickR').onclick = () => selectSide('R');
$('palm').onchange = () => editArm(S.side, (a) => { a.palm = $('palm').value || null; });
$('wrist').oninput = () => editArm(S.side, (a) => { a.wristFlex = +$('wrist').value; });
$('grip').oninput = () => editArm(S.side, (a) => { a.grip = +$('grip').value; });
$('mirror').onclick = () => { S.mirror = !S.mirror; $('mirror').classList.toggle('on', S.mirror); $('mirror').textContent = 'Mirror arms: ' + (S.mirror ? 'on' : 'off'); };

// which muscles shorten during the lift (same automatic effort as the viewer)
const NAMES = { 'traps/lower': 'Upper traps', 'traps/upper': 'Lower traps' };
const label = (k) => NAMES[k] || (([g, p]) => (p === g ? g : p === 'brachialis' ? 'brachialis' : p + ' ' + g).replace(/_/g, ' '))(k.split('/'));
let effortTimer = 0;
function scheduleEffort() { clearTimeout(effortTimer); effortTimer = setTimeout(computeEffort, 150); }
function computeEffort() {
  const [a, b] = S.lift, n = 16, grip = Math.max(poseAt(a).L.grip, poseAt(b).L.grip);
  effort = tracker.analyze(n, (i) => applyPose(poseAt(a + (b - a) * i / (n - 1))), grip > .5 ? { 'forearms/flexors': .3 } : {});
  const ranked = Object.entries(effort).sort((x, y) => y[1] - x[1]).slice(0, 6);
  $('working').innerHTML = ranked.length ? ranked.map(([k, v]) => `<li><i style="--w:${v}"></i>${label(k)}</li>`).join('')
    : '<li class="none">Nothing shortens in the lift yet</li>';
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
const track = $('track');
const tx = (t) => (t / S.duration * 100) + '%';
function drawTimeline() {
  const D = S.duration;
  $('ticks').innerHTML = Array.from({ length: Math.floor(D / .5) + 1 }, (_, i) => `<span style="left:${tx(i * .5)}">${(i * .5).toFixed(1)}</span>`).join('');
  $('lift').style.left = tx(S.lift[0]); $('lift').style.width = ((S.lift[1] - S.lift[0]) / D * 100) + '%';
  const sel = keyAtPlayhead();
  $('keys').innerHTML = S.keys.map((k, i) => `<div class="key${i === sel ? ' sel' : ''}" data-i="${i}" style="left:${tx(k.t)}" title="${k.t.toFixed(2)} s"></div>`).join('');
  $('playhead').style.left = tx(S.time);
  $('time').textContent = S.time.toFixed(2) + ' s / ' + D.toFixed(1) + ' s';
  $('delkey').disabled = sel < 0;
}
const timeFromX = (x) => { const r = track.getBoundingClientRect(); return THREE.MathUtils.clamp((x - r.left) / r.width, 0, .9999) * S.duration; };
const snap = (t) => Math.round(t * FPS) / FPS;
let scrub = null;
track.addEventListener('pointerdown', (e) => {
  pause(); track.setPointerCapture(e.pointerId);
  const key = e.target.closest('.key');
  scrub = key ? { key: S.keys[+key.dataset.i] } : {};
  if (scrub.key) S.time = scrub.key.t; else S.time = snap(timeFromX(e.clientX));
  drawTimeline(); syncPanel();
});
track.addEventListener('pointermove', (e) => {
  if (!scrub) return;
  const t = snap(timeFromX(e.clientX));
  if (scrub.key) { scrub.key.t = t; sortKeys(); scheduleEffort(); }
  S.time = t; drawTimeline(); syncPanel();
});
track.addEventListener('pointerup', () => { scrub = null; });

function pause() { S.playing = false; $('play').textContent = 'Play'; }
$('play').onclick = () => { S.playing = !S.playing; $('play').textContent = S.playing ? 'Pause' : 'Play'; };
$('addkey').onclick = () => { pause(); ensureKey(); changed(); };
$('delkey').onclick = () => { const i = keyAtPlayhead(); if (i >= 0) { S.keys.splice(i, 1); changed(); } };
$('liftstart').onclick = () => { S.lift[0] = Math.min(S.time, S.lift[1] - .1); changed(); };
$('liftend').onclick = () => { S.lift[1] = Math.max(S.time, S.lift[0] + .1); changed(); };
$('duration').onchange = () => {
  S.duration = THREE.MathUtils.clamp(+$('duration').value || 3, .5, 10); $('duration').value = S.duration;
  S.keys = S.keys.filter((k) => k.t < S.duration); S.lift = S.lift.map((t) => Math.min(t, S.duration - .05));
  S.time = Math.min(S.time, S.duration - 1 / FPS); changed();
};
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  if (e.key === 'k') $('addkey').click();
  if (e.key === 'Delete' || e.key === 'Backspace') $('delkey').click();
});

// ---------------------------------------------------------------------------
// New, open, save
// ---------------------------------------------------------------------------
function newClip() {
  Object.assign(S, { duration: 3, lift: [0, 1.2], time: 0, keys: [{ t: 0, L: restArm('L'), R: restArm('R') }] });
  $('name').value = 'new-exercise'; $('duration').value = 3; pause(); changed();
}

// Read the arm pose off the skeleton (used to turn a clip without editor data into keyframes).
function armFromRig(side) {
  const b = (n) => rig.bones[n + '_' + side], w = (n) => b(n).getWorldPosition(new THREE.Vector3());
  const n0 = rig.n0.clone(); if (side === 'R') n0.x *= -1;
  // only keep a palm direction if the forearm was actually twisted; otherwise leave it automatic
  const twisted = 2 * Math.acos(Math.min(1, Math.abs(b('twist').quaternion.w))) > 3 * DEG;
  const palm = twisted ? arr(n0.applyQuaternion(b('hand').getWorldQuaternion(new THREE.Quaternion())).normalize()) : null;
  const angle = (q, axis) => { const v = new THREE.Vector3(q.x, q.y, q.z), s = v.length(); return s < 1e-6 ? 0 : 2 * Math.atan2(s, q.w) * Math.sign(v.dot(axis)); };
  const h0 = side === 'L' ? rig.h0 : new THREE.Vector3(rig.h0.x, -rig.h0.y, -rig.h0.z);
  return {
    wrist: arr(w('hand')), pole: arr(w('forearm').sub(w('upperarm'))), palm,
    wristFlex: Math.round(-angle(b('hand').quaternion, h0) / DEG),
    grip: +THREE.MathUtils.clamp(-angle(b('fingers1').quaternion, h0) / (72 * DEG), 0, 1).toFixed(2),
  };
}
function clipToKeys(clip) {
  const player = new ClipPlayer(clip, rig), L = clip.lifting, P = clip.progress, n = clip.frames;
  const a = L.indexOf(1), b = L.lastIndexOf(1);
  let top = P.findIndex((p, i) => i >= a && p >= .995); if (top < 0) top = b;
  const back = P.findIndex((p, i) => i > b && p <= .002);
  const frames = [...new Set([a, top, b, back].filter((f) => f >= 0 && f < n))].sort((x, y) => x - y);
  const keys = frames.map((f) => { player.applyFrame(f); return { t: +(f / clip.fps).toFixed(3), L: armFromRig('L'), R: armFromRig('R') }; });
  return { duration: n / clip.fps, lift: [a / clip.fps, b / clip.fps], keys };
}
function openClip(clip) {
  const ed = clip.editor || clipToKeys(clip);
  Object.assign(S, { duration: ed.duration, lift: [...ed.lift], keys: ed.keys.map((k) => ({ t: k.t, L: copyArm(k.L), R: copyArm(k.R) })), time: 0 });
  $('name').value = clip.name || 'clip'; $('duration').value = +S.duration.toFixed(2); pause(); changed();
  toast(clip.editor ? `Opened <b>${clip.name}</b>.` : `Opened <b>${clip.name}</b>. It had no keyframes, so ${S.keys.length} were made from its motion.`);
}
$('new').onclick = newClip;
$('open').onchange = async () => {
  const v = $('open').value; $('open').value = '';
  if (v === 'file') return $('file').click();
  if (v) openClip(await fetch('clips/' + v + '.json').then((r) => r.json()));
};
$('file').onchange = async () => { const f = $('file').files[0]; if (f) openClip(JSON.parse(await f.text())); $('file').value = ''; };

function buildClip() {
  const name = ($('name').value || 'clip').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-');
  const clip = recordFrames(name, S.duration, rig, (t) => { applyPose(poseAt(t)); return repAt(t); }, FPS,
    { editor: { duration: S.duration, lift: [...S.lift], keys: S.keys } });
  return clip;
}
$('save').onclick = async () => {
  const clip = buildClip(), text = JSON.stringify(clip), file = clip.name + '.json';
  try {
    if (window.showSaveFilePicker) {
      const h = await showSaveFilePicker({ suggestedName: file, id: 'clips', types: [{ description: 'Clip', accept: { 'application/json': ['.json'] } }] });
      const w = await h.createWritable(); await w.write(text); await w.close();
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = file; a.click();
    }
  } catch (err) { if (err.name === 'AbortError') return; throw err; }
  toast(`Saved <b>${file}</b> (${Math.round(text.length / 1024)} KB). To show it in the viewer, add this line to exercises.js:<br>` +
    `<code>${clip.name}: { title: '${clip.name}', clip: 'clips/${file}', equipment: 'dumbbells' },</code>`, 9000);
};

let toastTimer = 0;
function toast(html, ms = 4000) { const t = $('toast'); t.innerHTML = html; t.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, ms); }

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const glow = new THREE.Color('#ff5b3a'), black = new THREE.Color(0);
let prev = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(.05, (now - prev) / 1000); prev = now;
  if (rig) {
    if (S.playing) { S.time = (S.time + dt) % S.duration; drawTimeline(); }
    applyPose(poseAt(S.time)); tracker.update(); placeHandles();
    const { k, lifting } = repAt(S.time);
    mats.forEach((m, key) => {
      const e = effort[key] || 0;
      m.emissive.copy(e ? glow : black); m.emissiveIntensity = e * (lifting ? .45 + .55 * Math.sin(Math.PI * Math.min(1, k * 1.15)) : .3 + .25 * k) * .55;
      if (m.userData.uBulge) m.userData.uBulge.value = tracker.bulge(key) * (e ? 1 : .35);
    });
  }
  controls.update(); renderer.render(scene, camera);
});

loadBody(scene).then(async (r) => {
  rig = r; tracker = new MuscleTracker(rig);
  openClip(await fetch('clips/curl.json').then((x) => x.json()));
  selectSide('L'); $('load').hidden = true; window.ed.ready = true;
}).catch((e) => { $('load').textContent = 'Could not load. Run a local server in the project folder.'; console.error(e); });

// test hooks
window.ed = {
  ready: false, S, poseAt, buildClip, openClip, newClip,
  at(t) { S.time = t; drawTimeline(); syncPanel(); applyPose(poseAt(t)); tracker.update(); placeHandles(); renderer.render(scene, camera); },
  drag: (side, kind, p) => dragTo(side, kind, V(p)),
  effortNow() { computeEffort(); return effort; },
  view(pos, target) { camera.position.set(...pos); controls.target.set(...target); controls.update(); },
};
