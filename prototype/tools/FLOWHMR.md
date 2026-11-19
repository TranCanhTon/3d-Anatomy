# FlowHMR: video to 3D motion on Google Colab

[FlowHMR](https://github.com/flowhmr/flowhmr) turns a video of one person into 3D body motion
(SMPL-H joint rotations, 30 frames a second). It needs an NVIDIA GPU, so it runs on Google Colab's
free T4 GPU instead of your PC. The notebook is `flowhmr_colab.ipynb` in this folder.

What you get back: `flowhmr_results.zip` with one folder per video piece, each holding
`flowhmr_latest.npz` (the motion). That file is turned into a clip for the site in a later step.

## Before the first run (one time)

You need three things on your PC:

1. **A Hugging Face token** (lets Colab download the gated models you have access to):
   1. Go to https://huggingface.co and log in.
   2. Click your profile picture (top right) > **Settings** > **Access Tokens**.
   3. **Create new token**. Token type: **Read**. Name: anything, for example `colab`. Click **Create token**.
   4. Copy the token (starts with `hf_`). Keep it somewhere private. Never put it in the repo or a chat.
   5. Check your access is approved: https://huggingface.co/facebook/VGGT-Omega and
      https://huggingface.co/facebook/sam-3d-body-dinov3 should not show a request form.
2. **`smplh.tar.xz`**, the Extended SMPL+H model from https://mano.is.tue.mpg.de (you have it in
   `D:\Download`). Don't unpack it, the notebook does that.
3. **The video**: `D:\Download\pulluppullp.mp4`.

## Running it

1. Open https://colab.research.google.com and sign in with a Google account.
2. **File > Upload notebook** > pick `prototype\tools\flowhmr_colab.ipynb` from the project folder.
3. **Runtime > Change runtime type** > Hardware accelerator **T4 GPU** > **Save**.
4. Run the cells one at a time, top to bottom: click inside a cell, then the round play button on its
   left (or press Shift+Enter). Wait until the spinner stops before the next one. Each cell starts
   with a comment saying what it does.

| Cell | What happens | Your part | Time |
| --- | --- | --- | --- |
| 1 | Checks the GPU | If it says NO GPU, do step 3 again | seconds |
| 2 | Downloads and installs FlowHMR | Nothing, lots of text is normal | 5 to 10 min |
| 3 | Downloads the models | Paste your token in the box, press Enter (it stays hidden) | 5+ min |
| 4 | SMPL-H body model | Click **Choose Files**, pick `smplh.tar.xz` | 1 to 3 min |
| 5 | Startup check | Every line should say `ok` | seconds |
| 6 | Cuts the video into pieces | Click **Choose Files**, pick `pulluppullp.mp4` | seconds |
| 7 | Runs FlowHMR on each piece | Nothing, wait | 5 to 15 min per piece |
| 8 | Downloads `flowhmr_results.zip` | Send the zip back | seconds |

Tip for cells 4 and 6: instead of the upload button you can open the folder icon on the left and
drag the file into it before running the cell. The cell finds it there.

If a cell turns red: copy the error text and send it back. Cell 7 keeps going with the other
pieces if one fails, so let it finish first.

### Things that can go wrong

- **"Cannot connect to GPU backend"**: the free GPU quota is used up for now. Try again in a few
  hours, or the next day.
- **Colab disconnected** (you were idle too long, or 12 hours passed): everything is wiped. Start
  again from cell 1.
- **401 or 403 in cell 3**: the token is wrong or access to a model isn't approved yet. Make a new
  token and run cell 3 again.
- **Out of GPU memory**: cell 7 handles this itself. It retries with a bigger camera frame interval
  and prints the value it ended up using.

## How the notebook works

- **Its own Python.** FlowHMR is tested on Python 3.10 with PyTorch 2.5.1 (cu118). Colab ships a
  newer Python, so the notebook makes a separate Python 3.10 (with `uv`) in `/content/fenv` and
  installs FlowHMR's exact versions there. Only the video to motion part is installed; the physics
  simulator (Isaac Gym, PHC) is skipped.
- **Plain chart mode.** Colab tells programs to draw charts inside the notebook (`MPLBACKEND`).
  FlowHMR's own Python doesn't have that mode and crashes on start, so the notebook runs it with
  `MPLBACKEND=Agg`. Cell 5 loads every part FlowHMR uses, so a problem like this shows up there in
  seconds instead of in cell 7.
- **float16 on the T4.** One line in VGGT-Omega is changed so it uses float16 on GPUs older than
  the A100 generation, the same rule the original VGGT code uses. Without it, newer PyTorch picks a
  slow emulated bfloat16 on the T4.
- **Memory.** FlowHMR estimates the camera with VGGT-Omega. Their own measurement: about 30 GB of
  GPU memory when the camera model looks at every frame, 17 GB at every 10th frame (300 frames on an
  A100). A T4 has 15 GB. So the notebook gives the camera model about 24 frames per piece (every 3rd
  frame for the short piece, every 10th to 12th for the long ones) and a smaller SAM batch (8
  instead of 16). If it still runs out, it doubles the interval and halves the batch, up to an
  interval of 30. The settings used are saved in `run_settings.json` in the zip.
- **Output axes.** Y is up (FlowHMR's own code converts Y-up to Z-up for its simulator, and turns
  the result 180 degrees around Y before saving). Which way the body faces is checked on the real
  output, not assumed.

## The pull up video

`pulluppullp.mp4`: 29.07 s, 576 x 1024, 30 fps, 869 frames, a 3D mannequin with glowing muscles.
The TikTok watermark shows a different handle than @fitnessflex5 (small and hard to read).
Cut points come from looking at the frames and a scene cut detector (`ffmpeg scdet`). There are
hard cuts at exactly 8.000 s, 16.000 s and 24.967 s. The jumps around 6 s and 14 s are lighting
changes, not cuts.

| Piece | Frames | Time | What |
| --- | --- | --- | --- |
| `chinup_34` | 630 to 701 | 21.0 to 23.4 s | Chin up from a 3/4 angle, best view for depth. Ends before a ghosting effect at 23.5 s |
| `pullup_wide` | 0 to 239 | 0 to 8 s | Wide grip pull up, back view, slow zooms |
| `pullup_close` | 240 to 479 | 8 to 16 s | Close grip pull up, back view, close zooms |
| `chinup` | 480 to 748 | 16 to 25 s | Chin up, back view, camera swings to 3/4 from 20.4 s |
| (dropped) | 749 to 868 | 25 to 29 s | TikTok outro |

The command that cuts a piece (frame exact, re-encoded, no sound):

```bash
ffmpeg -i pulluppullp.mp4 -vf "trim=start_frame=630:end_frame=702,setpts=PTS-STARTPTS,drawbox=x=60:y=55:w=455:h=190:color=0x1c2632:t=fill" -an -c:v libx264 -crf 16 -pix_fmt yuv420p -r 30 chinup_34.mp4
```

`end_frame` is one past the last frame you want. The `drawbox` covers the menu bar at the top (three
small body icons and the LATS / TRAPS / BICEPS label). Without it the person tracker follows the
highlighted icon, which is on screen every frame and never moves, and FlowHMR turns that thumbnail into
a body standing still. Cell 7 prints which "person" was followed for each piece.

### What came out

The tracker (YOLOX) only spots the glowing mannequin in part of the frames, and FlowHMR only processes
the stretch it tracked:

| Piece | Tracked frames | Result |
| --- | --- | --- |
| `chinup` | 127 to 268 (4.7 s) | 2 clean reps. **Used on the site.** |
| `chinup_34` | all 72 (2.4 s) | 1 rep, same motion |
| `pullup_wide` | 181 to 222 (1.4 s) | only the way up |
| `pullup_close` | 64 to 132 (2.3 s) | barely moves |

FlowHMR keeps the feet on the floor (it was trained on people standing), so the chin up came out as a
standing pulldown with the right arm and body pose. `smplh_to_clip.py` hangs it from the bar. In the
result the centre of mass sits under the hands (the old MediaPipe pull up: 20 to 32 cm behind them).

## Adding another exercise from a video

1. **Pick the stretch.** One person, whole body in view most of the time, 2 to 10 s with at least one
   full rep. Find cut points by looking at frames (`ffmpeg -vf "fps=2,tile=10x6"` makes a contact sheet)
   and hard cuts with `ffmpeg -vf "scdet=threshold=8"`. Cover any on-screen figures, icons or other
   people with `drawbox`, like the menu bar above.
2. **Edit cell 6** of the notebook: the `PIECES` list (name, first frame, last frame) and `MASK`.
3. **Run the notebook** (cells 1 to 8). In cell 7, every piece must say `followed: mannequin` (or the
   person) and the tracked frames should cover most of the piece. Download the zip.
4. **Convert** (from the project folder; the SMPL-H file is `neutral/model.npz` from `smplh.tar.xz`):

   ```bash
   python prototype/tools/smplh_to_clip.py flowhmr_results/chinup/flowhmr_latest.npz path/to/neutral/model.npz prototype/clips/chinup.json --name chinup
   ```

   It prints the joint map, how far the hands drifted before locking, the cut, and the centre of mass
   before and after. It is written for exercises that hang from a bar. A standing exercise needs the
   feet pinned instead (like `fbx-to-clip.js` does); that is not built yet.
5. **Register it**: add a line to `prototype/exercises.js` with the muscle lists from free-exercise-db
   (`db`, `primary`, `secondary`) and the `credit`. Never let the motion alone pick the muscles.
   To open it from the front screen, point a muscle at it in `MUSCLE_EXERCISE` in `exercise-mode.js`.
6. **Check it** in the prototype page (`/prototype/`, it gets a button in `prototype/index.html`) and
   on the front screen, from the back, side and front at the bottom, middle and top of a rep.

## Never commit

The SMPL-H files, the Hugging Face token, model weights and the source videos stay out of the repo.
`.gitignore` covers them.

## Licenses

FlowHMR: non commercial. SAM 3D Body: Meta, SAM License. VGGT-Omega: Meta, FAIR Noncommercial
Research License. SMPL-H: MPI, non commercial. Fine for a portfolio; credit all four.
