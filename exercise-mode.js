import * as THREE from 'three';
import { Rig } from './prototype/rig.js';
import { ClipPlayer } from './prototype/clip.js';
import { MuscleTracker } from './prototype/effort.js';
import { EXERCISES, EQUIPMENT_EFFORT } from './prototype/exercises.js';
import { Xray } from './prototype/xray.js';
import { mats } from './muscle-materials.js';

// Exercise mode for the front screen: the explore model itself does the exercise.
//
// The explore model is static. The first time an exercise opens, a skinned copy of every muscle is
// made with the rig from the prototype (same shapes, same materials, so swapping is invisible at
// rest). Opening blends the copy from its rest pose into the clip, dims the muscles that don't work,
// turns the working ones teal and fades the equipment in. Closing plays it backwards.

const BASE = './prototype/';
// which exercise a clicked muscle opens
export const MUSCLE_EXERCISE = {
  'biceps/long_head': 'curl', 'biceps/short_head': 'curl', 'biceps/brachialis': 'curl',
  'shoulders/front': 'press',
  'lats/lats': 'pullup',
  'chest/upper': 'bench', 'chest/middle': 'bench', 'chest/lower': 'bench',
};
// muscles.json swaps the trap labels; show the real names
const NAMES = { 'traps/lower': 'Upper traps', 'traps/upper': 'Lower traps' };
export function muscleLabel(k) {
  if (NAMES[k]) return NAMES[k];
  const [g, p] = k.split('/'), n = (s) => s.replace(/_/g, ' ');
  const t = p === g ? n(g) : p === 'brachialis' ? 'brachialis' : n(p) + ' ' + n(g);
  return t.replace(/^./, (c) => c.toUpperCase());
}

const IN = 1.1, OUT = .75; // seconds to blend into and out of the exercise
const smooth = (x) => { x = THREE.MathUtils.clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const ID = new THREE.Quaternion();

export class ExerciseMode {
  constructor({ scene, body, renderer, camera }) {
    this.scene = scene; this.body = body; this.renderer = renderer; this.camera = camera;
    this.active = false; this.phase = 'off'; this.speed = 1; this.paused = false; this.k = 0;
    this.clips = {};
  }

  // Build the skinned copy, the muscle tracker and the equipment (once).
  init() {
    this.ready ??= (async () => {
      const [data, bin] = await Promise.all([fetch(BASE + 'rig.json').then((r) => r.json()), fetch(BASE + 'rig.bin').then((r) => r.arrayBuffer())]);
      const rig = this.rig = new Rig(data, bin);
      this.group = new THREE.Group(); this.group.visible = false; this.group.add(rig.root); this.scene.add(this.group);
      this.body.updateMatrixWorld(true);
      this.body.traverse((o) => {
        if (!o.isMesh) return;
        const c = new THREE.Mesh(o.geometry.clone(), o.material); c.name = o.name; c.userData = o.userData;
        o.matrixWorld.decompose(c.position, c.quaternion, c.scale);
        const sm = rig.skin(c); if (sm) this.group.add(sm);
      });
      this.tracker = new MuscleTracker(rig);
      this.xray = new Xray(this.scene, rig, this.tracker, mats); // bones and muscle lines, see prototype README
      this.buildEquipment();
      // compile the skinned shaders now so the first exercise doesn't stutter
      [this.group, this.bar, this.barbell, this.bench, ...this.dumbbells].forEach((g) => { g.visible = true; });
      this.renderer?.compile(this.scene, this.camera);
      [this.group, this.bar, this.barbell, this.bench, ...this.dumbbells].forEach((g) => { g.visible = false; });
    })();
    return this.ready;
  }

  buildEquipment() {
    const rig = this.rig, fade = this.fadeMats = [];
    const mat = (o) => { const m = new THREE.MeshStandardMaterial({ roughness: .62, metalness: .05, transparent: true, opacity: 0, ...o }); fade.push(m); return m; };
    const clay = mat({ color: '#9b968f' }), grip = mat({ color: '#6c6863', roughness: .8 }), steel = mat({ color: '#7a7671', roughness: .45, metalness: .3 }), pad = mat({ color: '#6c6863', roughness: .85 });
    const along = (m) => { m.rotation.z = Math.PI / 2; return m; };
    const cyl = (r, h, m, seg = 20) => along(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m));
    // dumbbells ride on the hand bones at the grip point
    this.dumbbells = ['L', 'R'].map((s) => {
      const g = new THREE.Group(), sign = s === 'L' ? 1 : -1;
      g.add(cyl(.0135, .15, grip));
      for (const k of [-1, 1]) {
        const head = cyl(.046, .055, clay, 6); head.position.x = k * .1; g.add(head);
        const collar = cyl(.022, .012, clay); collar.position.x = k * .069; g.add(collar);
      }
      g.position.copy(new THREE.Vector3(sign * .279, .787, .056).sub(rig.pivot['hand_' + s]));
      const ax = rig.h0.clone(); if (s === 'R') ax.x *= -1;
      g.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), ax.multiplyScalar(sign));
      rig.bones['hand_' + s].add(g); return g;
    });
    // pull up bar, placed from the clip
    this.bar = new THREE.Group(); this.bar.add(cyl(.016, 1.3, steel));
    for (const k of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(.06, 1, .06), clay); post.name = 'post'; post.position.x = k * .62; this.bar.add(post);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(.08, .03, .7), clay); foot.name = 'foot'; foot.position.x = k * .62; this.bar.add(foot);
    }
    // barbell follows the grip points every frame
    this.barbell = new THREE.Group(); this.barbell.add(cyl(.014, 1.9, steel));
    for (const k of [-1, 1]) {
      const sleeve = cyl(.025, .38, steel); sleeve.position.x = k * .76; this.barbell.add(sleeve);
      const collar = cyl(.04, .03, steel); collar.position.x = k * .585; this.barbell.add(collar);
      for (const [r, x] of [[.225, .63], [.225, .67], [.16, .705]]) { const p = cyl(r, .032, clay, 40); p.position.x = k * x; this.barbell.add(p); }
    }
    // flat bench under the back
    this.bench = new THREE.Group();
    const top = new THREE.Mesh(new THREE.BoxGeometry(.3, .06, 1), pad); top.name = 'pad'; this.bench.add(top);
    for (const z of [-.42, .42]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(.26, 1, .06), clay); leg.name = 'leg'; leg.position.z = z; this.bench.add(leg); }
    for (const g of [this.bar, this.barbell, this.bench]) { g.visible = false; this.group.add(g); }
    this.dumbbells.forEach((d) => { d.visible = false; });
  }

  placeEquipment(clip, type) {
    this.dumbbells.forEach((d) => { d.visible = type === 'dumbbells'; });
    this.barbell.visible = type === 'barbell';
    this.bar.visible = type === 'bar' && !!clip.equipment;
    if (this.bar.visible) {
      const [x, y, z] = clip.equipment.at; this.bar.position.set(x, y, z);
      this.bar.children.forEach((c) => { if (c.name === 'post') { c.scale.y = y + .08; c.position.y = -(y + .08) / 2 + .08; } if (c.name === 'foot') c.position.y = -y + .015; });
    }
    const b = clip.equipment?.bench; this.bench.visible = !!b;
    if (b) {
      this.bench.position.set(b.at[0], 0, b.at[2]);
      this.bench.children.forEach((c) => {
        if (c.name === 'pad') { c.scale.z = b.length; c.position.y = b.at[1] - .03; }
        if (c.name === 'leg') { c.scale.y = b.at[1] - .06; c.position.y = (b.at[1] - .06) / 2; c.position.z = Math.sign(c.position.z) * (b.length / 2 - .1); }
      });
    }
  }

  placeBarbell() {
    if (!this.barbell.visible) return;
    const a = this.dumbbells[0].getWorldPosition(new THREE.Vector3()), b = this.dumbbells[1].getWorldPosition(new THREE.Vector3());
    this.barbell.position.copy(a).add(b).multiplyScalar(.5);
    this.barbell.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), a.sub(b).normalize());
  }

  // Camera for the exercise, as the front screen's spherical view {target, radius, theta, phi}.
  viewFor(clip, type) {
    let pos, target; const b = clip.equipment?.bench;
    if (type === 'bar') { pos = [1.6, 1.75, 4.4]; target = [0, 1.45, 0]; }
    else if (b) { pos = [b.at[0] + 2.85, 1.6, b.at[2] + 2.3]; target = [b.at[0] - .21, .62, b.at[2] + .48]; } // body sits right of the panel
    else if (clip.bones.includes('thigh_L')) { pos = [1.8, 1.35, 4.6]; target = [0, .82, 0]; }
    else { pos = [1.35, 1.45, 3.6]; target = [0, 1.12, 0]; }
    const t = new THREE.Vector3(...target), s = new THREE.Spherical().setFromVector3(new THREE.Vector3(...pos).sub(t));
    return { target: t, radius: s.radius, theta: s.theta, phi: s.phi };
  }

  // Get an exercise ready (load its clip, work out the muscles). Returns what the page needs: the camera
  // view, whether to cut instead of blend (the body moves too far, like lying down on a bench), the
  // title and the ranked working muscles.
  async prepare(name) {
    await this.init();
    const ex = EXERCISES[name], rig = this.rig;
    this.clips[ex.clip] ??= await fetch(BASE + ex.clip).then((r) => r.json());
    const clip = this.clips[ex.clip], player = this.player = new ClipPlayer(clip, rig), frames = player.liftFrames();
    this.effort = this.tracker.analyze(frames.length, (i) => player.applyFrame(frames[i]), { ...EQUIPMENT_EFFORT[ex.equipment], ...ex.extraEffort }, ex);
    rig.reset(); rig.apply();
    this.placeEquipment(clip, ex.equipment);
    this.cut = !!clip.equipment?.bench;
    const ranked = Object.entries(this.effort).sort((a, b) => b[1] - a[1]);
    return { view: this.viewFor(clip, ex.equipment), cut: this.cut, title: ex.title, ranked };
  }

  // Swap to the skinned copy and start blending in (straight to the clip when cutting).
  start() {
    this.body.visible = false; this.group.visible = true;
    this.active = true; this.phase = 'in'; this.time = 0; this.w = this.cut ? 1 : 0;
    this.update(0);
  }

  close() { if (this.active && this.phase !== 'out') { this.phase = 'out'; if (this.cut) this.w = 0; } }

  // Advance one frame. Returns true while anything is moving.
  update(dt) {
    if (!this.active) return false;
    if (this.phase === 'in') { this.w = Math.min(1, this.w + dt / IN); if (this.w >= 1) this.phase = 'play'; }
    else if (this.phase === 'out') this.w = Math.max(0, this.w - dt / OUT);
    else if (!this.paused) this.time += dt * this.speed;
    const rig = this.rig, w = smooth(this.w);
    // the clip pose, blended from rest by w (the clip waits at its first frame while blending in)
    const { k, lifting } = this.player.apply(this.time);
    this.k = k; // rep progress, for the bar
    if (w < 1) {
      for (const b of rig.list) b.quaternion.slerpQuaternions(ID, b.quaternion, w);
      rig.root.position.lerpVectors(rig.pivot.pelvis, rig.root.position, w);
      rig.root.updateMatrixWorld(true);
    }
    this.placeBarbell();
    // equipment fades in over the second half of the blend
    const op = smooth((this.w - .4) / .6);
    this.fadeMats.forEach((m) => { m.opacity = op; m.depthWrite = op > .5; });
    // working muscles turn teal (pulsing with the rep), the rest dim; contracting muscles bulge
    this.tracker.update();
    this.xray.update();
    mats.forEach((m, key) => {
      const e = this.effort[key] || 0;
      const work = e * (lifting ? .45 + .55 * Math.sin(Math.PI * Math.min(1, k * 1.15)) : .3 + .25 * k);
      m.userData.uHi.value = Math.min(1, work * 1.05) * w;
      m.userData.uDim.value = e ? 0 : w;
      m.userData.uBulge.value = (e ? this.tracker.bulge(key) : this.tracker.bulge(key) * .35) * w;
    });
    if (this.phase === 'out' && this.w <= 0) this.finish();
    return true;
  }

  // back to the static explore model
  finish() {
    this.active = false; this.phase = 'off'; this.paused = false; this.speed = 1;
    if (this.xray.mode !== 'off') this.xray.setMode('off');
    this.group.visible = false; this.body.visible = true;
    mats.forEach((m) => { m.userData.uHi.value = 0; m.userData.uDim.value = 0; m.userData.uBulge.value = 0; });
    this.onFinish?.();
  }
}
