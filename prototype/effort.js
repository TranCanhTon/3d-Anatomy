import * as THREE from 'three';

// Works out which muscles are working by measuring them.
//
// Every muscle has an attachment line baked into rig.json: origin, middle of the belly and
// insertion, each fixed to the bone it sits on. Each frame we measure how long that line is.
//   bulge  = how much shorter the muscle is right now than at rest
//   effort = how much it shortens while the weight goes up (the lifting half of the rep)
// A muscle that shortens while lifting is the one doing the work; one that gets longer is
// being stretched. The score blends how much of its own range a muscle uses (found by sweeping
// the joints once at load, fair to short levers like the triceps) with how many centimetres it
// actually shortens from the start of the lift to the top. Muscles that work without changing length (grip, core bracing) can be added by
// hand with an exercise's extraEffort.

const MIN_SHORTEN = .012; // less than 1.2% shorter during the lift counts as not working
const MIN_RELATIVE = .15; // muscles under 15% of the top muscle's effort are dropped
const DEG = Math.PI / 180;

export class MuscleTracker {
  constructor(rig) {
    this.rig = rig; this.lines = new Map(); // "group/part" -> [{points, bones}] (left and right)
    for (const [name, meta] of Object.entries(rig.data.meshes)) {
      if (!meta.line) continue;
      const [group, part] = name.split('__'), key = group + '/' + part;
      const line = { points: meta.line.map((l) => new THREE.Vector3(l[0], l[1], l[2])), bones: meta.line.map((l) => l[3]), side: name.slice(-1) };
      line.world = line.points.map((p) => p.clone()); // where the points are right now (for the X-ray view)
      if (!this.lines.has(key)) this.lines.set(key, []);
      this.lines.get(key).push(line);
    }
    this.tmp = new THREE.Vector3(); this.prev = new THREE.Vector3(); this.m = new THREE.Matrix4();
    rig.reset(); rig.apply(); this.rest = this.measure();
    this.calibrate(); this.now = this.rest;
  }

  // Length of every muscle's attachment line in the current pose (left and right averaged).
  measure() {
    const sk = this.rig.skeleton, out = new Map();
    for (const [key, lines] of this.lines) {
      let total = 0;
      for (const line of lines) {
        for (let i = 0; i < line.points.length; i++) {
          const b = line.bones[i];
          this.m.multiplyMatrices(sk.bones[b].matrixWorld, sk.boneInverses[b]);
          this.tmp.copy(line.points[i]).applyMatrix4(this.m); line.world[i].copy(this.tmp);
          if (i) total += this.tmp.distanceTo(this.prev);
          this.prev.copy(this.tmp);
        }
      }
      out.set(key, total / lines.length);
    }
    return out;
  }

  // Sweep the joints through their range once to find how short and long each muscle can get.
  calibrate() {
    this.shortest = new Map(this.rest); this.longest = new Map(this.rest);
    const note = () => {
      for (const [k, l] of this.measure()) { this.shortest.set(k, Math.min(this.shortest.get(k), l)); this.longest.set(k, Math.max(this.longest.get(k), l)); }
    };
    // arms
    for (const shoulderFlex of [-40, 0, 60, 120, 175]) for (const shoulderAbd of [0, 45, 90, 170])
      for (const elbow of [0, 70, 140]) for (const pron of [0, 90]) {
        this.rig.reset(); this.rig.arms({ shoulderFlex: shoulderFlex * DEG, shoulderAbd: shoulderAbd * DEG, elbow: elbow * DEG, pron: pron * DEG }); this.rig.apply(); note();
      }
    // legs and spine (both sides together): hip bend and spread, knee, ankle, trunk bend
    const X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1), q = (ax, a) => new THREE.Quaternion().setFromAxisAngle(ax, a);
    const mirror = (r) => new THREE.Quaternion(r.x, -r.y, -r.z, r.w);
    for (const hip of [-20, 0, 50, 100, 130]) for (const spread of [0, 35]) for (const knee of [0, 70, 140]) for (const ankle of [-25, 25]) for (const trunk of [-20, 0, 45]) {
      const r = this.rig; r.reset();
      r.world.spine = q(X, trunk * DEG * .5); r.world.chest = q(X, trunk * DEG);
      const thigh = q(Z, spread * DEG).multiply(q(X, -hip * DEG)), shin = thigh.clone().multiply(q(X, knee * DEG)), foot = shin.clone().multiply(q(X, -ankle * DEG));
      for (const [s, f] of [['L', (x) => x], ['R', mirror]]) { r.world['thigh_' + s] = f(thigh); r.world['shin_' + s] = f(shin); r.world['foot_' + s] = f(foot); }
      r.apply(); note();
    }
    this.rig.reset(); this.rig.apply();
  }

  // how much a muscle can shorten in total, as a length
  range(key) { return Math.max(this.longest.get(key) - this.shortest.get(key), this.rest.get(key) * .03); }

  update() { this.now = this.measure(); return this.now; }

  // 0 at rest length or longer, 1 at the shortest this muscle gets.
  bulge(key) {
    const r = this.rest.get(key), l = this.now.get(key);
    return r ? THREE.MathUtils.clamp((r - l) / Math.max(r - this.shortest.get(key), r * .03), 0, 1) : 0;
  }

  // Plays through the lifting half of a rep and scores each muscle by how much it shortens.
  // `poseAt(i)` puts the rig in the i-th lifting sample; samples run from the start of the lift to the top.
  analyze(count, poseAt, extra = {}, targets = null) {
    let start = null, end = null;
    for (let i = 0; i < count; i++) { poseAt(i); const len = this.measure(); if (!start) start = len; end = len; }
    if (targets && (targets.primary || []).length) return this.fromTargets(targets, start, end, extra);
    const shorten = new Map(); let top = 0;
    for (const [k, l0] of start) {
      // net change from the start of the lift to the top (a brief dip on the way does not count)
      const d = l0 - end.get(k); if (d / this.rest.get(k) < MIN_SHORTEN) continue;
      // blend: share of its own range used (fair to short levers like the triceps) and how far it
      // actually shortened in centimetres (so big movers like the lats rank above small muscles)
      const s = Math.sqrt(Math.min(1, d / this.range(k)) * d);
      shorten.set(k, s); top = Math.max(top, s);
    }
    const effort = {};
    for (const [k, s] of shorten) if (s / top >= MIN_RELATIVE) effort[k] = +(s / top).toFixed(2);
    for (const [k, v] of Object.entries(extra)) effort[k] = Math.max(effort[k] || 0, v);
    this.raw = Object.fromEntries([...shorten].map(([k, s]) => [k, +s.toFixed(3)]));
    return effort;
  }

  // Effort from the exercise's listed muscles (free-exercise-db names). Primary muscles score 1,
  // secondary .55. Inside a group the motion decides the split: the part that shortens most
  // during the lift gets the full score, the rest down to half of it.
  fromTargets(targets, start, end, extra) {
    const effort = {}, net = new Map();
    for (const [k, l0] of start) net.set(k, Math.max(0, (l0 - end.get(k)) / this.range(k)));
    const add = (names, w) => {
      for (const n of names) {
        const parts = (DB_MUSCLES[n] || []).filter((k) => this.lines.has(k)); if (!parts.length) continue;
        const top = Math.max(...parts.map((k) => net.get(k)));
        for (const k of parts) effort[k] = Math.max(effort[k] || 0, +(w * (top > .02 ? .5 + .5 * net.get(k) / top : .8)).toFixed(2));
      }
    };
    add(targets.secondary || [], .55); add(targets.primary, 1);
    for (const [k, v] of Object.entries(extra)) effort[k] = Math.max(effort[k] || 0, v);
    this.raw = Object.fromEntries([...net].filter(([, v]) => v > 0).map(([k, v]) => [k, +v.toFixed(3)]));
    return effort;
  }
}

// free-exercise-db muscle names -> the model's muscles. (muscles.json swaps the trap labels:
// its traps/lower is the real upper trap, traps/upper the real lower trap.)
export const DB_MUSCLES = {
  abdominals: ['abs/abs', 'obliques/obliques'],
  abductors: ['glutes/medius'],
  adductors: ['adductors/adductors'],
  biceps: ['biceps/long_head', 'biceps/short_head', 'biceps/brachialis'],
  calves: ['calves/gastrocnemius_lateral', 'calves/gastrocnemius_medial', 'calves/soleus'],
  chest: ['chest/upper', 'chest/middle', 'chest/lower'],
  forearms: ['forearms/flexors', 'forearms/extensors'],
  glutes: ['glutes/maximus', 'glutes/medius'],
  hamstrings: ['hamstrings/hamstrings'],
  lats: ['lats/lats'],
  'lower back': ['lower_back/lower_back'],
  'middle back': ['traps/middle', 'traps/upper'],
  neck: ['neck/neck'],
  quadriceps: ['quads/rectus_femoris', 'quads/vastus_lateralis', 'quads/vastus_medialis'],
  shoulders: ['shoulders/front', 'shoulders/side', 'shoulders/rear'],
  traps: ['traps/lower'],
  triceps: ['triceps/long_head', 'triceps/lateral_head', 'triceps/medial_head'],
};
