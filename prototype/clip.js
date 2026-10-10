import * as THREE from 'three';

// Clip format: one recorded rep of an exercise.
//
// {
//   "format": "muscle-clip", "version": 1, "name": "curl",
//   "fps": 30,                       frames per second of the recording
//   "frames": 89,                    number of frames in one rep (the last frame loops back to the first)
//   "bones": ["upperarm_L", ...],    bones that move; every other bone stays at rest
//   "progress": [0, 0.01, ...],      rep progress per frame: 0 = start of the lift, 1 = top
//   "lifting": [1, 1, ..., 0, 0],    1 while the weight goes up, 0 while it comes down or rests
//   "rotations": [[x, y, z, w, ...], ...]  per frame: local rotation (quaternion) of each listed bone, in order
//   "root": [[x, y, z], ...]          optional, per frame: how far the whole body is moved (a pull up rises)
//   "equipment": { type, at }         optional, where fixed equipment sits (a pull up bar)
// }
//
// Any tool that makes exercises (hand written poses, the pose editor, the video pipeline)
// saves this same file, and the page only ever needs ClipPlayer to play it.

export class ClipPlayer {
  constructor(clip, rig) {
    this.clip = clip; this.rig = rig;
    this.bones = clip.bones.map((n) => rig.bones[n]);
    this.duration = clip.frames / clip.fps;
    this.qa = new THREE.Quaternion(); this.qb = new THREE.Quaternion();
  }

  // Put frame i (whole number) on the skeleton.
  applyFrame(i) {
    const r = this.clip.rotations[i];
    this.rig.list.forEach((b) => b.quaternion.identity());
    this.bones.forEach((b, j) => b.quaternion.fromArray(r, j * 4));
    this.moveRoot(i, i, 0);
    this.rig.root.updateMatrixWorld(true);
  }

  // whole body offset (only clips that move the body have it)
  moveRoot(i, j, a) {
    const root = this.rig.root; root.position.copy(this.rig.pivot.pelvis);
    const R = this.clip.root; if (!R) return;
    root.position.x += R[i][0] + (R[j][0] - R[i][0]) * a;
    root.position.y += R[i][1] + (R[j][1] - R[i][1]) * a;
    root.position.z += R[i][2] + (R[j][2] - R[i][2]) * a;
  }

  // Pose the skeleton at time t (seconds, loops) and return where in the rep we are.
  apply(t) {
    const c = this.clip, f = ((t * c.fps) % c.frames + c.frames) % c.frames;
    const i = Math.floor(f), j = (i + 1) % c.frames, a = f - i;
    const ra = c.rotations[i], rb = c.rotations[j];
    this.rig.list.forEach((b) => b.quaternion.identity());
    this.bones.forEach((b, n) => {
      this.qa.fromArray(ra, n * 4); this.qb.fromArray(rb, n * 4);
      b.quaternion.slerpQuaternions(this.qa, this.qb, a);
    });
    this.moveRoot(i, j, a);
    this.rig.root.updateMatrixWorld(true);
    return { k: c.progress[i] + (c.progress[j] - c.progress[i]) * a, lifting: !!c.lifting[i] };
  }

  // Frames of the lifting half, in order (used to work out effort).
  liftFrames() { return this.clip.lifting.map((v, i) => (v ? i : -1)).filter((i) => i >= 0); }
}

// Record any motion into a clip. poseAt(t) must put the rig in its pose for time t (seconds)
// and return { k, lifting }. `extra` is merged into the clip (the editor stores its keyframes there).
export function recordFrames(name, duration, rig, poseAt, fps = 30, extra = {}) {
  const frames = Math.round(duration * fps), local = [], progress = [], lifting = [];
  for (let i = 0; i < frames; i++) {
    const p = poseAt(i / fps);
    local.push(rig.list.map((b) => b.quaternion.toArray()));
    progress.push(+p.k.toFixed(4)); lifting.push(p.lifting ? 1 : 0);
  }
  // keep only bones that move away from rest at some point
  const moving = rig.list.map((b, j) => local.some((f) => Math.abs(f[j][3]) < .99999)).map((m, j) => (m ? j : -1)).filter((j) => j >= 0);
  return {
    format: 'muscle-clip', version: 1, name, fps, frames,
    bones: moving.map((j) => rig.list[j].name), progress, lifting,
    rotations: local.map((f) => moving.flatMap((j) => f[j].map((v) => +v.toFixed(5)))),
    ...extra,
  };
}

// Record a hand written pose exercise ({rep, pose}) into a clip.
export function recordClip(name, ex, rig, repProgress, fps = 30) {
  const { up, hold, down, rest } = ex.rep;
  return recordFrames(name, up + hold + down + rest, rig, (t) => {
    const p = repProgress(t, ex.rep); rig.reset(); rig.arms(ex.pose(p.k)); rig.apply(); return p;
  }, fps);
}
