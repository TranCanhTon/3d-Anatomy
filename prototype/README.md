# Rig test (Phase 2 prototype)

A test page for the exercise idea: the muscle model gets a skeleton and lifts dumbbells.
It is separate from the main site. Nothing in the Phase 1 files was changed.

## Run

From the project folder (one level up):

```sh
py -m http.server 8000
```

Open **http://localhost:8000/prototype/**.

- **Dumbbell curl**, **Overhead press**, **Pull up**, **Dumbbell squat** and **Bench press** switch the exercise.
  The pull up comes from a video, the squat and bench press from the motion capture pack.
- Drag to orbit, scroll to zoom. **Slow motion** plays at 0.3x.
- The working muscles glow and swell a little on the lift.
- **X-ray** (bottom bar) cycles: bones (white, what a clip moves), muscle lines (the 3 points
  per muscle that effort.js measures; red = shorter than rest, blue = longer; muscles that
  stay within 1.5% of rest length are hidden), or both.
  The side panel lists every muscle whose length changed; hover a row to find its line.
- Debug views: `?debug=weights` colours each muscle by the bones it follows,
  `?debug=nobones` hides the skeleton mesh.

## Pose editor

Open **http://localhost:8000/prototype/editor.html** (or the link in the viewer).

- **Drag the yellow dot** on a hand to move the whole arm. **Drag the blue dot** on an elbow to
  turn where the elbow points. Drag empty space to turn the camera.
- **Dragging makes a keyframe** at the playhead (the white line on the timeline). The editor
  blends smoothly between keyframes and loops back to the first one.
- **Timeline:** click or drag to move the playhead, drag a diamond to move a keyframe,
  Space plays, K adds a keyframe, Delete removes the one under the playhead.
- **Lift:** put the playhead where the weight starts going up and press *Lift starts here*,
  then where it reaches the top and press *Lift ends here*. The working muscles come from this part.
- **Side panel:** palm direction, wrist bend and grip for the selected arm at this keyframe.
  *Mirror arms* copies every change to the other arm.
- **Open clip** loads the curl or press (clips without keyframes get them made from their motion).
  **Save clip** writes a clip file (Chrome and Edge let you pick the `clips` folder directly) with
  your keyframes inside, so it can be reopened and edited. Add one line to `exercises.js` to show it
  in the viewer; the editor tells you the line after saving.

## Motion capture to clip

The squat comes from the Wolff's Studio workout pack (`D:\Download\WorkoutAnimations`, 48 gym and
32 stretching animations, one rep each). Use the files in its `Unity` folder.

Open `http://localhost:8000/prototype/tools/pack.html`, pick an animation, a name, the equipment and
whether the feet stay on the floor. It downloads the clip. Put it in `clips/` and add a line to
`exercises.js` with the muscles from free-exercise-db.

How the conversion works (`tools/fbx-to-clip.js`):
- Only the pack's skeleton motion is used, never its character.
- Each of our bones copies how far its matching pack bone turned from rest. Spine and legs copy
  straight across. The pack stands in a T-pose and our model has its arms down, so each arm bone first
  gets a fixed offset that lines up the bone and the line across the palm in both rest poses.
- The hips' movement is scaled to our leg length, and the feet are pinned to the floor (standing) or
  the whole body is set at one height that keeps the feet on the floor (lying).
- **Barbell:** the pack only has dumbbells, so for a barbell lift the arms are solved again: the bar's
  middle follows the middle of the pack's hands, both wrists sit on it at a fixed grip width (the
  width at the bottom), the elbows keep the pack's direction, and the hands turn to hold the bar.
  The bar path is raised at the bottom so it touches the chest instead of sinking in (dumbbells go
  lower, beside the chest). The last 6% of arm reach is eased so the elbows don't snap at lockout.
  The viewer puts the barbell on the grip points every frame and a bench under the back.
  The bench press is file 48 made this way.
- The clip starts at the bottom of the lift. The lift is when the hands (with weights) or the body
  (bodyweight) go up.
- The pack's files are numbered, not named: 01 bodyweight squat, 02 dumbbell squat (dumbbells on the
  shoulders), 05 lunges, 09/10/15 shoulder press, 14/16 rows, 20 to 24 push ups, 38/40 pull ups,
  43 to 45 seated curls, 48 bench press. The rest still need a look.
- Needs the FBX loader in `vendor/` (`loaders/FBXLoader.js`, `libs/fflate.module.js`, `curves/NURBS*.js`,
  from three.js r160).

## Video to clip

The pull up was made from `D:\prototype videos\pull-up.mp4` in two steps.

1. **Track** (Python): `python prototype/tools/track_video.py VIDEO CX CY SIZE OUT.json`
   finds 33 body points in every frame. CX, CY, SIZE is a square around the person in video pixels.
   Needs `pip install ai-edge-litert numpy`, ffmpeg, and `pose_landmark_full.tflite` (already in
   `tools/`). The pull up track is saved in `tools/tracks/pull-up.track.json`.
2. **Convert** (browser): open `http://localhost:8000/prototype/tools/convert.html`, pick the track
   file, the first and last frame of one clean rep (start at the bottom of the lift), a name, and
   whether the hands hold a fixed bar. It downloads the clip. Put it in `clips/` and add a line to
   `exercises.js`.

How the conversion works (`tools/video-to-clip.js`):
- Arm directions come from the flat image (reliable), and depth comes from the known arm length:
  if a forearm looks shorter than its real length, the rest is depth. The tracker's own 3D guess
  only decides whether that depth is forward or back.
- Directions are measured relative to the torso, so camera zoom and angle don't matter.
- Two handed lifts are made symmetric (left averaged with the mirrored right).
- Forward or back depth is decided once per arm segment for the whole clip, so a few bad
  frames can't flip an arm behind the body.
- For a bar, the wrists are locked to the bar and the whole body moves (the clip's `root` track).
  The forearm twists so the palm wraps the bar (`gripAxis` in `rig.js`).
- The lift is found from the elbow bend. The way down is the way up played backwards, a bit
  slower, with short pauses at the top and bottom, so it is smooth and loops. Pass
  `lower: 'video'` to use the video's own way down instead.
- Only arms for now: legs and spine stay at rest until the leg rig is done.

## How it works

### Files

| File | What it does |
| --- | --- |
| `exercises.js` | The exercise list. Each one is a title, a clip file and equipment. |
| `clips/*.json` | Recorded motion, one rep per file. |
| `clip.js` | The clip format, the player, and the recorder that turns a hand written pose into a clip. |
| `effort.js` | Works out which muscles work, how hard, and how much they swell. |
| `xray.js` | The X-ray view: bones and muscle lines drawn through the model. |
| `editor.html`, `editor.js` | The pose editor. |
| `stage.js` | Scene setup shared by the editor (model, lights, dumbbells). |
| `tools/track_video.py` | Video to 33 tracked body points per frame. |
| `tools/video-to-clip.js`, `tools/convert.html` | Tracked points to a clip. |
| `tools/fbx-to-clip.js`, `tools/pack.html` | Motion capture (FBX) to a clip. |
| `hand-poses.js` | Hand written poses (the source of the curl and press clips) and rep timing. |
| `rig.js` | Skeleton, skinning and the arm solver. |
| `main.js` | The page: scene, loading, playback loop, buttons. |
| `tools/bake_rig.py` | Builds `rig.json` and `rig.bin` from `muscles.json`. |

### Clips

A clip is one recorded rep: the rotation of every moving bone, 30 times a second, plus where
each frame sits in the rep (`progress` 0 to 1, and `lifting` 1 or 0). The player loops it and
blends between frames. Whatever makes an exercise (hand written pose, pose editor, video)
saves this same file, so the page never changes.

To turn a hand written pose into a clip: add it to `hand-poses.js`, open
`http://localhost:8000/prototype/?record=name`, and `name.json` downloads. Put it in `clips/`.

An exercise can also point straight at a pose instead of a clip
(`{ title, rep, pose, equipment }`). That plays live and is handy while drafting.

### Effort and bulge

Each muscle has an attachment line (origin, middle, insertion), each point fixed to its bone.
The page measures the line every frame.

- **Which muscles work:** each exercise lists its primary and secondary muscles, copied from
  [free-exercise-db](https://github.com/yuhonas/free-exercise-db) (public domain). `DB_MUSCLES` in
  `effort.js` maps its names onto the model's muscles. Primary muscles score 1, secondary .55.
- **Which part of a group works hardest:** the motion decides. When the page loads an exercise it plays
  the lifting half once; inside each listed group, the part whose line shortens most gets the full
  score, the rest down to half (quads in a squat: both vasti 1, rectus femoris .55).
- **Bulge:** how much shorter the muscle is than at rest. It swells as it contracts.
- An exercise without a muscle list falls back to guessing from the motion alone (how much each muscle
  shortens). That guess put the chest second in the pull up, which is why the list comes from data now.
- **Grip** never changes length, so holding dumbbells or a bar adds forearm flexors automatically.
  Use `extraEffort` on an exercise for anything else that works without moving.
- The quads' lines end at the kneecap (in front of the knee, moving with the shin). A straight line
  to the shin cuts behind the knee when it bends and hardly changes length.

### Rig

- `tools/bake_rig.py` measures joint centres from the 206 bones in the model and works out
  which bones each muscle follows (by muscle group, falling off with distance). Leg bones only reach
  5 cm past the nearest bone, so smoothing can't drag a tendon strip along with the foot.
  Only needs Python with numpy and scipy. No Blender.
- `rig.js` builds the skeleton and solves the arms: two bone IK with an elbow direction,
  a shoulder blade that rotates with arm height, forearm twist to face the palm, and a closed grip.

## Credits

- Pose tracking model: Google MediaPipe BlazePose (Apache 2.0).
- Motion capture: Wolff's Studio, Workout Animations Part 1 (itch.io).
- Exercise muscle lists: free-exercise-db (public domain).

## Known limits

- The shoulder blade rotates less than a real one (24 degrees at most) to keep the back clean.
- Muscles stretch, they don't slide over each other.
- Fingers close as one group, so the grip is approximate.
- muscles.json has the upper and lower traps labels swapped. The page shows the right names.
