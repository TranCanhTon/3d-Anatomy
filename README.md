# Muscle Model Viewer

An updated version of the supplied viewer, with large fading muscle labels behind
the body and a drag-to-tear skin introduction. Three.js and the font are
included locally; no npm install, build step, or external CDN is required.

## Run

Extract this folder, open a terminal inside it, and run:

```sh
python3 -m http.server 8000
```

On Windows, use `py -m http.server 8000`. Open **http://localhost:8000**.
Use a local HTTP server rather than double-clicking `index.html`.

## Interactions

- The page opens on a dark close-up of the head and shoulders, with DRAG THE
  FACE set large above the head.
- Only the face can be grabbed. Wherever you grab it, the first clear
  movement picks the pull: sideways drags that cheek out, downward drags the
  forehead down, upward drags the nose up. The stretch follows a fixed,
  designed path and the head is yanked with it. He is terrified: eyes wide,
  brows up, forehead creased, mouth open; right before the break his eyes roll
  back. Release early and it relaxes.
- Pull far enough and it rips with a ragged, bloody edge:
  - sideways: that half of the face tears off,
  - downward: the whole front of the face tears off,
  - upward: everything above the mouth tears off and the mouth is left
    stretched wide for a second.
  The torn piece flies off and breaks apart, the head snaps back, and the
  muscles show through the hole. The cut edge has real thickness (skin, then
  yellow fat), and the eyes and teeth under the torn skin go with it. Then the
  rest of the skin comes off:
  - after a sideways rip it splits down the middle and peels from the top of
    the head down, raw and bloody on the inside,
  - after a downward or upward rip it greys, crumbles and blows away as dust,
    all over the body at once.
- Hover a muscle to fade its group name in behind the head and tint it teal.
  Click to keep a selection. On a phone, tap to select.
- Muscles with an exercise (biceps, front shoulders, lats, chest) show a
  **Watch the exercise** button when selected. The same model then does the
  exercise: the other muscles dim, the camera swings round, the equipment
  fades in, and the working muscles pulse teal with each rep. The bench press
  cuts with a quick fade, since lying down is too far to blend. In the
  exercise: **Pause**, **Slow motion**, **X-ray** (bones, muscle lines with a
  panel of length changes, or both), a rep progress bar, scroll to zoom toward
  the cursor and drag up or down to move. **Back to explore** or Escape
  returns to the same view. The exercises come from the
  prototype (`prototype/`), see its README.
- Drag horizontally to rotate. Scroll to zoom toward whatever is under the
  cursor; once zoomed in, drag up or down to move along the body. Zooming
  back out recentres the full body.
- **Explore muscles** skips the introduction. **Restore skin** returns to the close-up.
- Keyboard: Tab to the skip button, then Enter. With the canvas focused,
  left/right arrows rotate, up/down arrows move along the body, +/- zoom, Home resets the view, Escape clears selection.
- Reduced-motion preferences shorten the reveal and disable rotation damping
  and ambient flutter.

## Structure

- `app.js`: loading, camera, selection, background labels, render scheduling.
- `skin-peel.js`: skin material, face pulls, expressions, the rip, the peel and the dust.
- `muscle-materials.js`: the supplied viewer's muscle material treatment, plus the teal highlight,
  dimming and contraction bulge used by explore and exercise mode.
- `exercise-mode.js`: the explore model doing an exercise. Makes a skinned copy of the muscles with
  the rig from `prototype/`, plays the clip, blends in and out, places the equipment.
- `styles.css`: layout, typography, fades, responsive styling.
- `vendor/`, `fonts/`: local runtime dependencies and their licenses.

The name is a CSS layer behind the transparent WebGL canvas. It adds no WebGL
draw calls. The expressions, the peel and the dust run in shaders; nothing is
simulated on the CPU. Rendering pauses when the scene is still.

The tear is stylized, not a biological simulation. `muscles.json` and its
anatomical group metadata are unchanged; `skin.json` has the MakeHuman head
joined at the neck (see Credits). The source skin intersects the muscles in a
few spots; concealed muscles are hidden until the skin comes off, to avoid red
speckles.

## Validation

Checked in a headless Chromium with software rendering at 1280 × 800 and
several smaller window sizes: loading, face-only grab, expressions, early
release, all four rips, the peel, the dust, skip, restore, hover and selection. No JavaScript
or shader errors. Software rendering is slow, so timing was not measured;
check the feel on a real laptop.

Geometry: 141,860 muscle triangles / 74 draw calls during exploration;
about 28,400 skin, eye and teeth triangles / 2 draw calls on the landing. Read-only diagnostics
are available at `window.anatomyMetrics`.

## Credits

The head, neck, teeth, tongue and the three expressions come from **MakeHuman**
(base mesh, male targets and hand-made expression units), released as **CC0**.
They were joined to the Z-Anatomy-based skin at the neck.

- MakeHuman: https://github.com/makehumancommunity/makehuman


Anatomy source attribution from the project brief: **Z-Anatomy**, incorporating
**BodyParts3D** (Database Center for Life Science). License: **CC BY-SA 4.0**.
Keep source attribution and applicable share-alike terms when redistributing
adaptations.

- Z-Anatomy: https://github.com/LluisV/Z-Anatomy
- BodyParts3D: https://lifesciencedb.jp/bp3d/
- CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/
- Three.js 0.160.0: MIT; see `vendor/THREE-LICENSE.txt`.
- Barlow Condensed Bold: SIL Open Font License; see `fonts/BarlowCondensed-OFL.txt`.

The type is inspired by the supplied reference; no logo or branded artwork is used.
