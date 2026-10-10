import * as THREE from 'three';

// Hand written poses: an exercise described as a pose for rep progress k
// (0 = start of the lift, 1 = top) plus rep timing in seconds.
// These are the source the curl and press clips were recorded from.
// To re-record one, open /prototype/?record=curl and the clip file downloads.

export const DEG = Math.PI / 180;
const ease = (x) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const easeSine = (x) => .5 - .5 * Math.cos(Math.PI * x);

// Rep timing: lift, short squeeze at the top, slower lowering, short pause.
export function repProgress(t, rep) {
  const { up, hold, down, rest } = rep, T = up + hold + down + rest, x = ((t % T) + T) % T;
  if (x < up) return { k: ease(x / up), lifting: true };
  if (x < up + hold) return { k: 1, lifting: true };
  if (x < up + hold + down) return { k: 1 - easeSine((x - up - hold) / down), lifting: false };
  return { k: 0, lifting: false };
}

export const HAND_POSES = {
  curl: {
    rep: { up: 1.0, hold: .25, down: 1.35, rest: .35 },
    pose: (k) => ({ shoulderFlex: 3 * DEG + 13 * DEG * k, shoulderAbd: -2 * DEG, elbow: 4 * DEG + 118 * DEG * k, wristFlex: 6 * DEG * k }),
  },
  press: {
    rep: { up: 1.15, hold: .2, down: 1.5, rest: .3 },
    pose: (k) => ({
      wrist: new THREE.Vector3(THREE.MathUtils.lerp(.335, .215, k), THREE.MathUtils.lerp(1.51, 1.93, k), THREE.MathUtils.lerp(.035, .0, k)),
      pole: new THREE.Vector3(1, THREE.MathUtils.lerp(-.55, -.15, k), .35),
      wristFlex: -14 * DEG * (1 - k), palm: new THREE.Vector3(0, 0, 1),
    }),
  },
};
