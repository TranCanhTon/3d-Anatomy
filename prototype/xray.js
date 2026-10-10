import * as THREE from 'three';

// X-ray view: shows the two things the exercise system works with.
//   Bones (white): what a clip moves. A clip only stores how each of these is turned.
//   Muscle lines: what effort.js measures. Each muscle has 3 points (origin, middle,
//   insertion) stuck to bones; the line through them is its length.
//   Red = shorter than at rest (contracting), blue = longer (stretched). Muscles that stay
//   within 1.5% of their rest length are hidden.

const UP = new THREE.Vector3(0, 1, 0), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const HIDE_BELOW = .015; // muscles within 1.5% of their rest length are not drawn
const SHORT = new THREE.Color('#ff5b3a'), LONG = new THREE.Color('#5aa9ff'), SAME = new THREE.Color('#bdb7ae');

// Thin rods and dots drawn on top of everything, so they show through the muscles.
function rods(count, radius, color) {
  const m = new THREE.InstancedMesh(new THREE.CylinderGeometry(radius, radius, 1, 6), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }), count);
  m.renderOrder = 10; m.frustumCulled = false; return m;
}
function dots(count, radius, color) {
  const m = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 10, 8), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }), count);
  m.renderOrder = 11; m.frustumCulled = false; return m;
}

export class Xray {
  constructor(scene, rig, tracker, mats) {
    Object.assign(this, { rig, tracker, mats });
    this.group = new THREE.Group(); this.group.visible = false; scene.add(this.group);
    this.boneList = rig.list.filter((b) => b.parent && b.parent.isBone);
    this.boneRods = rods(this.boneList.length, .004, '#f2eee8'); this.joints = dots(rig.list.length, .009, '#f2eee8');
    this.lines = [...tracker.lines].flatMap(([key, ls]) => ls.map((l) => ({ key, line: l })));
    this.muscleRods = rods(this.lines.length * 2, .0028, '#ffffff'); this.musclePts = dots(this.lines.length * 3, .0065, '#ffffff');
    this.group.add(this.boneRods, this.joints, this.muscleRods, this.musclePts);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.a = new THREE.Vector3(); this.b = new THREE.Vector3();
    this.s = new THREE.Vector3(); this.c = new THREE.Color(); this.focus = null; this.mode = 'off';
  }

  setMode(mode) {
    this.mode = mode; const on = mode !== 'off';
    this.group.visible = on;
    this.boneRods.visible = this.joints.visible = mode === 'bones' || mode === 'both';
    this.muscleRods.visible = this.musclePts.visible = mode === 'lines' || mode === 'both';
    // see-through muscles so the inside is visible
    this.mats.forEach((m) => { m.transparent = on; m.opacity = on ? .16 : 1; m.depthWrite = !on; m.needsUpdate = true; });
  }

  rod(mesh, i, from, to) {
    this.s.subVectors(to, from); const len = this.s.length();
    this.q.setFromUnitVectors(UP, this.s.normalize());
    this.m.compose(this.a.addVectors(from, to).multiplyScalar(.5), this.q, this.b.set(1, Math.max(len, 1e-4), 1));
    mesh.setMatrixAt(i, this.m);
  }
  dot(mesh, i, at, size) { this.m.compose(at, this.q.identity(), this.b.setScalar(size)); mesh.setMatrixAt(i, this.m); }

  // Change in length from rest, as a fraction (negative = shorter).
  change(key) { const r = this.tracker.rest.get(key); return (this.tracker.now.get(key) - r) / r; }

  update() {
    if (!this.group.visible) return;
    const pa = new THREE.Vector3(), pb = new THREE.Vector3();
    this.boneList.forEach((bone, i) => { bone.parent.getWorldPosition(pa); bone.getWorldPosition(pb); this.rod(this.boneRods, i, pa, pb); });
    this.rig.list.forEach((bone, i) => { bone.getWorldPosition(pa); this.dot(this.joints, i, pa, 1); });
    this.lines.forEach(({ key, line }, i) => {
      const ch = this.change(key), dim = this.focus && this.focus !== key;
      const t = Math.min(1, Math.abs(ch) / .15);
      this.c.copy(SAME).lerp(ch < 0 ? SHORT : LONG, t); if (dim) this.c.multiplyScalar(.25);
      const big = this.focus === key ? 1.8 : 1;
      if (Math.abs(ch) < HIDE_BELOW && this.focus !== key) { // unchanged muscle: hide its line and dots
        for (let s = 0; s < 2; s++) this.muscleRods.setMatrixAt(i * 2 + s, ZERO);
        for (let p = 0; p < 3; p++) this.musclePts.setMatrixAt(i * 3 + p, ZERO);
        return;
      }
      for (let s = 0; s < 2; s++) { this.rod(this.muscleRods, i * 2 + s, line.world[s], line.world[s + 1]); this.muscleRods.setColorAt(i * 2 + s, this.c); }
      for (let p = 0; p < 3; p++) {
        // ends (origin and insertion) are bigger than the middle point
        this.dot(this.musclePts, i * 3 + p, line.world[p], (p === 1 ? .7 : 1.15) * big); this.musclePts.setColorAt(i * 3 + p, this.c);
      }
    });
    for (const m of [this.boneRods, this.joints, this.muscleRods, this.musclePts]) {
      m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  // Rows for the side panel: every muscle whose length changed, biggest change first.
  rows() {
    return [...this.tracker.lines.keys()].map((key) => ({ key, change: this.change(key) }))
      .filter((r) => Math.abs(r.change) > .01).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  }
}
