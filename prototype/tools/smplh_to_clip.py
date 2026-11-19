"""Turn FlowHMR motion (SMPL-H .npz) into a clip for our rig: exercises that hang from a bar, or lie on a bench.

Usage (from the project folder):
    python prototype/tools/smplh_to_clip.py MOTION.npz SMPLH_MODEL.npz OUT.json --name chinup
    python prototype/tools/smplh_to_clip.py MOTION.npz SMPLH_MODEL.npz OUT.json --name bench --mode bench

MOTION.npz:      FlowHMR output (flowhmr_latest.npz): poses (T, 52, 3) axis angle, trans (T, 3), betas.
SMPLH_MODEL.npz: the SMPL-H neutral body model (neutral/model.npz from smplh.tar.xz). Never commit it.
Needs numpy and scipy. Works like tools/fbx-to-clip.js, written in Python because the body model is a
numpy file and the maths is plain rotations (no browser needed).

How it works (both modes):
- FlowHMR's axes are Y up (checked in its code).
- Every one of our bones copies how its matching SMPL-H joint is turned (SMPL-H rest rotations are all
  identity, so the joint's world rotation is its turn from rest). Rest poses differ (SMPL-H is a T-pose,
  ours has the arms down), so each bone first gets a fixed offset that lines up the bone's direction and a
  second reference direction in both rest poses: the line across the palm for arm bones, forward for the
  rest. The same method as fbx-to-clip.js.
- Our skeleton has fewer bones. Spine: our spine takes SMPL-H spine1, our chest takes spine3, whose turn
  already includes spine2. Fingers are not copied; the hand closes on the bar like every other clip.
  The shoulder blade follows how high the arm is raised, with the same rule as rig.js.
- The clip is cut from the bottom of the first rep to the bottom after the last complete rep, and the
  last frames are blended into the first so it loops.

--mode hang (chin up, pull up), the default:
- The whole motion is turned around Y so the body faces +Z, like our model.
- FlowHMR keeps the feet on the floor (it assumes people stand). On a bar the hands are what's fixed, so
  the whole body is moved every frame to keep the grip point on the bar, and the bar is set high enough
  that the feet clear the floor at the bottom.
- A hanging body swings until its centre of mass is under the hands. Each frame the body is tilted about
  the bar by the angle that puts it there (--no-swing turns this off).
- Lifting = the elbows bending (pulling up).

--mode bench (barbell bench press):
- The body is laid flat on its back, head toward -Z and feet toward +Z (like the mocap bench press), which
  also levels out any head-down tilt in the video.
- One height for the whole clip puts the feet on the floor; the bench goes under the back (10 cm below the
  pelvis and chest joints, from past the head to under the seat), like fbx-to-clip.js.
- Both hands go onto one straight bar at a fixed grip width; the bar follows the video's path.
- Lifting = the elbows straightening (pressing up).
"""
import argparse, json, sys
import numpy as np
from scipy.spatial.transform import Rotation as R, Slerp
from scipy.signal import find_peaks

DEG = np.pi / 180
RIG_JSON = 'prototype/rig.json'
BENCH_PELVIS_Z = -.56  # where the mocap bench press lies, so the viewer's bench camera frames both the same

# SMPL-H joints (body part of the 52)
S = dict(pelvis=0, l_hip=1, r_hip=2, spine1=3, l_knee=4, r_knee=5, spine2=6, l_ankle=7, r_ankle=8, spine3=9,
         l_foot=10, r_foot=11, neck=12, l_collar=13, r_collar=14, head=15, l_shoulder=16, r_shoulder=17,
         l_elbow=18, r_elbow=19, l_wrist=20, r_wrist=21, l_index1=22, l_middle1=25, l_pinky1=28,
         r_index1=37, r_middle1=40, r_pinky1=43)

# our bone -> (SMPL-H joint whose turn it copies, SMPL-H joint its rest direction points to)
MAP = {'pelvis': ('pelvis', None), 'spine': ('spine1', 'spine3'), 'chest': ('spine3', 'neck'),
       'neck': ('neck', 'head'), 'head': ('head', None)}
for s, side in (('L', 'l'), ('R', 'r')):
    MAP.update({f'clavicle_{s}': (f'{side}_collar', f'{side}_shoulder'), f'upperarm_{s}': (f'{side}_shoulder', f'{side}_elbow'),
                f'forearm_{s}': (f'{side}_elbow', f'{side}_wrist'), f'hand_{s}': (f'{side}_wrist', f'{side}_middle1'),
                f'thigh_{s}': (f'{side}_hip', f'{side}_knee'), f'shin_{s}': (f'{side}_knee', f'{side}_ankle'),
                f'foot_{s}': (f'{side}_ankle', f'{side}_foot')})
# our bone -> our bone its rest direction points to
OUR_CHILD = {'spine': 'chest', 'chest': 'neck', 'neck': 'head'}
for s in 'LR':
    OUR_CHILD.update({f'clavicle_{s}': f'upperarm_{s}', f'upperarm_{s}': f'forearm_{s}', f'forearm_{s}': f'hand_{s}',
                      f'hand_{s}': f'fingers1_{s}', f'thigh_{s}': f'shin_{s}', f'shin_{s}': f'foot_{s}'})


def frame(a, b):
    """Rotation whose x axis is a and y axis is b made square to a."""
    a = a / np.linalg.norm(a); b = b - a * (a @ b); b /= np.linalg.norm(b)
    return R.from_matrix(np.stack([a, b, np.cross(a, b)], 1))


def mirror_q(r):  # left side rotation -> right side (reflect across x), like mirrorQ in rig.js
    x, y, z, w = r.as_quat(); return R.from_quat([x, -y, -z, w])


def mirror_v(v): return np.array([-v[0], v[1], v[2]])


def twist_about(r, axis):
    """The part of rotation r that turns about axis (swing twist split)."""
    x, y, z, w = r.as_quat(); p = axis * (axis @ np.array([x, y, z]))
    q = np.array([*p, w]); n = np.linalg.norm(q)
    return R.identity() if n < 1e-9 else R.from_quat(q / n)


class Rig:
    def __init__(self, path):
        d = json.load(open(path))
        self.names = [b['name'] for b in d['bones']]; self.parent = {b['name']: b['parent'] for b in d['bones']}
        self.piv = {b['name']: np.array(b['pivot'], float) for b in d['bones']}
        P = self.piv; S0, E0, W0 = P['upperarm_L'], P['forearm_L'], P['hand_L']
        d0 = (W0 - S0) / np.linalg.norm(W0 - S0); b0 = (E0 - S0) - d0 * (d0 @ (E0 - S0)); b0 /= np.linalg.norm(b0)
        self.h0 = np.cross(d0, b0); self.h0 /= np.linalg.norm(self.h0)        # across the palm (handle axis), left
        self.f0 = (W0 - E0) / np.linalg.norm(W0 - E0)                          # forearm direction, left
        self.scap_axis = np.array([-.57, 0, .82]) / np.linalg.norm([-.57, 0, .82])
        self.grip_in = {s: np.array([.279 if s == 'L' else -.279, .787, .056]) - P['hand_' + s] for s in 'LR'}

    def positions(self, W, root):
        """World pivot positions from world rotations W (dict of Rotation) and the pelvis position."""
        out = {}
        for n in self.names:
            p = self.parent[n]
            out[n] = root.copy() if p is None else out[p] + W[p].apply(self.piv[n] - self.piv[p])
        return out

    def grip(self, W, pos):
        """World point where the bar sits in each hand (the same point the viewer uses for dumbbells)."""
        return {s: pos['hand_' + s] + W['hand_' + s].apply(self.grip_in[s]) for s in 'LR'}

    def local(self, W):
        return {n: (W[n] if self.parent[n] is None else W[self.parent[n]].inv() * W[n]) for n in self.names}


def smpl_fk(poses, trans, J0, parents):
    T = len(poses); loc = R.from_rotvec(poses.reshape(-1, 3)).as_matrix().reshape(T, -1, 3, 3)
    G = np.zeros((T, 52, 3, 3)); P = np.zeros((T, 52, 3))
    for i in range(52):
        p = parents[i]
        if p < 0: G[:, i] = loc[:, i]; P[:, i] = J0[i] + trans
        else: G[:, i] = G[:, p] @ loc[:, i]; P[:, i] = P[:, p] + np.einsum('tij,j->ti', G[:, p], J0[i] - J0[p])
    return P, G


def swing_to(a, b):
    """Smallest rotation turning direction a onto direction b."""
    a = a / np.linalg.norm(a); b = b / np.linalg.norm(b); c = np.cross(a, b); s = np.linalg.norm(c)
    if s < 1e-9: return R.identity()
    return R.from_rotvec(c / s * np.arctan2(s, a @ b))


ARM_BELOW = ['twist', 'hand', 'fingers1', 'fingers2', 'thumb']


def hand_on_bar(rig, W, root, s, target, iters=3):
    """Two bone arm solve: move this side's grip point onto target. The elbow keeps pointing the way it did
    (its offset from the shoulder to wrist line), and the hand keeps its turn relative to the forearm.
    Changes W in place."""
    up, fo = 'upperarm_' + s, 'forearm_' + s
    for _ in range(iters):
        pos = rig.positions(W, root)
        Sp, Ep, Wp = pos[up], pos[fo], pos['hand_' + s]
        grip = rig.grip(W, pos)[s]
        Wt = Wp + (target - grip)                      # where the wrist must go
        L1, L2 = np.linalg.norm(Ep - Sp), np.linalg.norm(Wp - Ep)
        dvec = Wt - Sp; dist = np.clip(np.linalg.norm(dvec), abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4); dhat = dvec / np.linalg.norm(dvec)
        pole = (Ep - Sp) - dhat * ((Ep - Sp) @ dhat); pole /= np.linalg.norm(pole)
        ca = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist); sa = np.sqrt(max(0, 1 - ca * ca))
        E2 = Sp + dhat * L1 * ca + pole * L1 * sa; W2 = Sp + dhat * dist
        r1 = swing_to(Ep - Sp, E2 - Sp)
        W[up] = r1 * W[up]
        # forearm: after the upper arm turn, swing it onto the new elbow to wrist line
        fdir_now = r1.apply(Wp - Ep)
        r2 = swing_to(fdir_now, W2 - E2) * r1
        W[fo] = r2 * W[fo]
        for b in ARM_BELOW: W[f'{b}_{s}'] = r2 * W[f'{b}_{s}']


def com(rig, W, pos):
    """Whole body centre of mass (segment masses after Dempster / Winter)."""
    L = lambda a, b, t: pos[a] + (pos[b] - pos[a]) * t
    head = pos['head'] + W['head'].apply([0, .1, 0])
    hips = (pos['thigh_L'] + pos['thigh_R']) / 2; shos = (pos['upperarm_L'] + pos['upperarm_R']) / 2
    parts = [(.081, pos['neck'] * .3 + head * .7), (.497, (hips + shos) / 2)]
    for s in 'LR':
        toe = pos['foot_' + s] + W['foot_' + s].apply([0, -.04, .14])
        parts += [(.028, L('upperarm_' + s, 'forearm_' + s, .436)), (.016, L('forearm_' + s, 'hand_' + s, .43)),
                  (.006, L('hand_' + s, 'fingers1_' + s, .5)), (.1, L('thigh_' + s, 'shin_' + s, .433)),
                  (.0465, L('shin_' + s, 'foot_' + s, .433)), (.0145, (pos['foot_' + s] + toe) / 2)]
    return sum(m * p for m, p in parts) / sum(m for m, _ in parts)


def foot_low(rig, W, pos):
    """Lowest point of either foot (heel or toe)."""
    return min(min(pos['foot_' + s][1] - .06, (pos['foot_' + s] + W['foot_' + s].apply([0, -.04, .14]))[1]) for s in 'LR')


def report_hands(grips):
    gap = np.array([g['L'] - g['R'] for g in grips]); w = np.linalg.norm(gap, axis=1)
    drift = np.linalg.norm(gap - gap.mean(0), axis=1)
    print(f'Hands relative to each other: width {w.min() * 100:.0f} to {w.max() * 100:.0f} cm, '
          f'drift from their average {drift.max() * 100:.1f} cm max (before locking)')


BAR_AXIS = np.array([1., 0, 0])
on_bar = lambda c, width, s: c + BAR_AXIS * (width / 2 if s == 'L' else -width / 2)


def hang(rig, Ws, a):
    """Body hangs from a fixed bar. Returns world rotations, pelvis positions, equipment, a report."""
    pos0 = [rig.positions(W, rig.piv['pelvis']) for W in Ws]
    grips = [rig.grip(W, p) for W, p in zip(Ws, pos0)]
    report_hands(grips)
    mid = np.array([(g['L'] + g['R']) / 2 for g in grips])
    print(f'Grip point drift relative to the body: {np.linalg.norm(mid - mid.mean(0), axis=1).max() * 100:.0f} cm max '
          '(FlowHMR moves the hands, not the body). Locked: the body moves instead.')
    width = float(np.mean([g['L'][0] - g['R'][0] for g in grips]))
    out_W, rel, before, after, locked = [], [], [], [], []
    for t, W in enumerate(Ws):
        pos, g = pos0[t], mid[t]
        off = com(rig, W, pos) - g; before.append(off)
        # smallest turn about the grip that puts the centre of mass straight below it (front/back and sideways)
        sw = R.identity() if a.no_swing else swing_to(off, np.array([0, -1., 0]))
        W2 = {k: sw * r for k, r in W.items()}
        root = g + sw.apply(pos['pelvis'] - g)
        for s in 'LR': hand_on_bar(rig, W2, root, s, on_bar(g, width, s))  # each hand onto its own fixed spot
        p2 = rig.positions(W2, root); after.append(com(rig, W2, p2) - g)
        gr = rig.grip(W2, p2); locked.append(max(np.linalg.norm(gr[s] - on_bar(g, width, s)) for s in 'LR'))
        out_W.append(W2); rel.append(root - g)  # pelvis relative to the bar
    print(f'Hands locked to the bar: grip width {width * 100:.0f} cm, largest miss after locking {max(locked) * 1000:.1f} mm')

    def place(idx):
        """Bar height: the lowest point of the feet clears the floor by --clearance in the clip frames.
        The bar is where the grips are; the pelvis sits, on average, where our model's pelvis is (x, z)."""
        lowest = min(foot_low(rig, out_W[i], rig.positions(out_W[i], rel[i])) for i in idx)
        bar = np.array([rig.piv['pelvis'][0] - np.mean([rel[i][0] for i in idx]), a.clearance - lowest,
                        rig.piv['pelvis'][2] - np.mean([rel[i][2] for i in idx])])
        b, c = np.array(before)[idx], np.array(after)[idx]
        print('\nCentre of mass vs hands, forward (+) / back (-), in the clip frames:')
        print(f'  before the swing: {b[:, 2].min() * 100:+.0f} to {b[:, 2].max() * 100:+.0f} cm (mean {b[:, 2].mean() * 100:+.0f}), '
              f'side {b[:, 0].min() * 100:+.0f} to {b[:, 0].max() * 100:+.0f}')
        print(f'  after the swing:  {c[:, 2].min() * 100:+.0f} to {c[:, 2].max() * 100:+.0f} cm (mean {c[:, 2].mean() * 100:+.0f}), '
              f'side {c[:, 0].min() * 100:+.0f} to {c[:, 0].max() * 100:+.0f}')
        return [bar + r for r in rel], {'type': 'bar', 'at': [round(float(x), 4) for x in bar]}
    return out_W, place


def bench(rig, Ws, path, a):
    """Body lies on a bench, feet on the floor, both hands on one straight bar."""
    roots = [rig.piv['pelvis'] + p for p in path]
    pos0 = [rig.positions(W, r) for W, r in zip(Ws, roots)]
    grips = [rig.grip(W, p) for W, p in zip(Ws, pos0)]
    report_hands(grips)
    width = float(np.mean([g['L'][0] - g['R'][0] for g in grips]))
    out_W, locked = [], []
    for t, W in enumerate(Ws):
        W2 = dict(W); c = (grips[t]['L'] + grips[t]['R']) / 2  # the bar's middle follows the video's hands
        for s in 'LR': hand_on_bar(rig, W2, roots[t], s, on_bar(c, width, s))
        gr = rig.grip(W2, rig.positions(W2, roots[t])); locked.append(max(np.linalg.norm(gr[s] - on_bar(c, width, s)) for s in 'LR'))
        out_W.append(W2)
    print(f'Hands on one straight bar: grip width {width * 100:.0f} cm, largest miss after locking {max(locked) * 1000:.1f} mm')

    def place(idx):
        pos = {i: rig.positions(out_W[i], roots[i]) for i in idx}
        dy = -np.mean([foot_low(rig, out_W[i], pos[i]) for i in idx])  # one height: feet on the floor (averaged)
        pel = np.array([pos[i]['pelvis'] for i in idx]); head = np.array([pos[i]['head'] for i in idx])
        shift = np.array([-pel[:, 0].mean(), dy, BENCH_PELVIS_Z - pel[:, 2].mean()])
        out = [roots[i] + shift for i in range(len(roots))]
        top = np.mean([min(pos[i]['pelvis'][1], pos[i]['chest'][1]) for i in idx]) + dy - .1
        pz, hz = pel[:, 2].mean() + shift[2], head[:, 2].mean() + shift[2]
        z0, z1 = min(pz, hz) - .1, max(pz, hz) + .25
        # how close the bar gets to the chest (19 cm in front of the chest bone = the pecs, like fbx-to-clip.js)
        gaps, feet = [], []
        for i in idx:
            p = rig.positions(out_W[i], out[i]); g = rig.grip(out_W[i], p); bar = (g['L'] + g['R']) / 2
            gaps.append(bar[1] - (p['chest'] + out_W[i]['chest'].apply([0, 0, .19]))[1]); feet.append(foot_low(rig, out_W[i], p))
        tilt = np.degrees(np.arctan2(head[:, 1].mean() - pel[:, 1].mean(), abs(hz - pz)))
        print(f'\nBench: top at {top:.2f} m, from z {z0:.2f} to {z1:.2f}; head {"above" if tilt >= 0 else "below"} the hips by {abs(tilt):.0f} deg')
        print(f'Feet: lowest point {min(feet) * 100:+.1f} to {max(feet) * 100:+.1f} cm from the floor')
        print(f'Bar above the chest: {min(gaps) * 100:.0f} to {max(gaps) * 100:.0f} cm (negative = through the chest)')
        return out, {'type': 'barbell', 'grip': round(width, 3),
                     'bench': {'at': [round(float(-0.0), 3), round(float(top), 3), round(float((z0 + z1) / 2), 3)], 'length': round(float(z1 - z0), 3)}}
    return out_W, place


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('motion'); ap.add_argument('smplh'); ap.add_argument('out')
    ap.add_argument('--name', default='clip'); ap.add_argument('--rig', default=RIG_JSON)
    ap.add_argument('--mode', choices=['hang', 'bench'], default='hang')
    ap.add_argument('--clearance', type=float, default=.06, help='hang: feet above the floor at the lowest point (m)')
    ap.add_argument('--no-swing', action='store_true', help='hang: do not tilt the body to put its centre of mass under the bar')
    ap.add_argument('--blend', type=int, default=8, help='frames blended at the end so the clip loops')
    a = ap.parse_args()

    rig = Rig(a.rig); m = np.load(a.smplh, allow_pickle=True); d = np.load(a.motion)
    parents = m['kintree_table'][0].astype(int); parents[0] = -1
    betas = d['betas'].reshape(-1); v = m['v_template'] + m['shapedirs'][:, :, :len(betas)] @ betas
    J0 = m['J_regressor'] @ v
    Psm, Gsm = smpl_fk(d['poses'], d['trans'], J0, parents)
    T = len(Psm); fps = int(d['mocap_framerate']) if 'mocap_framerate' in d.files else 30

    print('Joint map (our bone <- SMPL-H joint):')
    for k, (j, _) in MAP.items(): print(f'  {k:12s} <- {j}')
    print('  scapula_L/R  <- none: follows how high the arm is raised (rig.js rule)')
    print('  twist_L/R    <- half the roll between forearm and hand')
    print('  fingers, thumb <- none: closed grip on the bar')
    print('  not used: SMPL-H spine2 (folded into chest), toes, all 30 finger joints')

    front = Gsm[:, 0, :, 2]  # pelvis forward per frame
    if a.mode == 'hang':
        # face +Z: turn the motion around Y by the average heading of the pelvis
        heading = np.arctan2(front[:, 0].mean(), front[:, 2].mean())
        base = R.from_rotvec([0, -heading, 0])
        print(f'\nFacing: FlowHMR body faces {np.degrees(heading):.0f} deg from +Z; turned to face +Z.')
    else:
        # lay flat on the back: hips to shoulders along -Z, chest facing up (+Y)
        torso = ((Psm[:, S['l_shoulder']] + Psm[:, S['r_shoulder']]) - (Psm[:, S['l_hip']] + Psm[:, S['r_hip']])).mean(0)
        base = frame(np.array([0, 0, -1.]), np.array([0, 1., 0])) * frame(torso, front.mean(0)).inv()
        tilt = np.degrees(np.arcsin(np.clip(torso[1] / np.linalg.norm(torso), -1, 1)))
        print(f'\nLying: FlowHMR body is {abs(tilt):.0f} deg {"head up" if tilt > 0 else "head down"} from flat; laid flat, head toward -Z.')

    # fixed offsets that line up each bone's rest direction and a second reference in both rest poses
    across = {s: J0[S[f'{sd}_index1']] - J0[S[f'{sd}_pinky1']] for s, sd in (('L', 'l'), ('R', 'r'))}
    h_ours = {'L': rig.h0, 'R': mirror_v(rig.h0)}
    align = {}
    for ours, (sj, sc) in MAP.items():
        if sc is None: align[ours] = R.identity(); continue
        arm = any(ours.startswith(p) for p in ('upperarm', 'forearm', 'hand'))
        s = ours[-1]
        ref_s = across[s] if arm else np.array([0, 0, 1.])
        ref_o = h_ours[s] if arm else np.array([0, 0, 1.])
        if ours.startswith('foot'): ref_s = ref_o = np.array([0, 1., 0])
        d_src = J0[S[sc]] - J0[S[sj]]
        d_our = (rig.piv[OUR_CHILD[ours]] - rig.piv[ours]) if ours in OUR_CHILD else \
            (rig.piv[ours] + np.array([0, -.06, .14]) - rig.piv[ours])  # foot: ankle to toe
        align[ours] = frame(d_src, ref_s) * frame(d_our, ref_o).inv()

    G = {k: R.from_matrix(Gsm[:, S[j]]) for k, (j, _) in MAP.items()}
    f0 = {'L': rig.f0, 'R': mirror_v(rig.f0)}
    side = lambda s, r: r if s == 'L' else mirror_q(r)
    aa = lambda s, ax, ang: side(s, R.from_rotvec(np.asarray(ax) * ang))

    def pose(t):
        W = {k: base * G[k][t] * align[k] for k in MAP}
        chest_inv = W['chest'].inv()
        for s in 'LR':
            fwr, hw = W['forearm_' + s], W['hand_' + s]
            W['twist_' + s] = fwr * Slerp([0, 1], R.concatenate([R.identity(), twist_about(fwr.inv() * hw, f0[s])]))([.5])[0]
            # shoulder blade: rotates up with the arm (rig.js girdle rule), measured against the chest
            u = chest_inv.apply(W['upperarm_' + s].apply(rig.piv['forearm_' + s] - rig.piv['upperarm_' + s]))
            elev = np.arccos(np.clip(-u[1] / np.linalg.norm(u), -1, 1))
            up = np.clip((elev - 30 * DEG) / 4.5, 0, 24 * DEG)
            W['scapula_' + s] = W['clavicle_' + s] * side(s, R.from_rotvec(rig.scap_axis * up))
            W['fingers1_' + s] = hw * aa(s, rig.h0, -72 * DEG)
            W['fingers2_' + s] = W['fingers1_' + s] * aa(s, rig.h0, -88 * DEG)
            W['thumb_' + s] = hw * aa(s, rig.f0, -38 * DEG) * aa(s, rig.h0, -30 * DEG)
        return W

    Ws = [pose(t) for t in range(T)]
    if a.mode == 'hang':
        out_W, place = hang(rig, Ws, a)
    else:
        path = base.apply(Psm[:, 0] - Psm[:, 0].mean(0))  # FlowHMR's pelvis path, turned like the bones
        out_W, place = bench(rig, Ws, path, a)

    # reps from the elbow bend. "bottom" = where a rep starts: arms straight when hanging, bar on the chest on a bench
    def elbow(W, pos):
        e = 0
        for s in 'LR':
            u = pos['upperarm_' + s] - pos['forearm_' + s]; v = pos['hand_' + s] - pos['forearm_' + s]
            e += np.degrees(np.arccos(u @ v / np.linalg.norm(u) / np.linalg.norm(v))) / 2
        return e
    el = np.array([elbow(W, rig.positions(W, np.zeros(3))) for W in out_W])
    low = el if a.mode == 'hang' else -el          # high = bottom of the rep
    tops, _ = find_peaks(-low, distance=fps // 2, prominence=20)
    if not len(tops): sys.exit('no rep found (elbows never bend and straighten)')
    near = [i for i in range(T) if low[i] >= low.max() - 3]  # frames within 3 degrees of the bottom
    start = max([i for i in near if i < tops[0]], default=0)
    after_last = [i for i in near if i > tops[-1]]
    end = max(after_last) if after_last else max(i for i in near if i < tops[-1])
    tops = [t for t in tops if start < t < end]
    print(f'\nCut: frames {start} to {end} ({(end - start + 1) / fps:.1f} s, {len(tops)} rep(s); tops at {[int(t) for t in tops]})')
    idx = list(range(start, end + 1)); n = len(idx)
    roots_all, equipment = place(idx)

    # blend the last frames into the first so it loops
    rots = {k: [out_W[i][k] for i in idx] for k in rig.names}
    roots = [roots_all[i].copy() for i in idx]
    nb = min(a.blend, n // 4)
    for j in range(nb):
        i = n - nb + j; w = (j + 1) / (nb + 1); w = w * w * (3 - 2 * w)
        for k in rig.names:
            rots[k][i] = Slerp([0, 1], R.concatenate([rots[k][i], rots[k][0]]))([w])[0]
        roots[i] = roots[i] * (1 - w) + roots[0] * w

    # lifting: from each bottom to the next top; progress 0 at the bottom, 1 at the top
    e = low[idx]; tops_c = [int(t - start) for t in tops]
    lift = [0] * n; b0 = 0
    for t in tops_c:
        b = b0 + int(np.argmax(e[b0:t + 1]))
        for i in range(b, t + 1): lift[i] = 1
        b0 = t
    prog = [float(np.clip((e.max() - x) / max(1e-3, e.max() - e.min()), 0, 1)) for x in e]

    names = [k for k in rig.names if any(abs(rig.local({kk: rots[kk][i] for kk in rig.names})[k].as_quat()[3]) < .99999 for i in range(0, n, 5))]
    frames_out, root_out = [], []
    for i in range(n):
        L = rig.local({k: rots[k][i] for k in rig.names})
        frames_out.append([round(float(x), 5) for k in names for x in L[k].as_quat()])
        root_out.append([round(float(x), 4) for x in roots[i] - rig.piv['pelvis']])
    src = a.motion.replace('\\', '/').split('/')
    clip = {'format': 'muscle-clip', 'version': 1, 'name': a.name, 'fps': fps, 'frames': n, 'bones': names,
            'progress': [round(p, 4) for p in prog], 'lifting': lift, 'rotations': frames_out,
            'source': {'flowhmr': src[-2] if len(src) > 1 else src[-1], 'frames': [int(start), int(end)]},
            'equipment': equipment, 'root': root_out}
    json.dump(clip, open(a.out, 'w'), separators=(',', ':'))
    print(f'Wrote {a.out}: {n} frames, {len(names)} bones, equipment {equipment}')


if __name__ == '__main__':
    main()
