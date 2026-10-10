"""Bake a skeleton and skin weights for muscles.json.

Writes rig.json (bones) and rig.bin (per vertex skin indices, weights and a
belly factor used for the contraction bulge). muscles.json is not changed.

Run from the project folder (needs numpy and scipy):
    python prototype/tools/bake_rig.py muscles.json prototype
"""
import sys, json, struct, base64
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def load(path):
    d = json.load(open(path)); b = base64.b64decode(d['glb'])
    l = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + l])
    off = 20 + l; bl = struct.unpack('<I', b[off:off + 4])[0]; bin_ = b[off + 8:off + 8 + bl]

    def acc(i):
        a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]
        dt = np.dtype(CT[a['componentType']]); n = NC[a['type']]
        start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = bv.get('byteStride', dt.itemsize * n)
        raw = np.frombuffer(bin_, dtype=np.uint8, count=stride * (a['count'] - 1) + dt.itemsize * n, offset=start)
        arr = np.lib.stride_tricks.as_strided(raw, shape=(a['count'], dt.itemsize * n), strides=(stride, 1)).copy()
        arr = arr.view(dt).reshape(a['count'], n).astype(np.float64)
        if a.get('normalized'):
            arr = {np.dtype(np.int8): lambda x: np.maximum(x / 127, -1), np.dtype(np.uint8): lambda x: x / 255,
                   np.dtype(np.int16): lambda x: np.maximum(x / 32767, -1), np.dtype(np.uint16): lambda x: x / 65535}[dt](arr)
        return arr

    out = []
    for n in j['nodes']:
        if 'mesh' not in n: continue
        p = j['meshes'][n['mesh']]['primitives'][0]
        s = np.array(n.get('scale', [1, 1, 1])); t = np.array(n.get('translation', [0, 0, 0]))
        out.append(dict(name=n['name'], extras=n.get('extras', {}), pos=acc(p['attributes']['POSITION']) * s + t,
                        idx=acc(p['indices']).astype(np.int64).ravel(), col=acc(p['attributes']['COLOR_0'])))
    return out


def components(pos, idx):
    q = np.round(pos / 1e-5).astype(np.int64)
    _, inv = np.unique(q, axis=0, return_inverse=True); inv = inv.ravel()
    t = inv[idx.reshape(-1, 3)]; n = inv.max() + 1
    r = np.concatenate([t[:, 0], t[:, 1], t[:, 2]]); c = np.concatenate([t[:, 1], t[:, 2], t[:, 0]])
    k, lab = connected_components(coo_matrix((np.ones(len(r)), (r, c)), shape=(n, n)), directed=False)
    return k, lab[inv], inv, t


def sphere(p):
    A = np.c_[2 * p, np.ones(len(p))]; b = (p ** 2).sum(1)
    s = np.linalg.lstsq(A, b, rcond=None)[0]; return s[:3]


meshes = load(sys.argv[1]); OUT = sys.argv[2]
BONES = next(m for m in meshes if m['name'] == 'bones')
bk, blab, _, _ = components(BONES['pos'], BONES['idx'])
binfo = [(c, (blab == c).sum(), BONES['pos'][blab == c].mean(0)) for c in range(bk)]


def comp_near(pt, minn=30):
    pt = np.array(pt)
    return min((np.linalg.norm(m - pt), c) for c, n, m in binfo if n >= minn)[1]


def bv(c): return BONES['pos'][blab == c]

# ---- joint centres measured from the bone geometry (left side, mirrored for right)
ID = {k: comp_near(v) for k, v in dict(humerus=(.195, 1.241, -.03), ulna=(.228, 1.004, -.023), radius=(.257, .96, -.006),
                                        clavicle=(.08, 1.403, .002), scapula=(.122, 1.365, -.06), femur=(.091, .653, -.02),
                                        tibia=(.075, .29, -.035)).items()}
h = bv(ID['humerus']); shoulder = sphere(h[h[:, 1] > 1.33])
d = h[h[:, 1] < 1.13]; elbow = (d.min(0) + d.max(0)) / 2
rad = bv(ID['radius'])
carp = np.concatenate([bv(c) for c, n, m in binfo if m[0] > .2 and .82 < m[1] < .86])
wrist = (carp.mean(0) + rad[rad[:, 1] < .87].mean(0)) / 2
f = bv(ID['femur']); hip = sphere(f[(f[:, 1] > .83) & (f[:, 0] < .1)])
t = bv(ID['tibia']); knee = (f[f[:, 1] < .47].mean(0) + t[t[:, 1] > .40].mean(0)) / 2
ankle = t[t[:, 1] < .1].mean(0) + np.array([0, -.02, 0])
cl = bv(ID['clavicle']); sc = cl[cl[:, 0] < .03].mean(0); ac = cl[cl[:, 0] > .14].mean(0)


def hand_part(c, m):
    # left hand bones by height along the hanging hand (fingers point down, palm faces +z)
    x, y, z = abs(m[0]), m[1], m[2]
    if x > .31 and z > .05 and y > .765: return 'thumb'
    if y > .785: return 'hand'
    if y > .74: return 'fingers1'
    return 'fingers2'


def top_of(parts, frac=.2):
    p = np.concatenate([bv(c) for c, n, m in binfo if m[0] > .2 and m[1] < .87 and hand_part(c, m) == parts])
    return p[p[:, 1] >= np.quantile(p[:, 1], 1 - frac)].mean(0)


mcp, pip, thumb_piv = top_of('fingers1'), top_of('fingers2'), top_of('thumb', .3)
twist_piv = (elbow + wrist) / 2

M = np.array([-1, 1, 1])  # mirror x
pivots = {'pelvis': np.array([0, .95, -.03]), 'spine': np.array([0, 1.0, -.05]), 'chest': np.array([0, 1.16, -.06]),
          'neck': np.array([0, 1.44, -.045]), 'head': np.array([0, 1.55, -.02])}
scap_c = bv(ID['scapula']).mean(0)
side_piv = dict(clavicle=sc, scapula=scap_c, upperarm=shoulder, forearm=elbow, twist=twist_piv, hand=wrist, fingers1=mcp, fingers2=pip,
                thumb=thumb_piv, thigh=hip, shin=knee, foot=ankle)
for k, v in side_piv.items():
    v = v.copy(); v[0] = abs(v[0])
    pivots[k + '_L'] = v; pivots[k + '_R'] = v * M
parent = {'pelvis': None, 'spine': 'pelvis', 'chest': 'spine', 'neck': 'chest', 'head': 'neck'}
for s in 'LR':
    parent.update({f'clavicle_{s}': 'chest', f'scapula_{s}': f'clavicle_{s}', f'upperarm_{s}': f'scapula_{s}',
                   f'forearm_{s}': f'upperarm_{s}', f'twist_{s}': f'forearm_{s}', f'hand_{s}': f'twist_{s}',
                   f'fingers1_{s}': f'hand_{s}', f'fingers2_{s}': f'fingers1_{s}', f'thumb_{s}': f'hand_{s}', f'thigh_{s}': 'pelvis',
                   f'shin_{s}': f'thigh_{s}', f'foot_{s}': f'shin_{s}'})
names = list(parent.keys()); BI = {n: i for i, n in enumerate(names)}
children = {n: [c for c in names if parent[c] == n] for n in names}

# ---- assign every real bone (206 components) to a rig bone
lat = {ID['clavicle']: 'clavicle', ID['scapula']: 'scapula', ID['humerus']: 'upperarm', ID['ulna']: 'forearm',
       ID['radius']: 'forearm', ID['femur']: 'thigh'}
mirror_ids = {}
for c, n, m in binfo:  # find mirrored partners of the named left bones
    for lc, nm in list(lat.items()):
        lm = BONES['pos'][blab == lc].mean(0)
        if abs(m[0] + lm[0]) < 2e-3 and np.linalg.norm(m[1:] - lm[1:]) < 3e-3 and n == (blab == lc).sum() and c != lc:
            mirror_ids[c] = nm
lat.update(mirror_ids)


def classify_bone(c, m):
    s = 'L' if m[0] > 0 else 'R'
    if c in lat: return lat[c] + '_' + s
    x, y, z = m
    if abs(x) < .03:
        if z < 0:
            return 'neck' if y > 1.44 else 'chest' if y > 1.12 else 'spine' if y > .95 else 'pelvis'
        return 'head' if y > 1.50 else 'neck' if y > 1.43 else 'chest'
    if abs(x) > .2 and y < .87: return hand_part(c, m) + '_' + s
    if y > 1.50: return 'head'
    if y > 1.43: return 'neck'
    if y > .99: return 'chest'
    if y > .75: return 'pelvis'
    if y > .5: return 'thigh_' + s
    if y > .1: return 'shin_' + s
    return 'foot_' + s


bone_of_comp = {c: classify_bone(c, m) for c, n, m in binfo}
# point clouds per rig bone: real bone surface plus a few samples along the bone axis
clouds = {n: [] for n in names}
for c, n, m in binfo: clouds[bone_of_comp[c]].append(bv(c))
for n in names:
    a = pivots[n]; kids = children[n]
    b = pivots[kids[0]] if kids else a + np.array([0, .08 if n == 'head' else -.06, 0])
    if n in ('pelvis',): b = pivots['spine']
    if n == 'chest': b = pivots['neck']
    if n.startswith('clavicle'): b = pivots['scapula_' + n[-1]]
    if n.startswith('twist'): continue
    if n.startswith('hand'): b = pivots['fingers1_' + n[-1]]
    if n.startswith('fingers1'): b = pivots['fingers2_' + n[-1]]
    if n.startswith('fingers2'): b = a + np.array([0, -.03, .012])
    if n.startswith('thumb'): b = a + np.array([0, -.045, .02]) * np.array([1, 1, 1])
    if n.startswith('foot'): b = a + np.array([0, -.05, .12])
    clouds[n].append(a + (b - a) * np.linspace(0, 1, 12)[:, None])
trees = {n: cKDTree(np.concatenate(clouds[n])) for n in names if clouds[n]}

# ---- which rig bones each clickable muscle may follow (left names; side added below)
ARM = ['upperarm', 'forearm']
ALLOW = {
    'chest': ['chest', 'clavicle', 'upperarm'], 'shoulders': ['clavicle', 'scapula', 'upperarm'],
    'biceps/long_head': ['scapula', 'upperarm', 'forearm'], 'biceps/short_head': ['scapula', 'upperarm', 'forearm'],
    'biceps/brachialis': ARM, 'triceps/long_head': ['scapula', 'upperarm', 'forearm'], 'triceps/lateral_head': ARM,
    'triceps/medial_head': ARM, 'forearms': ['upperarm', 'forearm', 'hand', 'fingers1', 'fingers2', 'thumb'],
    'traps': ['neck', 'head', 'chest', 'clavicle', 'scapula'], 'lats': ['pelvis', 'spine', 'chest', 'scapula', 'upperarm'],
    'rotator_cuff': ['scapula', 'upperarm'], 'serratus': ['chest', 'scapula'], 'neck': ['chest', 'neck', 'head', 'clavicle'],
    'abs': ['pelvis', 'spine', 'chest'], 'obliques': ['pelvis', 'spine', 'chest'],
    'lower_back': ['pelvis', 'spine', 'chest', 'neck'], 'glutes': ['pelvis', 'thigh'],
    'hip_flexors': ['spine', 'pelvis', 'thigh', 'shin'], 'adductors': ['pelvis', 'thigh', 'shin'],
    'quads/rectus_femoris': ['pelvis', 'thigh', 'shin'], 'quads': ['thigh', 'shin'], 'hamstrings': ['pelvis', 'thigh', 'shin'],
    'calves': ['thigh', 'shin', 'foot'], 'shins': ['shin', 'foot'],
}
SIDED = {'clavicle', 'scapula', 'upperarm', 'forearm', 'hand', 'fingers1', 'fingers2', 'thumb', 'thigh', 'shin', 'foot'}


def sided(lst, s): return [b + '_' + s if b in SIDED else b for b in lst]


# Weights fall off with distance to each allowed bone as 1/d^p. A low power spreads the
# hand-over across the whole muscle (torso and girdle muscles stretch evenly between their
# attachments); a high power keeps limb muscles rigid on their bone and blends only at the joint.
POWER = {'traps': 2, 'lats': 2, 'serratus': 2, 'lower_back': 2, 'neck': 2.5, 'abs': 2, 'obliques': 2,
         'chest': 2.5, 'shoulders': 3, 'rotator_cuff': 3, 'glutes': 3, 'hip_flexors': 3, 'adductors': 3}
DEFAULT_POWER = 5


def soft_weights(pos, allowed, power):
    D = np.stack([trees[b].query(pos)[0] for b in allowed], 1)
    W = 1 / (D + .003) ** power
    return W / W.sum(1, keepdims=True), D.min(1)


def adjacency(tri, nverts):
    r = np.concatenate([tri[:, 0], tri[:, 1], tri[:, 2], tri[:, 1], tri[:, 2], tri[:, 0]])
    c = np.concatenate([tri[:, 1], tri[:, 2], tri[:, 0], tri[:, 0], tri[:, 1], tri[:, 2]])
    A = coo_matrix((np.ones(len(r)), (r, c)), shape=(nverts, nverts)).tocsr(); A.data[:] = 1
    return A, np.maximum(np.asarray(A.sum(1)).ravel(), 1)


def smooth(W, tri, nverts, iters, anchor=None):
    """Diffuse weights over the surface; vertices lying on a bone keep part of their own weights."""
    A, deg = adjacency(tri, nverts); W0 = W.copy()
    for _ in range(iters):
        W = .5 * W + .5 * (A @ W) / deg[:, None]
        if anchor is not None: W = W * (1 - anchor[:, None]) + W0 * anchor[:, None]
    return W / np.maximum(W.sum(1, keepdims=True), 1e-9)


def welded(values, inv, size):
    out = np.zeros((size,) + values.shape[1:]); np.add.at(out, inv, values)
    return out / np.bincount(inv, minlength=size).reshape((-1,) + (1,) * (values.ndim - 1))


def anchor_of(dmin): return np.clip(1 - dmin / .012, 0, 1) * .35


blob = bytearray(); meta = {}; done_pos = []; done_w = []
meshes.sort(key=lambda m: m['extras'].get('kind') == 'bones')
for m in meshes:
    pos, ex = m['pos'], m['extras']; n = len(pos)
    full = np.zeros((n, len(names)))
    if ex.get('kind') == 'bones':
        # Bones copy the weights of the nearest muscle surface, so they move with whatever covers
        # them and never poke through. Bones deep under thick muscle keep part of their own bone.
        for c in range(bk): full[blab == c, BI[bone_of_comp[c]]] = 1
        MP = np.concatenate(done_pos); MW = np.concatenate(done_w)
        d, j = cKDTree(MP).query(pos, k=6)
        iw = 1 / (d + .002) ** 2; tw = (MW[j] * iw[..., None]).sum(1) / iw.sum(1, keepdims=True)
        mix = np.clip(1 - (d[:, 0] - .008) / .03, 0, 1)[:, None]
        full = full * (1 - mix) + tw * mix
    elif ex.get('kind') == 'clickable':
        key = ex['group'] + '/' + ex['part']
        allowed = sided(ALLOW.get(key, ALLOW.get(ex['group'])), ex['side'])
        k, lab, inv, tri = components(pos, m['idx']); nu = inv.max() + 1
        Wd, dmin = soft_weights(pos, allowed, POWER.get(ex['group'], DEFAULT_POWER))
        Wu = smooth(welded(Wd, inv, nu), tri, nu, 8, anchor_of(welded(dmin, inv, nu)))
        for i, b in enumerate(allowed): full[:, BI[b]] = Wu[inv][:, i]
    else:  # static muscles: each piece may follow the bones it lies close to
        k, lab, inv, tri = components(pos, m['idx']); nu = inv.max() + 1
        tn = [b for b in names if b in trees]
        allD = np.stack([trees[b].query(pos)[0] for b in tn], 1)
        dmin_all = allD.min(1)
        for c in range(k):
            sel = lab == c
            close = ((allD[sel] < dmin_all[sel, None] + .025).mean(0) > .08)
            main = tn[np.bincount(allD[sel].argmin(1), minlength=len(tn)).argmax()]
            allowed = [b for b, ok in zip(tn, close) if ok] or [main]
            # pieces on one side of the body never follow the other side
            sx = np.sign(pos[sel, 0].mean()) if abs(pos[sel, 0].mean()) > .02 else 0
            if sx: allowed = [b for b in allowed if not b.endswith('_R' if sx > 0 else '_L')] or [main]
            Wd, _ = soft_weights(pos[sel], allowed, 3)
            for i, b in enumerate(allowed): full[sel, BI[b]] = Wd[:, i]
        full = smooth(welded(full, inv, nu), tri, nu, 8, anchor_of(welded(dmin_all, inv, nu)))[inv]
    if ex.get('kind') != 'bones':
        # Smoothing can carry a far bone's weight along a long thin strip (a tendon running down the
        # shin got the foot's weight 20 cm up and stuck out when the ankle bent). Leg bones only
        # reach 5 cm past the nearest bone.
        tn = [b for b in names if b in trees]; D = np.stack([trees[b].query(pos)[0] for b in tn], 1); dm = D.min(1)
        for i, b in enumerate(tn):
            if b.split('_')[0] in ('thigh', 'shin', 'foot'): full[D[:, i] > dm + .05, BI[b]] = 0
        empty = full.sum(1) < 1e-6
        full[empty, [BI[tn[j]] for j in D[empty].argmin(1)]] = 1
        full /= full.sum(1, keepdims=True)
    # forearm twist: the wrist end of the forearm turns with the hand (pronation), the elbow end does not
    for s in 'LR':
        E, Wr = pivots['forearm_' + s], pivots['hand_' + s]; ax = Wr - E
        t = np.clip((pos - E) @ ax / (ax @ ax), 0, 1); f = t * t * (3 - 2 * t)
        f = np.clip((t - .08) / .87, 0, 1); f = f * f * (3 - 2 * f)
        moved = full[:, BI['forearm_' + s]] * f
        full[:, BI['forearm_' + s]] -= moved; full[:, BI['twist_' + s]] += moved
    if ex.get('kind') != 'bones': done_pos.append(pos); done_w.append(full.copy())
    # top 4 influences, quantised to bytes summing to 255
    order = np.argsort(-full, 1)[:, :4]; w = np.take_along_axis(full, order, 1)
    w = w / w.sum(1, keepdims=True); q = np.floor(w * 255).astype(np.int64)
    q[:, 0] += 255 - q.sum(1)
    # belly factor: position along the mean fibre direction, peaking mid muscle; zero on tendon and bone
    belly = np.zeros(n)
    if ex.get('kind') == 'clickable':
        fib = m['col'][:, :3] * 2 - 1; kind = m['col'][:, 3]
        axis = fib[kind < .25].mean(0); axis /= np.linalg.norm(axis) + 1e-9
        tt = pos @ axis; lo, hi = np.percentile(tt, [4, 96]); tt = np.clip((tt - lo) / (hi - lo + 1e-9), 0, 1)
        belly = np.sin(np.pi * tt) ** 1.4 * np.clip(1 - kind * 2.2, 0, 1)
    off = len(blob)
    blob += order.astype(np.uint8).tobytes() + q.astype(np.uint8).tobytes() + np.round(belly * 255).astype(np.uint8).tobytes()
    meta[m['name']] = dict(offset=off, count=n)
    if ex.get('kind') == 'clickable':
        # Attachment line: origin, middle of the belly and insertion, each fixed to the bone it sits
        # on. The page measures this line's length every frame; a muscle that gets shorter is
        # contracting. Fixed points (not the soft skin weights) give the real anatomical change.
        line = []
        for c in (0, .5, 1):
            sel = (tt <= .03) if c == 0 else (tt >= .97) if c == 1 else (np.abs(tt - c) < .08)
            if sel.sum() < 3: sel = np.argsort(np.abs(tt - c))[:12]
            p = pos[sel].mean(0)
            near = allowed[int(np.argmin([trees[b].query(p)[0] for b in allowed]))]
            line.append([round(float(x), 5) for x in p] + [BI[near], 0, 0, 0, 1, 0, 0, 0])
        # Elbow, shoulder and knee tendons: the mesh ends stop short of where the tendon really attaches,
        # so these use anatomical landmarks measured from the joint centres instead.
        sd = ex['side']; mx = 1 if sd == 'L' else -1
        E, Wr, S = pivots['forearm_' + sd], pivots['hand_' + sd], pivots['upperarm_' + sd]
        fa = (Wr - E) / np.linalg.norm(Wr - E); ant = np.array([0, 0, 1.]); up = np.array([0, 1., 0]); med = np.array([-mx, 0, 0.])
        LAND = {  # landmark: (position, bone)
            'radial_tuberosity': (E + fa * .035 + ant * .012, 'forearm'), 'ulna_coronoid': (E + fa * .028 + ant * .008, 'forearm'),
            'olecranon': (E - ant * .022 + fa * .004, 'forearm'), 'supraglenoid': (S + up * .025 + ant * .005, 'scapula'),
            'coracoid': (S + ant * .03 + med * .022 + up * .012, 'scapula'), 'infraglenoid': (S - up * .03 - ant * .012, 'scapula'),
            # kneecap: the quads wrap over the front of the knee, so their line ends in front of it and
            # moves with the shin (through the kneecap ligament); a straight line to the shin cuts behind
            # the knee when it bends and hardly changes length
            'patella': (pivots['shin_' + sd] + ant * .06 + up * .01, 'shin'),
        }
        ATTACH = {  # which landmark replaces the end nearest to it
            'biceps/long_head': ['radial_tuberosity', 'supraglenoid'], 'biceps/short_head': ['radial_tuberosity', 'coracoid'],
            'biceps/brachialis': ['ulna_coronoid'], 'triceps/long_head': ['olecranon', 'infraglenoid'],
            'triceps/lateral_head': ['olecranon'], 'triceps/medial_head': ['olecranon'],
            'quads/rectus_femoris': ['patella'], 'quads/vastus_lateralis': ['patella'], 'quads/vastus_medialis': ['patella'],
        }
        for lm in ATTACH.get(key, []):
            p, bn = LAND[lm]; end = 0 if np.linalg.norm(np.array(line[0][:3]) - p) < np.linalg.norm(np.array(line[2][:3]) - p) else 2
            line[end][:3] = [round(float(x), 5) for x in p]; line[end][3] = BI[bn + '_' + sd]
        # attachments the nearest bone test gets wrong (they sit over ribs or shin but pull on another bone)
        fix = {'serratus/serratus': 'scapula', 'calves/soleus': 'foot', 'biceps/short_head': 'forearm'}.get(key)
        if fix:
            fb = sided([fix], ex['side'])[0]; tree = trees[fb]
            end = 0 if tree.query(line[0][:3])[0] < tree.query(line[2][:3])[0] else 2
            line[end][3] = BI[fb]
        meta[m['name']]['line'] = line

rig = dict(bones=[dict(name=n, parent=parent[n], pivot=[round(float(x), 5) for x in pivots[n]]) for n in names], meshes=meta,
           layout='per mesh: skinIndex u8[count*4], skinWeight u8[count*4] (sum 255), belly u8[count]')
json.dump(rig, open(OUT + '/rig.json', 'w'), indent=1)
open(OUT + '/rig.bin', 'wb').write(bytes(blob))
print('bones', len(names), 'bytes', len(blob))
for n in names: print(n, np.round(pivots[n], 3), parent[n])
