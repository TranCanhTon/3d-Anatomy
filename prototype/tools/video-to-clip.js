import * as THREE from 'three';
import { recordFrames } from '../clip.js';

// Turns tracked video joints (from tools/track_video.py) into a clip for the rig.
//
// The tracker gives 33 body points per frame in metres. We don't copy positions (the person in
// the video has different proportions); we copy directions: which way the upper arm and forearm
// point, measured relative to the torso, so camera angle and zoom don't matter. Those directions
// go into the same arm solver the hand written exercises use. If the hands hold a fixed bar,
// the whole body is moved so the hands stay on it (that is what makes a pull up go up).

const P = { lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lIdx: 19, rIdx: 20, lPinky: 17, rPinky: 18 };
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// Tracker space is camera based (x right in the image, y down). Its numbers only matter through
// the torso frame below, so the camera direction cancels out.
function smoothTrack(frames, sigma, key = 'world') {
  const n = frames.length, out = frames.map((f) => f[key].map((p) => [...p]));
  const r = Math.ceil(sigma * 3), w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  for (let i = 0; i < n; i++) for (let j = 0; j < 33; j++) for (let c = 0; c < 3; c++) {
    let s = 0, ws = 0;
    for (let k = -r; k <= r; k++) { const ii = Math.min(n - 1, Math.max(0, i + k)); s += frames[ii][key][j][c] * w[k + r]; ws += w[k + r]; }
    out[i][j][c] = s / ws;
  }
  return out;
}

// torso frame: x = toward the person's left, y = up the spine, z = forward (the rig's rest axes)
function torsoFrame(p) {
  const ls = V(p[P.lSh]), rs = V(p[P.rSh]), lh = V(p[P.lHip]), rh = V(p[P.rHip]);
  const x = ls.clone().sub(rs).normalize();
  const up = ls.clone().add(rs).sub(lh).sub(rh).multiplyScalar(.5);
  const y = up.addScaledVector(x, -up.dot(x)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y); // tracker axes are right handed, so left x up = forward
  return new THREE.Matrix3().set(x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z); // rows: tracker -> torso
}
const inTorso = (m, v) => v.clone().applyMatrix3(m).normalize();

/**
 * track: { fps, frames: [{ world: [[x,y,z] x33] }] }
 * opts: { from, to (frame numbers), name, hold: 'bar' | null, blend (seconds to loop back),
 *         mode: '2d' (image directions + arm length, default) or '3d' (tracker's own 3D guess),
 *         symmetric: average both arms into one mirrored motion (default for bar exercises),
 *         lower: 'reverse' (way down = way up backwards, default) or 'video' (use the video's own way down) }
 */
export function videoToClip(track, rig, opts) {
  const { from, to, name, hold = null, blend = .35, sigma = 2.5, mode = '2d', symmetric = hold === 'bar', lower = 'reverse', downSlower = 1.25 } = opts;
  const src = track.frames.slice(from, to + 1), sm = smoothTrack(src, sigma), img = smoothTrack(src, sigma, 'img'), fps = track.fps;
  const ARMS = [['L', P.lSh, P.lEl, P.lWr], ['R', P.rSh, P.rEl, P.rWr]];

  // 3D guess from the tracker, in torso space. Its side to side and up and down are good;
  // its depth (toward or away from the camera) is a guess and can be far off.
  const guess = sm.map((p) => {
    const m = torsoFrame(p), d = {};
    for (const [s, sh, el, wr] of ARMS) d[s] = { up: inTorso(m, V(p[el]).sub(V(p[sh]))), fore: inTorso(m, V(p[wr]).sub(V(p[el]))) };
    return d;
  });

  // Flat image directions plus known arm length. Each arm segment's real length (in shoulder
  // widths) is its longest on screen during the clip; when it looks shorter than that, the rest
  // is depth, and the tracker's guess only decides whether that depth is forward or back.
  const sw = img.map((p) => Math.hypot(p[P.lSh][0] - p[P.rSh][0], p[P.lSh][1] - p[P.rSh][1]));
  const back = img[0][P.lSh][0] < img[0][P.rSh][0]; // person's left on the image left = filmed from behind
  const flat = (p, i, a, b) => new THREE.Vector2((back ? -1 : 1) * (p[b][0] - p[a][0]) / sw[i], -(p[b][1] - p[a][1]) / sw[i]);
  const len = {};
  for (const [s, sh, el, wr] of ARMS) {
    len[s + 'up'] = Math.max(...img.map((p, i) => flat(p, i, sh, el).length()));
    len[s + 'fore'] = Math.max(...img.map((p, i) => flat(p, i, el, wr).length()));
  }
  const dir3 = (f, L, sign) => { const pl = f.length(); const z = pl < L ? Math.sqrt(L * L - pl * pl) * sign : 0; return new THREE.Vector3(f.x, f.y, z).normalize(); };
  // Forward or back is decided once per arm segment for the whole clip (by the tracker's average
  // guess), so a few bad frames can't flip an arm from in front of the body to behind it.
  const sideSign = {};
  for (const [s] of ARMS) for (const part of ['up', 'fore']) sideSign[s + part] = Math.sign(guess.reduce((t, g) => t + g[s][part].z, 0)) || 1;
  const dirs = img.map((p, i) => {
    if (mode !== '2d') return guess[i];
    const d = {};
    for (const [s, sh, el, wr] of ARMS) {
      d[s] = { up: dir3(flat(p, i, sh, el), len[s + 'up'], sideSign[s + 'up']), fore: dir3(flat(p, i, el, wr), len[s + 'fore'], sideSign[s + 'fore']) };
    }
    return d;
  });

  // two handed lifts: average left with the mirrored right, so uneven tracking doesn't tilt the body
  if (symmetric) {
    const mir = (v) => new THREE.Vector3(-v.x, v.y, v.z);
    for (const d of dirs) {
      for (const part of ['up', 'fore']) {
        const v = d.L[part].clone().add(mir(d.R[part])).normalize();
        d.L[part] = v; d.R[part] = mir(v);
      }
    }
  }

  // elbow bend tells us where the lift is: the lift runs from the start to the most bent frame
  const bend = (d) => (d.L.up.angleTo(d.L.fore) + d.R.up.angleTo(d.R.fore)) / 2;
  let elbow = dirs.map(bend), top = 0;
  elbow.forEach((a, i) => { if (a > elbow[top]) top = i; });

  if (lower === 'reverse') {
    // The way down is the way up played backwards (slower), with a short pause at the top and the
    // bottom. The lift is usually the cleanest part of a video, and it loops perfectly.
    const up = dirs.slice(0, top + 1), seq = [...up];
    const hold = (n, d) => { for (let i = 0; i < n; i++) seq.push(d); };
    hold(Math.round(.12 * fps), up[top]);
    const n = Math.round(up.length * downSlower);
    for (let i = 1; i <= n; i++) {
      const x = top * (1 - i / n), i0 = Math.floor(x), i1 = Math.min(top, i0 + 1), t = x - i0, mix = (a, b) => a.clone().lerp(b, t).normalize();
      seq.push({ L: { up: mix(up[i0].L.up, up[i1].L.up), fore: mix(up[i0].L.fore, up[i1].L.fore) }, R: { up: mix(up[i0].R.up, up[i1].R.up), fore: mix(up[i0].R.fore, up[i1].R.fore) } });
    }
    hold(Math.round(.2 * fps), up[0]);
    dirs.length = 0; dirs.push(...seq); elbow = dirs.map(bend);
  } else {
    // keep the video's own way down and blend its end back into the start
    const nb = Math.round(blend * fps), mixDir = (a, b, t) => a.clone().lerp(b, t).normalize();
    const A = dirs[dirs.length - 1], B = dirs[0], last = dirs.length - 1;
    for (let i = 1; i <= nb; i++) {
      const t = i / (nb + 1), e = t * t * (3 - 2 * t);
      dirs.push({ L: { up: mixDir(A.L.up, B.L.up, e), fore: mixDir(A.L.fore, B.L.fore, e) }, R: { up: mixDir(A.R.up, B.R.up, e), fore: mixDir(A.R.fore, B.R.fore, e) } });
      elbow.push(elbow[last] + (elbow[0] - elbow[last]) * e);
    }
  }
  const a0 = elbow[0], aTop = elbow[top];

  // turn directions into a pose for the arm solver: wrist target and elbow direction
  const S = (s) => rig.pivot['upperarm_' + s];
  // Elbow direction: where the elbow sits off the shoulder to wrist line. With a nearly straight
  // arm that is almost undefined, so a small default (elbow out to the side, a little back) keeps
  // the arm from spinning; once the elbow bends, the video's elbow takes over.
  const armPose = (d, s) => {
    const wrist = S(s).clone().addScaledVector(d.up, rig.L1).addScaledVector(d.fore, rig.L2);
    const line = wrist.clone().sub(S(s)).normalize(), off = d.up.clone().addScaledVector(line, -d.up.dot(line));
    const pole = off.add(new THREE.Vector3(s === 'L' ? 1 : -1, 0, -.3).multiplyScalar(.12));
    return { wrist, pole, gripAxis: hold === 'bar' ? new THREE.Vector3(1, 0, 0) : undefined, grip: 1 };
  };
  const solve = (i) => {
    const d = dirs[i];
    rig.reset(); rig.arms({ ...armPose(d.L, 'L'), right: armPose(d.R, 'R') }); rig.apply();
  };

  // Hands on a fixed bar: the wrists stay where they are in the first frame; every frame the
  // body is moved so the arms (as the video has them) reach the bar, then the arms are solved
  // once more onto the exact bar points.
  const wristW = (s) => rig.bones['hand_' + s].getWorldPosition(new THREE.Vector3());
  let anchor = null, bar = null;
  if (hold === 'bar') {
    solve(0); anchor = { L: wristW('L'), R: wristW('R') };
    const lift = new THREE.Vector3(0, .06, 0); anchor.L.add(lift); anchor.R.add(lift); // feet 6 cm off the floor at the bottom
  }
  const root = [];
  const solveOnBar = (i) => {
    solve(i);
    if (!anchor) return new THREE.Vector3();
    const off = anchor.L.clone().sub(wristW('L')).add(anchor.R.clone().sub(wristW('R'))).multiplyScalar(.5);
    const d = dirs[i], target = (s) => anchor[s].clone().sub(off);
    rig.reset(); rig.arms({ ...armPose(d.L, 'L'), wrist: target('L'), right: { ...armPose(d.R, 'R'), wrist: target('R') } }); rig.apply();
    return off;
  };
  if (anchor) {
    // where the grip sits on the bar (the handle point in the hand), at the first frame
    const grip = new THREE.Vector3(.279, .787, .056), off = solveOnBar(0), g = new THREE.Vector3();
    for (const s of ['L', 'R']) { const p = grip.clone(); if (s === 'R') p.x *= -1; g.add(p.sub(rig.pivot['hand_' + s]).applyMatrix4(rig.bones['hand_' + s].matrixWorld)); }
    bar = g.multiplyScalar(.5).add(off);
  }

  const duration = dirs.length / fps;
  const clip = recordFrames(name, duration, rig, (t) => {
    const i = Math.min(dirs.length - 1, Math.round(t * fps));
    const off = solveOnBar(i);
    root.push([+off.x.toFixed(4), +off.y.toFixed(4), +off.z.toFixed(4)]);
    const k = THREE.MathUtils.clamp((elbow[i] - a0) / Math.max(1e-3, aTop - a0), 0, 1);
    return { k, lifting: i <= top };
  }, 30, { source: { video: opts.video || '', frames: [from, to] }, ...(bar ? { equipment: { type: 'bar', at: [+bar.x.toFixed(4), +bar.y.toFixed(4), +bar.z.toFixed(4)] } } : {}) });
  clip.root = root;
  rig.reset(); rig.apply();
  return clip;
}
