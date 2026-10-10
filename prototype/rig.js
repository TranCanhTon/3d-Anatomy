import * as THREE from 'three';

// Skeleton for the muscle model. Bones start world aligned at their pivots, so a
// bone's rest rotation is identity and every pose is a rotation from rest.
// Arms are solved on the left side and mirrored for the right, which keeps
// symmetric exercises exactly symmetric.

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const MIRROR = (v) => new THREE.Vector3(-v.x, v.y, v.z);
const mirrorQ = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
const DEG = Math.PI / 180;

function frameQuat(a, b) { // rotation whose x axis is a and y axis is b (a, b orthonormal)
  const m = new THREE.Matrix4().makeBasis(a, b, new THREE.Vector3().crossVectors(a, b));
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

export class Rig {
  constructor(data, bin) {
    this.data = data; this.bin = new Uint8Array(bin);
    this.bones = {}; this.pivot = {};
    for (const b of data.bones) {
      const bone = new THREE.Bone(); bone.name = b.name; this.bones[b.name] = bone; this.pivot[b.name] = v3(b.pivot);
    }
    for (const b of data.bones) {
      const bone = this.bones[b.name];
      if (b.parent) { this.bones[b.parent].add(bone); bone.position.copy(this.pivot[b.name]).sub(this.pivot[b.parent]); }
      else { this.root = bone; bone.position.copy(this.pivot[b.name]); }
    }
    this.root.updateMatrixWorld(true);
    this.list = data.bones.map((b) => this.bones[b.name]);
    this.skeleton = new THREE.Skeleton(this.list);
    this.parent = Object.fromEntries(data.bones.map((b) => [b.name, b.parent]));

    // rest arm geometry (left side)
    const P = this.pivot, S0 = P.upperarm_L, E0 = P.forearm_L, W0 = P.hand_L;
    this.L1 = S0.distanceTo(E0); this.L2 = E0.distanceTo(W0);
    const d0 = W0.clone().sub(S0).normalize();
    const b0 = E0.clone().sub(S0); b0.addScaledVector(d0, -b0.dot(d0)).normalize();
    this.h0 = new THREE.Vector3().crossVectors(d0, b0).normalize();
    this.u0 = E0.clone().sub(S0).normalize(); this.f0 = W0.clone().sub(E0).normalize();
    this.restUpper = frameQuat(this.u0, this.h0); this.restFore = frameQuat(this.f0, this.h0);
    this.n0 = new THREE.Vector3().crossVectors(this.f0, this.h0).normalize(); // rest palm normal (faces forward)
    // scapula upward rotation axis: normal of the scapular plane (about 35 degrees forward of the body plane)
    this.scapAxis = new THREE.Vector3(-.57, 0, .82).normalize();
    this.world = {}; // world rotations set by the solvers, turned into local rotations in apply()
  }

  // Convert one baked mesh to a skinned mesh in world (rest) space.
  skin(mesh) {
    const meta = this.data.meshes[mesh.name]; if (!meta) return null;
    const g = mesh.geometry, n = meta.count; mesh.updateMatrixWorld(true);
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), p = new THREE.Vector3(), q = new THREE.Vector3();
    const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(g.attributes.position, i).applyMatrix4(mesh.matrixWorld); pos.set([p.x, p.y, p.z], i * 3);
      q.fromBufferAttribute(g.attributes.normal, i).applyMatrix3(nm).normalize(); nor.set([q.x, q.y, q.z], i * 3);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    const o = meta.offset;
    g.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(this.bin.slice(o, o + n * 4), 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(this.bin.slice(o + n * 4, o + n * 8), 4, true));
    g.setAttribute('belly', new THREE.BufferAttribute(this.bin.slice(o + n * 8, o + n * 9), 1, true));
    g.computeBoundingSphere();
    const sm = new THREE.SkinnedMesh(g, mesh.material);
    sm.name = mesh.name; sm.userData = mesh.userData; sm.frustumCulled = false;
    sm.bind(this.skeleton, new THREE.Matrix4());
    return sm;
  }

  reset() { this.world = {}; this.root.position.copy(this.pivot[this.data.bones[0].name]); }

  // World position of a bone pivot given the world rotations solved so far.
  worldPos(name) {
    const chain = []; for (let b = name; b; b = this.parent[b]) chain.unshift(b);
    const pos = this.pivot[chain[0]].clone(); let rot = this.world[chain[0]] || new THREE.Quaternion();
    for (let i = 1; i < chain.length; i++) {
      const off = this.pivot[chain[i]].clone().sub(this.pivot[chain[i - 1]]).applyQuaternion(rot);
      pos.add(off); rot = this.world[chain[i]] || rot;
    }
    return pos;
  }
  worldRot(name) { for (let b = name; b; b = this.parent[b]) if (this.world[b]) return this.world[b]; return new THREE.Quaternion(); }

  // Shoulder girdle follows how high the upper arm is raised (scapulohumeral rhythm).
  girdle(elev, out) {
    const up = THREE.MathUtils.clamp((elev - 30 * DEG) / 4.5, 0, 24 * DEG);
    const clav = THREE.MathUtils.clamp((elev - 70 * DEG) * .14, 0, 12 * DEG);
    const chest = this.worldRot('chest');
    out.clavicle = chest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), clav));
    out.scapula = out.clavicle.clone().multiply(new THREE.Quaternion().setFromAxisAngle(this.scapAxis, up));
  }

  // Left arm solve. pose is either
  //   {wrist: Vector3 target, pole: Vector3 direction the elbow points}  (two bone IK), or
  //   {shoulderFlex, shoulderAbd, elbow}  (angles in radians),
  // plus optional wristFlex, palm (world direction the palm should face), gripAxis (world direction
  // of the bar being held) or pron, and grip (0 open, 1 closed).
  solveLeft(pose) {
    const out = {}, P = this.pivot;
    const shoulderAt = () => {
      const c = P.clavicle_L.clone(), s = P.scapula_L.clone().sub(P.clavicle_L).applyQuaternion(out.clavicle).add(c);
      return P.upperarm_L.clone().sub(P.scapula_L).applyQuaternion(out.scapula).add(s);
    };
    let elev = Math.acos(THREE.MathUtils.clamp(-this.u0.y, -1, 1));
    if (pose.wrist) {
      for (let it = 0; it < 4; it++) {
        this.girdle(elev, out);
        const S = shoulderAt(), W = pose.wrist.clone();
        let dist = W.distanceTo(S); const d = W.clone().sub(S).normalize();
        dist = THREE.MathUtils.clamp(dist, Math.abs(this.L1 - this.L2) + 1e-3, this.L1 + this.L2 - 1e-3);
        const ca = (this.L1 ** 2 + dist ** 2 - this.L2 ** 2) / (2 * this.L1 * dist), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
        const b = pose.pole.clone(); b.addScaledVector(d, -b.dot(d)).normalize();
        const E = S.clone().addScaledVector(d, this.L1 * ca).addScaledVector(b, this.L1 * sa);
        const Wc = S.clone().addScaledVector(d, dist);
        const u = E.clone().sub(S).normalize(), f = Wc.clone().sub(E).normalize();
        const h = new THREE.Vector3().crossVectors(d, b).normalize();
        out.upperarm = frameQuat(u, h).multiply(this.restUpper.clone().invert());
        out.forearm = frameQuat(f, h).multiply(this.restFore.clone().invert());
        elev = Math.acos(THREE.MathUtils.clamp(-u.y, -1, 1));
      }
    } else {
      const R = new THREE.Quaternion().setFromEuler(new THREE.Euler(-(pose.shoulderFlex || 0), 0, pose.shoulderAbd || 0, 'XZY'));
      const u = this.u0.clone().applyQuaternion(R);
      this.girdle(Math.acos(THREE.MathUtils.clamp(-u.y, -1, 1)), out);
      out.upperarm = R.clone(); // world rotation; the girdle only moves the shoulder pivot
      out.forearm = out.upperarm.clone().multiply(new THREE.Quaternion().setFromAxisAngle(this.h0, -(pose.elbow || 0)));
    }
    // forearm twist: turn the palm toward pose.palm (world direction), line the grip up with
    // pose.gripAxis (world direction of a bar or handle), or twist by pose.pron radians
    let pron = pose.pron || 0;
    if (pose.gripAxis) {
      const f = this.f0.clone().applyQuaternion(out.forearm), h = this.h0.clone().applyQuaternion(out.forearm);
      const a = h.addScaledVector(f, -h.dot(f)).normalize(), b = pose.gripAxis.clone().addScaledVector(f, -pose.gripAxis.dot(f)).normalize();
      pron = Math.atan2(f.dot(new THREE.Vector3().crossVectors(a, b)), a.dot(b));
      // a bar can be gripped either way round: take the smaller turn
      if (pron > Math.PI / 2) pron -= Math.PI; else if (pron < -Math.PI / 2) pron += Math.PI;
    }
    if (pose.palm) {
      const f = this.f0.clone().applyQuaternion(out.forearm), n = this.n0.clone().applyQuaternion(out.forearm);
      const a = n.addScaledVector(f, -n.dot(f)).normalize(), b = pose.palm.clone().addScaledVector(f, -pose.palm.dot(f)).normalize();
      pron = Math.atan2(f.dot(new THREE.Vector3().crossVectors(a, b)), a.dot(b));
    }
    const rot = (q, axis, ang) => q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, ang));
    out.twist = rot(out.forearm, this.f0, pron);
    out.hand = rot(out.twist, this.h0, -(pose.wristFlex || 0));
    const g = pose.grip ?? 1; // 1 = closed on a dumbbell handle
    out.fingers1 = rot(out.hand, this.h0, -72 * DEG * g);
    out.fingers2 = rot(out.fingers1, this.h0, -88 * DEG * g);
    out.thumb = rot(rot(out.hand, this.f0, -38 * DEG * g), this.h0, -30 * DEG * g);
    return out;
  }

  arms(pose) {
    // pose describes the left arm; pose.right (given in right side coordinates) overrides the mirror
    const L = this.solveLeft(pose);
    let R = L;
    if (pose.right) {
      const mp = { ...pose.right }; if (mp.wrist) { mp.wrist = MIRROR(mp.wrist); mp.pole = MIRROR(mp.pole); }
      if (mp.palm) mp.palm = MIRROR(mp.palm);
      if (mp.gripAxis) mp.gripAxis = MIRROR(mp.gripAxis);
      R = this.solveLeft(mp);
    }
    for (const k of ['clavicle', 'scapula', 'upperarm', 'forearm', 'twist', 'hand', 'fingers1', 'fingers2', 'thumb']) { this.world[k + '_L'] = L[k]; this.world[k + '_R'] = mirrorQ(R[k]); }
  }

  // Turn world rotations into local bone rotations.
  apply() {
    for (const b of this.data.bones) {
      const bone = this.bones[b.name], w = this.world[b.name];
      const pw = b.parent ? this.worldRot(b.parent) : new THREE.Quaternion();
      if (w) bone.quaternion.copy(pw.clone().invert().multiply(w)); else bone.quaternion.identity();
    }
    this.root.updateMatrixWorld(true);
  }
}
