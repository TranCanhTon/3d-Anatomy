
// The exercise list. An exercise is either
//   a clip:  { title, clip: 'clips/name.json', equipment }      recorded motion, the normal case
//   a pose:  { title, rep, pose: (k) => ({...}), equipment }     hand written, played live (handy for drafts)
// primary / secondary: the muscles the exercise trains, copied from free-exercise-db
// (github.com/yuhonas/free-exercise-db, public domain; db is the entry's id there).
// effort.js maps those names onto the model's muscles and uses the motion to pick which part of
// each group works hardest. Without them, effort is guessed from the motion alone.
// extraEffort adds muscles that work without moving, like grip: { 'forearms/flexors': .4 }

export const EXERCISES = {
  curl: { title: 'Dumbbell curl', clip: 'clips/curl.json', equipment: 'dumbbells',
    db: 'Dumbbell_Bicep_Curl', primary: ['biceps'], secondary: ['forearms'] },
  press: { title: 'Overhead press', clip: 'clips/press.json', equipment: 'dumbbells',
    db: 'Dumbbell_Shoulder_Press', primary: ['shoulders'], secondary: ['triceps'] },
  pullup: { title: 'Pull up', clip: 'clips/pullup.json', equipment: 'bar', // from video (pull-up.mp4)
    db: 'Pullups', primary: ['lats'], secondary: ['biceps', 'middle back'] },
  dbsquat: { title: 'Dumbbell squat', clip: 'clips/dbsquat.json', equipment: 'dumbbells', // mocap pack, Anim_Bodybuilding02
    db: 'Dumbbell_Squat', primary: ['quadriceps'], secondary: ['calves', 'glutes', 'hamstrings', 'lower back'] },
  bench: { title: 'Bench press', clip: 'clips/bench.json', equipment: 'barbell', // mocap pack, Anim_Bodybuilding48 (arms put on a barbell)
    db: 'Barbell_Bench_Press_-_Medium_Grip', primary: ['chest'], secondary: ['shoulders', 'triceps'] },
};

// Holding a dumbbell or a bar always works the grip, which never shows up as shortening.
export const EQUIPMENT_EFFORT = { dumbbells: { 'forearms/flexors': .3 }, barbell: { 'forearms/flexors': .3 }, bar: { 'forearms/flexors': .4 } };
