import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mats, prep, maskUniforms } from "./muscle-materials.js";
import { SkinPeel, bakeSkin } from "./skin-peel.js";

const $ = (id) => document.getElementById(id);
const canvas = $("c"),
  stage = $("stage"),
  button = $("skin"),
  instruction = $("instruction"),
  tension = $("tension");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
} catch (error) {
  $("load-text").textContent =
    "This viewer needs WebGL. Try a browser with graphics acceleration enabled.";
  throw error;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setClearColor(0xffffff, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene(); // Transparent so the DOM lettering is truly behind the body.
const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = !reducedMotion;
controls.dampingFactor = 0.085;
controls.enablePan = false;
controls.enableZoom = false;
controls.minDistance = 0.55;
controls.maxDistance = 4.6;
controls.enabled = false;

// Camera framing. The landing shot is a close-up of the head and shoulders;
// after the skin rips, the camera pulls out to the full body with a slight turn.
const TWIST = 0.38; // final turn of the full-body view, in radians (about 22 degrees)
function closeView() {
  const half = THREE.MathUtils.degToRad(camera.fov) / 2,
    t = Math.tan(half);
  // Frame by height so the face always fills the shot. On narrow windows the
  // shoulders are trimmed instead of pulling back to show more of the body.
  const radius = Math.max(0.3 / t, 0.15 / (t * camera.aspect));
  // head sits low enough to leave room for the title above it; shoulders stay in
  const y = 1.71 - 0.2 * radius * t;
  return {
    target: new THREE.Vector3(0, y, 0),
    radius,
    theta: 0.03,
    phi: Math.PI / 2 - 0.03,
  };
}
function fullView() {
  return {
    target: new THREE.Vector3(0, 0.86, 0),
    radius: 4.3,
    theta: 0.014 + TWIST,
    phi: 1.5406,
  };
}
let camMode = "close",
  camAnim = null;
const sph = new THREE.Spherical(),
  offset3 = new THREE.Vector3();
function readCam() {
  sph.setFromVector3(offset3.copy(camera.position).sub(controls.target));
  return {
    target: controls.target.clone(),
    radius: sph.radius,
    theta: sph.theta,
    phi: sph.phi,
  };
}
function applyCam(v) {
  controls.target.copy(v.target);
  camera.position
    .copy(v.target)
    .add(offset3.setFromSpherical(sph.set(v.radius, v.phi, v.theta)));
  camera.lookAt(v.target);
}
function lockPolar(phi) {
  controls.minPolarAngle = controls.maxPolarAngle = phi;
}
function animateCamera(to, duration, swing = 0) {
  const from = readCam();
  // take the short way round
  while (to.theta - from.theta > Math.PI) from.theta += Math.PI * 2;
  while (from.theta - to.theta > Math.PI) from.theta -= Math.PI * 2;
  camAnim = {
    from,
    to,
    t: 0,
    duration: reducedMotion ? 0.01 : duration,
    swing,
  };
  controls.enabled = false;
}
const easeInOut = (k) =>
  k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
function stepCamera(dt) {
  if (!camAnim) return false;
  const a = camAnim;
  a.t += dt;
  const k = Math.min(1, a.t / a.duration),
    e = easeInOut(k);
  applyCam({
    target: a.from.target.clone().lerp(a.to.target, e),
    radius: THREE.MathUtils.lerp(a.from.radius, a.to.radius, e),
    theta:
      THREE.MathUtils.lerp(a.from.theta, a.to.theta, e) +
      Math.sin(Math.PI * k) * a.swing,
    phi: THREE.MathUtils.lerp(a.from.phi, a.to.phi, e),
  });
  if (k >= 1) {
    camAnim = null;
    lockPolar(a.to.phi);
    controls.update();
    if (camMode === "full") controls.saveState();
    controls.enabled = !!peel?.canExplore;
  }
  return true;
}
{
  const v = closeView();
  applyCam(v);
  lockPolar(v.phi);
  controls.update();
}
scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d2cf, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(1.5, 3, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xfff1ea, 0.9);
fill.position.set(-3, 1, -2.5);
scene.add(fill);
// rim light from behind traces the silhouette against the dark background
const rim = new THREE.DirectionalLight(0xfff0e6, 1.6);
rim.position.set(0.4, 2.2, -4);
scene.add(rim);

let body,
  skin,
  peel,
  dirty = true,
  hovered = null,
  selected = null,
  down = null,
  pendingPointer = null,
  lastPointer = null;
let drawnFrames = 0,
  activeFrameTime = 0,
  activeSamples = 0,
  skinTriangles = 0,
  muscleTriangles = 0;
const dragTitle = $("drag-title");
let hintTimer = 0;
function hintFace() {
  instruction.textContent = "Only the face can be grabbed";
  instruction.classList.add("nudge");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    instruction.classList.remove("nudge");
    if (peel && !peel.drag && !peel.revealed && !peel.peeling)
      instruction.textContent = "Grab the face and pull";
  }, 1600);
}
const layerList = [...document.querySelectorAll(".name-layer")];
let activeLayer = 0,
  lastName = null;
const measure = document.createElement("canvas").getContext("2d");
const nice = (s) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function fitNames() {
  const w = stage.clientWidth,
    h = stage.clientHeight;
  measure.font = '700 100px "Barlow Condensed"';
  layerList.forEach((layer) => {
    const text = layer.querySelector(".name-main");
    const lines = text.textContent.split("\n");
    const width = Math.max(
      1,
      ...lines.map((line) => measure.measureText(line).width),
    );
    const size = Math.min(h * 0.25, ((w * 0.92) / width) * 100);
    layer.style.setProperty("--name-size", size + "px");
    // the small part label sits beside the word when there is room, else below it
    const part = layer.querySelector(".name-part");
    measure.font = "500 12px monospace";
    const room = (w - (width * size) / 100) / 2,
      need = measure.measureText(part.textContent).width * 1.35 + 40;
    layer.classList.toggle("part-below", room < need);
  });
}

// The landing title sits in the space between the top bar and the top of the head.
const headTop = new THREE.Vector3(0, 1.715, 0),
  headTopProj = new THREE.Vector3();
function fitDragTitle() {
  const w = stage.clientWidth;
  measure.font = '700 100px "Barlow Condensed"';
  const width = measure.measureText("DRAG THE FACE").width;
  headTopProj.copy(headTop).project(camera);
  const bar =
    document.querySelector(".top").getBoundingClientRect().bottom -
    stage.getBoundingClientRect().top +
    10;
  const top = ((1 - headTopProj.y) / 2) * stage.clientHeight - 8,
    gap = Math.max(40, top - bar);
  const size = Math.min(gap / 0.74, ((w * 0.9) / width) * 100);
  dragTitle.style.setProperty("--drag-size", size + "px");
  dragTitle.style.setProperty("--drag-y", bar + gap / 2 + "px");
}
function showName(value) {
  if (value === lastName) return;
  lastName = value;
  layerList.forEach((layer) => layer.classList.remove("visible"));
  if (!value) return;
  const [group, part] = value.split("/");
  activeLayer = 1 - activeLayer;
  const layer = layerList[activeLayer];
  // Keep labels grounded in the supplied model's group/part metadata.
  const title =
    part === "brachialis" ? "BRACHIALIS" : nice(group).toUpperCase();
  layer.querySelector(".name-main").textContent = title;
  layer.querySelector(".name-part").textContent =
    part === group || part === "brachialis" ? "" : nice(part);
  fitNames();
  // Allow the inactive layer's opacity to settle before fading its new content in.
  requestAnimationFrame(() => {
    if (lastName === value) layer.classList.add("visible");
  });
  $("announcement").textContent =
    nice(group) + (part !== group ? ", " + nice(part) : "");
}

const black = new THREE.Color(0),
  hoverColor = new THREE.Color("#631913"),
  selectedColor = new THREE.Color("#a53724");
function paint() {
  mats.forEach((m, key) => {
    m.emissive.copy(
      key === selected ? selectedColor : key === hovered ? hoverColor : black,
    );
    m.emissiveIntensity = key === selected ? 0.3 : 0.27;
  });
  showName(peel?.canExplore ? hovered || selected : null);
  dirty = true;
}

const ray = new THREE.Raycaster(),
  pointer = new THREE.Vector2();
function pick(event) {
  if (!body || !peel?.canExplore) return null;
  const box = canvas.getBoundingClientRect();
  pointer.set(
    ((event.clientX - box.left) / box.width) * 2 - 1,
    1 - ((event.clientY - box.top) / box.height) * 2,
  );
  ray.setFromCamera(pointer, camera);
  const hit = ray.intersectObjects(body.children, true)[0];
  const data = hit?.object.userData;
  return data?.kind === "clickable" ? data.group + "/" + data.part : null;
}

function phaseChanged(phase, canExplore) {
  stage.dataset.phase = phase;
  controls.enabled = canExplore && !camAnim;
  // Muscles exist only once the skin has torn, and while any skin remains they
  // are clipped to the opening, so nothing can poke through intact skin.
  if (body) body.visible = phase === "revealing" || phase === "explore";
  if (maskUniforms.uMaskOn) maskUniforms.uMaskOn.value = peel?.revealed ? 0 : 1;
  dragTitle.classList.toggle(
    "gone",
    phase === "revealing" || phase === "explore",
  );
  if (
    camMode === "close" &&
    (phase === "revealing" || phase === "explore") &&
    !peel?.drag
  ) {
    camMode = "full";
    animateCamera(fullView(), 2.8, 0.16);
  }
  if (canExplore) {
    pendingPointer = lastPointer;
    instruction.textContent = matchMedia("(hover: hover)").matches
      ? "Point at a muscle to explore"
      : "Tap a muscle to explore";
    $("step").textContent = "02 / EXPLORE";
    $("gesture").textContent =
      "DRAG TO TURN · SCROLL TO ZOOM · DRAG UP/DOWN WHEN ZOOMED";
    button.textContent = "Restore skin";
    canvas.style.cursor = "grab";
  } else {
    hovered = selected = null;
    showName(null);
    $("step").textContent = "01 / REVEAL";
    $("gesture").textContent = "GRAB THE FACE · PULL";
    instruction.textContent =
      phase === "pulling"
        ? "Keep pulling"
        : phase === "revealing"
          ? "Revealing the muscles"
          : "Grab the face and pull";
    button.textContent =
      phase === "revealing" ? "Revealing" : "Explore muscles";
    canvas.style.cursor = phase === "pulling" ? "grabbing" : "default";
  }
  button.disabled = !["covered", "recoiling", "explore"].includes(phase);
  tension.classList.toggle("active", phase === "pulling");
  dirty = true;
}

const loader = new GLTFLoader();
async function load(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Asset request failed: " + response.status);
  const { glb } = await response.json();
  const binary = atob(glb),
    buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
  return new Promise((resolve, reject) =>
    loader.parse(buffer.buffer, "", (g) => resolve(g.scene), reject),
  );
}
Promise.all([load("muscles.json"), load("skin.json")])
  .then(([muscles, surface]) => {
    body = muscles;
    body.traverse((o) => {
      if (o.isMesh) {
        prep(o);
        muscleTriangles += o.geometry.index.count / 3;
      }
    });
    skin = bakeSkin(surface);
    skinTriangles =
      skin.userData.skin.geometry.index.count / 3 +
      skin.userData.mouth.geometry.index.count / 3;
    scene.add(body, skin);
    peel = new SkinPeel({
      mesh: skin,
      scene,
      camera,
      canvas,
      reducedMotion,
      onChange: phaseChanged,
    });
    const u = peel.uniforms;
    maskUniforms.uPeel = u.uPeel;
    maskUniforms.uPeelSide = u.uPeelSide;
    maskUniforms.uTornSide = u.uTornSide;
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    // Compile once while the loading cover is present, avoiding first-drag stutter.
    renderer.compile(scene, camera);
    $("load").hidden = true;
    phaseChanged("covered", false);
    dirty = true;
  })
  .catch((error) => {
    $("load-text").textContent =
      location.protocol === "file:"
        ? "Start the included local server to open this viewer. See README."
        : "The model could not be loaded. Please reload the page.";
    console.error(error);
  });

// Explore camera: zoom toward whatever is under the cursor, drag up and down to
// move along the body once zoomed in. Zooming back out recentres the body.
const BODY_CENTER = new THREE.Vector3(0, 0.86, 0),
  FULL_R = 4.3,
  zoomRay = new THREE.Raycaster(),
  zoomNdc = new THREE.Vector2();
const viewPlane = new THREE.Plane(),
  zoomPoint = new THREE.Vector3(),
  camOffset = new THREE.Vector3();
function panRange(r) {
  return 0.86 * THREE.MathUtils.clamp((FULL_R - r) / (FULL_R - 1.2), 0, 1);
}
function clampTarget(r) {
  const t = controls.target,
    a = panRange(r),
    xz = Math.hypot(t.x, t.z),
    maxXZ = (0.3 * a) / 0.86;
  if (xz > maxXZ) {
    t.x *= maxXZ / xz;
    t.z *= maxXZ / xz;
  }
  t.y = THREE.MathUtils.clamp(t.y, 0.86 - a, 0.86 + a);
}
function zoomAt(clientX, clientY, factor) {
  if (!peel?.canExplore || camAnim) return;
  camOffset.copy(camera.position).sub(controls.target);
  const r = camOffset.length(),
    nr = THREE.MathUtils.clamp(
      r * factor,
      controls.minDistance,
      controls.maxDistance,
    );
  if (Math.abs(nr - r) < 1e-5) return;
  if (nr < r) {
    const box = canvas.getBoundingClientRect();
    zoomNdc.set(
      ((clientX - box.left) / box.width) * 2 - 1,
      1 - ((clientY - box.top) / box.height) * 2,
    );
    zoomRay.setFromCamera(zoomNdc, camera);
    const hit = body && zoomRay.intersectObjects(body.children, true)[0];
    if (hit) zoomPoint.copy(hit.point);
    else {
      viewPlane.setFromNormalAndCoplanarPoint(
        camOffset.clone().normalize(),
        controls.target,
      );
      if (!zoomRay.ray.intersectPlane(viewPlane, zoomPoint))
        zoomPoint.copy(controls.target);
    }
    controls.target.lerp(zoomPoint, 1 - nr / r);
  } else {
    controls.target.lerp(
      BODY_CENTER,
      THREE.MathUtils.clamp((nr - r) / Math.max(FULL_R - r, 0.001), 0, 1),
    );
  }
  camOffset.setLength(nr);
  clampTarget(nr);
  camera.position.copy(controls.target).add(camOffset);
  controls.update();
  dirty = true;
}
canvas.addEventListener(
  "wheel",
  (event) => {
    if (!peel?.canExplore) return;
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, Math.exp(event.deltaY * 0.0012));
  },
  { passive: false },
);
function panVertical(dyPx) {
  camOffset.copy(camera.position).sub(controls.target);
  const r = camOffset.length(),
    perPx =
      (2 * r * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) /
      stage.clientHeight;
  controls.target.y += dyPx * perPx;
  clampTarget(r);
  camera.position.copy(controls.target).add(camOffset);
  controls.update();
  dirty = true;
}
canvas.addEventListener("pointerdown", (event) => {
  if (!peel || event.button !== 0 || down) return;
  lastPointer = { clientX: event.clientX, clientY: event.clientY };
  if (!peel.canExplore) {
    pendingPointer = null;
    if (peel.begin(event)) {
      canvas.setPointerCapture(event.pointerId);
      tension.style.transform = `translate(${event.clientX}px,${event.clientY}px)`;
      tension.style.setProperty("--pull", "0");
      dirty = true;
    } else if (!peel.peeling) hintFace();
    return;
  }
  down = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    ly: event.clientY,
  };
});
canvas.addEventListener("pointermove", (event) => {
  lastPointer = { clientX: event.clientX, clientY: event.clientY };
  if (peel?.drag) {
    peel.move(event);
    tension.style.transform = `translate(${event.clientX}px,${event.clientY}px)`;
    tension.style.setProperty("--pull", peel.progress);
    dirty = true;
    return;
  }
  if (down && down.id === event.pointerId && peel?.canExplore && !camAnim) {
    panVertical(event.clientY - down.ly);
    down.ly = event.clientY;
  }
  if (!down && event.pointerType !== "touch") pendingPointer = lastPointer;
  if (peel && !peel.drag && !peel.revealed && !peel.peeling) {
    const h = peel.hit(event);
    canvas.style.cursor = h && peel.isFace(h.point) ? "grab" : "default";
  }
});
canvas.addEventListener("pointerup", (event) => {
  if (peel?.drag) {
    peel.end(event);
    if (canvas.hasPointerCapture(event.pointerId))
      canvas.releasePointerCapture(event.pointerId);
    tension.classList.remove("active");
    dirty = true;
    return;
  }
  if (down && down.id === event.pointerId) {
    const moved =
      Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6;
    down = null;
    if (!moved) {
      const value = pick(event);
      selected = value === selected ? null : value;
      hovered = value;
      paint();
    }
  }
});
function cancelGesture(event) {
  peel?.end(event);
  down = null;
  tension.classList.remove("active");
  dirty = true;
}
canvas.addEventListener("pointercancel", cancelGesture);
canvas.addEventListener("lostpointercapture", (event) => {
  if (peel?.drag) cancelGesture(event);
});
window.addEventListener("blur", () => {
  cancelGesture();
  hovered = null;
  paint();
});
canvas.addEventListener("pointerleave", () => {
  if (peel?.drag) return;
  hovered = null;
  pendingPointer = null;
  lastPointer = null;
  paint();
});
button.addEventListener("click", () => {
  if (!peel) return;
  hovered = selected = null;
  down = null;
  paint();
  if (peel.revealed) {
    peel.reset();
    camMode = "close";
    animateCamera(closeView(), 1.5, -0.1);
  } else peel.skip();
});
canvas.addEventListener("keydown", (event) => {
  if (!peel?.canExplore) return;
  const offset = camera.position.clone().sub(controls.target);
  if (event.key === "ArrowLeft" || event.key === "ArrowRight")
    offset.applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      event.key === "ArrowLeft" ? 0.12 : -0.12,
    );
  else if (event.key === "+" || event.key === "=" || event.key === "-") {
    const b = canvas.getBoundingClientRect();
    zoomAt(
      b.left + b.width / 2,
      b.top + b.height / 2,
      event.key === "-" ? 1.07 : 0.93,
    );
    event.preventDefault();
    return;
  } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    panVertical(event.key === "ArrowUp" ? 24 : -24);
    event.preventDefault();
    return;
  } else if (event.key === "Escape") {
    hovered = selected = null;
    paint();
    return;
  } else if (event.key === "Home") {
    if (!camAnim) controls.reset();
    return;
  } else return;
  event.preventDefault();
  offset.clampLength(controls.minDistance, controls.maxDistance);
  camera.position.copy(controls.target).add(offset);
  controls.update();
  dirty = true;
});

function resize() {
  const w = stage.clientWidth,
    h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w / h < 0.7 ? 38 : 28;
  camera.updateProjectionMatrix();
  if (camMode === "close" && !camAnim) applyCam(closeView());
  fitNames();
  fitDragTitle();
  dirty = true;
}
new ResizeObserver(resize).observe(stage);
resize();
document.fonts.ready.then(() => {
  fitNames();
  fitDragTitle();
});
controls.addEventListener("change", () => {
  dirty = true;
  if (lastPointer && !down) pendingPointer = lastPointer;
});

// Preserve the original viewer's modesty treatment without GPU readPixels stalls.
const groin = new THREE.Vector3(0, 0.765, 0.07),
  front = new THREE.Vector3(0, 0, 1),
  view = new THREE.Vector3(),
  right = new THREE.Vector3(),
  projected = new THREE.Vector3();
function placeModesty() {
  const veil = $("modesty");
  if (!skin?.visible || (peel?.peeling && peel.frontAt(0, 0.07) < 0.7)) {
    veil.hidden = true;
    return;
  }
  const facing = view.copy(camera.position).sub(groin).normalize().dot(front);
  if (facing < -0.25) {
    veil.hidden = true;
    return;
  }
  projected.copy(groin).project(camera);
  right
    .setFromMatrixColumn(camera.matrixWorld, 0)
    .multiplyScalar(0.095)
    .add(groin)
    .project(camera);
  const w = stage.clientWidth,
    h = stage.clientHeight,
    r = (Math.abs(right.x - projected.x) * w) / 2;
  veil.style.width = 2 * r + "px";
  veil.style.height = 2.2 * r + "px";
  veil.style.transform = `translate(${((projected.x + 1) / 2) * w - r}px,${((1 - projected.y) / 2) * h - r * 1.1}px)`;
  veil.style.opacity = Math.min(1, (facing + 0.25) / 0.3);
  veil.hidden = false;
}

const head = new THREE.Vector3(0, 1.6, 0),
  headProj = new THREE.Vector3(),
  nameBox = $("muscle-name");
function placeNames() {
  headProj.copy(head).project(camera);
  const y = ((1 - headProj.y) / 2) * stage.clientHeight;
  stage.style.setProperty(
    "--name-y",
    Math.max(stage.clientHeight * 0.16, y) + "px",
  );
}
let previousTime = 0;
renderer.setAnimationLoop((time) => {
  const start = performance.now(),
    raw = (time - previousTime) / 1000 || 1 / 60,
    dt = Math.min(raw, 1 / 30);
  previousTime = time;
  const moving = stepCamera(Math.min(raw, 0.1));
  if (!moving) controls.update();
  const active = peel?.update(dt) || false || moving;
  if (pendingPointer && !down && peel?.canExplore) {
    const value = pick(pendingPointer);
    pendingPointer = null;
    if (value !== hovered) {
      hovered = value;
      canvas.style.cursor = value ? "pointer" : "grab";
      paint();
    }
  }
  if (dirty || active) {
    renderer.render(scene, camera);
    placeModesty();
    placeNames();
    if (!peel?.revealed && !peel?.peeling) fitDragTitle();
    dirty = false;
    drawnFrames++;
  }
  if (active) {
    activeFrameTime += performance.now() - start;
    activeSamples++;
  }
});
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  $("load-text").textContent = "Restoring graphics";
  $("load").hidden = false;
});
canvas.addEventListener("webglcontextrestored", () => {
  if (body) $("load").hidden = true;
  dirty = true;
});

// Read-only diagnostics for profiling; deliberately absent from the product UI.
Object.defineProperty(window, "anatomyMetrics", {
  get: () => ({
    phase: peel?.phase || "loading",
    peelTime: peel?.uniforms.uPeel.value,
    expression: peel?.uniforms.uExpr.value,
    pull: peel?.shown,
    side: peel?.side,
    hovered,
    selected,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    muscleTriangles,
    skinTriangles,
    patchVertices: peel?.cloth?.positions.length / 3 || 0,
    patchHeld: peel?.cloth?.held || false,
    renderedFrames: drawnFrames,
    averageActiveJsMs: activeSamples ? activeFrameTime / activeSamples : 0,
    geometries: renderer.info.memory.geometries,
    programs: renderer.info.programs.length,
  }),
});
