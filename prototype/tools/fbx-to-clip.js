import * as THREE from 'three';
import { recordFrames } from '../clip.js';

// Turns a motion capture animation (an FBX from the Wolff's Studio workout pack) into a clip for
// our rig. The FBX character is never shown; only its skeleton motion is used.
//
// For every one of our bones we take the matching pack bone and copy how far it has turned from
// its own rest pose. Both skeletons stand the same way (left is +x, up is +y, facing +z), so for
// the spine and legs that turn can be copied straight across. The arms differ at rest (the pack
// stands in a T-pose, our model has its arms hanging with palms forward), so each arm bone gets a
// fixed offset that lines up the bone and the palm in both rest poses first.
// The hips' movement is scaled to our leg length, and the feet can be pinned to the floor.

const SIDES = [['L', 'Left'], ['R', 'Right']];
// our bone -> pack bone
const MAP = { pelvis: 'Hips', spine: 'Spine2', chest: 'Spine4', neck: 'Neck', head: 'Head' };
for (const [s, S] of SIDES) Object.assign(MAP, {
  ['clavicle_' + s]: S + 'Shoulder', ['upperarm_' + s]: S + 'Arm', ['forearm_' + s]: S + 'ForeArm', ['hand_' + s]: S + 'Hand',
  ['thigh_' + s]: S + 'Thigh', ['shin_' + s]: S + 'Shin', ['foot_' + s]: S + 'Foot',
});
const DEG = Math.PI / 180;
const mirrorQ = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);

function frameQuat(dir, ref) { // rotation whose x axis is dir and y axis is ref made square to it
  const a = dir.clone().normalize(), b = ref.clone().addScaledVector(a, -ref.dot(a)).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(a, b, new THREE.Vector3().crossVectors(a, b)));
}
// the part of rotation q that turns about axis (swing twist split)
function twistAbout(q, axis) {
  const p = axis.clone().multiplyScalar(axis.dot(new THREE.Vector3(q.x, q.y, q.z)));
  const t = new THREE.Quaternion(p.x, p.y, p.z, q.w); return t.lengthSq() < 1e-12 ? new THREE.Quaternion() : t.normalize();
}

// Left arm two bone solve in world space: shoulder S, wrist target Wt, elbow direction pole, bar
// direction ax. Returns world rotations for upperarm, forearm, twist, hand. The right arm is solved as
// a mirrored left arm (inputs mirrored, answers mirrored back), like Rig.arms().
function solveArmOnBar(rig, side, S, Wt, pole, ax) {
  const M = (v) => (side === 'L' ? v.clone() : new THREE.Vector3(-v.x, v.y, v.z));
  const s0 = M(S), w0 = M(Wt), b0 = M(pole), a0 = M(ax), L1 = rig.L1, L2 = rig.L2;
  const d = w0.clone().sub(s0).normalize();
  // soft reach: the last 6% of arm length is eased in, so the elbow straightens gradually at lockout
  // instead of snapping (near full reach a tiny wrist move means a big elbow angle change)
  const Lmax = L1 + L2 - 1e-3, soft = Lmax * .94; let dist = w0.distanceTo(s0);
  if (dist > soft) dist = soft + (Lmax - soft) * (1 - Math.exp(-(dist - soft) / (Lmax - soft)));
  dist = Math.max(dist, Math.abs(L1 - L2) + 1e-3);
  const ca = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
  const b = b0.addScaledVector(d, -b0.dot(d)).normalize();
  const E = s0.clone().addScaledVector(d, L1 * ca).addScaledVector(b, L1 * sa), Wc = s0.clone().addScaledVector(d, dist);
  const u = E.clone().sub(s0), f = Wc.clone().sub(E), h = new THREE.Vector3().crossVectors(d, b);
  const upper = frameQuat(u, h).multiply(rig.restUpper.clone().invert()), fore = frameQuat(f, h).multiply(rig.restFore.clone().invert());
  // turn the forearm so the line across the palm runs along the bar (the smaller of the two ways round)
  const ff = rig.f0.clone().applyQuaternion(fore), hh = rig.h0.clone().applyQuaternion(fore);
  const pa = hh.addScaledVector(ff, -hh.dot(ff)).normalize(), pb = a0.addScaledVector(ff, -a0.dot(ff)).normalize();
  let pron = Math.atan2(ff.dot(new THREE.Vector3().crossVectors(pa, pb)), pa.dot(pb));
  if (pron > Math.PI / 2) pron -= Math.PI; else if (pron < -Math.PI / 2) pron += Math.PI;
  const twist = fore.clone().multiply(new THREE.Quaternion().setFromAxisAngle(rig.f0, pron));
  const out = { upperarm: upper, forearm: fore, twist, hand: twist.clone() };
  if (side === 'R') for (const k in out) out[k] = mirrorQ(out[k]);
  return out;
}

/**
 * fbx: the object FBXLoader returns (skeleton + one animation), straight from the loader (still in its rest pose)
 * rig: our Rig
 * opts: { name, equipment: 'dumbbells' | 'barbell' | null,
 *         plant: 'feet' (pin both feet where they stand at rest) | 'floor' (keep the feet on the floor, for lying
 *                exercises; one height for the whole clip) | null,
 *         load: 'hands' | 'body' (what goes up during the lift; default hands when holding weights) }
 * With a barbell the arms are solved again so both hands stay on one straight bar (the pack only has
 * dumbbells, whose hands drift apart and together).
 */
export function fbxToClip(fbx, rig, opts = {}) {
  const { name = 'clip', equipment = null, plant = 'feet', fps = 30 } = opts;
  const load = opts.load || (equipment ? 'hands' : 'body'), barbell = equipment === 'barbell';
  // pack bones by name (some names appear twice, nested; the inner one carries everything)
  const src = {}; fbx.traverse((o) => { if (o.isBone) src[o.name] = o; });
  const W = (n) => src[n].getWorldQuaternion(new THREE.Quaternion()), Pw = (n) => src[n].getWorldPosition(new THREE.Vector3());

  // rest pose of the pack
  fbx.updateMatrixWorld(true);
  const rest = {}; for (const n of Object.values(MAP)) rest[n] = W(n).invert();
  const hipsRest = Pw('Hips');
  const legPack = Pw('LeftThigh').distanceTo(Pw('LeftShin')) + Pw('LeftShin').distanceTo(Pw('LeftFoot'));
  const P = rig.pivot, legOurs = P.thigh_L.distanceTo(P.shin_L) + P.shin_L.distanceTo(P.foot_L), scale = legOurs / legPack;

  // arm offsets: line up each arm bone's direction and the line across the palm (index to little
  // finger knuckles in the pack, the dumbbell handle axis in our hand) in both rest poses
  const align = {};
  for (const [s, S] of SIDES) {
    const radialPack = Pw(S + 'Finger2Metacarpal').sub(Pw(S + 'Finger5Metacarpal')), radialOurs = new THREE.Vector3(s === 'L' ? rig.h0.x : -rig.h0.x, rig.h0.y, rig.h0.z); // across the palm, where the dumbbell handle sits
    const pairs = { upperarm: [['upperarm', 'forearm'], ['Arm', 'ForeArm']], forearm: [['forearm', 'hand'], ['ForeArm', 'Hand']], hand: [['hand', 'fingers1'], ['Hand', 'Finger3Proximal']] };
    for (const [b, [[o0, o1], [p0, p1]]] of Object.entries(pairs)) {
      const dOurs = P[o1 + '_' + s].clone().sub(P[o0 + '_' + s]), dPack = Pw(S + p1).sub(Pw(S + p0));
      align[b + '_' + s] = frameQuat(dPack, radialPack).multiply(frameQuat(dOurs, radialOurs).invert());
    }
  }

  // play the animation
  const clipSrc = fbx.animations[0], mixer = new THREE.AnimationMixer(fbx); mixer.clipAction(clipSrc).play();
  const frames = Math.round(clipSrc.duration * fps);
  const at = (i) => { mixer.setTime((i % frames) / fps); fbx.updateMatrixWorld(true); };

  // what rises during the lift: the hands for weights, the body otherwise. The lift runs from
  // its lowest point to its highest; the clip is turned so it starts at the bottom of the lift.
  const height = [];
  for (let i = 0; i < frames; i++) {
    at(i); height.push(load === 'hands' ? (Pw('LeftHand').y + Pw('RightHand').y) / 2 : (Pw('Hips').y + Pw('Spine4').y) / 2);
  }
  let lo = 0, hi = 0; height.forEach((h, i) => { if (h < height[lo]) lo = i; if (h > height[hi]) hi = i; });
  const top = (hi - lo + frames) % frames || frames - 1, span = Math.max(1e-6, height[hi] - height[lo]);

  const f0 = P.hand_L.clone().sub(P.forearm_L).normalize(), h0 = rig.h0;
  const pose = (j) => {
    at(j);
    rig.reset();
    for (const [ours, pack] of Object.entries(MAP)) {
      const d = W(pack).multiply(rest[pack]); // how far the pack bone turned from rest (world)
      rig.world[ours] = align[ours] ? d.multiply(align[ours]) : d;
    }
    for (const [s] of SIDES) {
      // forearm twist bone takes half the roll between forearm and hand, like a real radius
      const fw = rig.world['forearm_' + s], hw = rig.world['hand_' + s], axis = s === 'L' ? f0 : new THREE.Vector3(-f0.x, f0.y, f0.z);
      rig.world['twist_' + s] = fw.clone().multiply(new THREE.Quaternion().slerp(twistAbout(fw.clone().invert().multiply(hw), axis), .5));
      // closed grip on the handle (the same grip the hand written exercises use)
      const g = equipment ? 1 : 0, side = (q) => (s === 'L' ? q : mirrorQ(q)), aa = (ax, a) => side(new THREE.Quaternion().setFromAxisAngle(ax, a));
      rig.world['fingers1_' + s] = hw.clone().multiply(aa(h0, -72 * DEG * g));
      rig.world['fingers2_' + s] = rig.world['fingers1_' + s].clone().multiply(aa(h0, -88 * DEG * g));
      rig.world['thumb_' + s] = hw.clone().multiply(aa(f0, -38 * DEG * g)).multiply(aa(h0, -30 * DEG * g));
    }
    // body position: the pack's hip movement at our scale
    const off = Pw('Hips').sub(hipsRest).multiplyScalar(scale);
    rig.root.position.copy(P.pelvis).add(off); rig.apply();
    if (plant === 'feet') { // pin the feet where they stand at rest
      const fix = new THREE.Vector3();
      for (const [s] of SIDES) fix.add(P['foot_' + s].clone().sub(rig.bones['foot_' + s].getWorldPosition(new THREE.Vector3())));
      off.add(fix.multiplyScalar(.5));
    }
    if (plant === 'floor') off.y += floorFix;
    rig.root.position.copy(P.pelvis).add(off); rig.root.updateMatrixWorld(true);
    if (barbell && grip) onBar(j);
    return off;
  };
  const wpos = (b) => rig.bones[b].getWorldPosition(new THREE.Vector3());
  // Barbell: the bar's middle follows the middle of the pack's hands; both wrists sit on it at a fixed
  // grip width, the elbows keep the pack's direction, the hands turn to hold the bar.
  const BAR = new THREE.Vector3(1, 0, 0);
  // where the bar sits in each hand (the dumbbell grip point), in the hand bone's own space
  const gripIn = (s) => new THREE.Vector3(s === 'L' ? .279 : -.279, .787, .056).sub(P['hand_' + s]);
  const gripMid = () => SIDES.reduce((a, [s]) => a.add(rig.bones['hand_' + s].localToWorld(gripIn(s))), new THREE.Vector3()).multiplyScalar(.5);
  // front of the chest: 19 cm in front of the chest bone (the pecs), the bar may not go below it
  const chestFront = () => wpos('chest').add(new THREE.Vector3(0, 0, .19).applyQuaternion(rig.bones.chest.getWorldQuaternion(new THREE.Quaternion())));
  let lift = null; // per frame: how much to raise the bar so it touches the chest instead of sinking in
  const onBar = (j) => {
    const mid = wpos('hand_L').add(wpos('hand_R')).multiplyScalar(.5);
    if (lift) mid.y += lift[j];
    solveBar(mid);
  };
  const solveBar = (mid) => {
    for (const [s] of SIDES) {
      const S = wpos('upperarm_' + s), E = wpos('forearm_' + s);
      const Wt = mid.clone().addScaledVector(BAR, (s === 'L' ? 1 : -1) * grip / 2);
      // elbow direction: where the pack's elbow sits off the shoulder to wrist line. With the arm locked
      // out that is undefined and the upper arm would spin, so a small default (elbow out to the side
      // and down toward the floor) takes over when the arm is nearly straight.
      const d = Wt.clone().sub(S).normalize(), e = E.sub(S), off = e.addScaledVector(d, -e.dot(d)).divideScalar(rig.L1);
      const pole = off.add(new THREE.Vector3(s === 'L' ? 1 : -1, -.6, 0).normalize().multiplyScalar(.15));
      Object.entries(solveArmOnBar(rig, s, S, Wt, pole, BAR)).forEach(([k, q]) => { rig.world[k + '_' + s] = q; });
      const hw = rig.world['hand_' + s], side = (q) => (s === 'L' ? q : mirrorQ(q)), aa = (ax, a) => side(new THREE.Quaternion().setFromAxisAngle(ax, a));
      rig.world['fingers1_' + s] = hw.clone().multiply(aa(h0, -72 * DEG));
      rig.world['fingers2_' + s] = rig.world['fingers1_' + s].clone().multiply(aa(h0, -88 * DEG));
      rig.world['thumb_' + s] = hw.clone().multiply(aa(f0, -38 * DEG)).multiply(aa(h0, -30 * DEG));
    }
    rig.apply();
  };
  // floor: one height for the whole clip that puts the lowest foot on the floor (averaged over the rep)
  let floorFix = 0, grip = 0;
  if (plant === 'floor') {
    let t = 0;
    for (let i = 0; i < frames; i++) { pose(i); t += Math.max(...SIDES.map(([s]) => P['foot_' + s].y - wpos('foot_' + s).y)); }
    floorFix = t / frames;
  }
  // grip width: how far apart the hands are at the bottom of the lift (forearms upright there)
  if (barbell) {
    pose(lo); grip = wpos('hand_L').distanceTo(wpos('hand_R'));
    // the pack's dumbbells go lower than a bar can (beside the chest): find how deep the bar would sink
    // into the chest, then raise the path by that much at the bottom, fading to nothing at the top
    const gy = [], sink = [];
    for (let i = 0; i < frames; i++) { pose(i); const g = gripMid(); gy.push(g.y); sink.push(chestFront().y + .02 - g.y); }
    const deepest = Math.max(...sink), yb = Math.min(...gy), yt = Math.max(...gy);
    lift = gy.map((y) => (deepest > 0 ? deepest * THREE.MathUtils.clamp((yt - y) / Math.max(1e-6, yt - yb), 0, 1) : 0));
  }

  const root = [];
  const clip = recordFrames(name, frames / fps, rig, (t) => {
    const i = Math.round(t * fps), j = (lo + i) % frames, off = pose(j);
    root.push(off.toArray().map((v) => +v.toFixed(4)));
    return { k: (height[j] - height[lo]) / span, lifting: i <= top };
  }, fps, { source: { animation: clipSrc.name } });
  clip.root = root;
  if (barbell) {
    // a flat bench under the back when lying: from under the head to past the hips, top just under the spine
    pose(lo); const pel = wpos('pelvis'), neck = wpos('neck'), lying = Math.abs(neck.y - pel.y) < .25;
    clip.equipment = { type: 'barbell', grip: +grip.toFixed(3) };
    if (lying) {
      const head = wpos('head'), top = Math.min(pel.y, wpos('chest').y) - .1;
      const z0 = Math.min(pel.z, head.z) - .1, z1 = Math.max(pel.z, head.z) + .25; // from past the head to under the seat
      clip.equipment.bench = { at: [+((pel.x + neck.x) / 2).toFixed(3), +top.toFixed(3), +((z0 + z1) / 2).toFixed(3)], length: +(z1 - z0).toFixed(3) };
    }
  }
  mixer.stopAllAction(); rig.reset(); rig.apply();
  return clip;
}
