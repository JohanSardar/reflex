// A 3D Embed in the web viewer (SPEC §5, "3D"): three.js in the Embed's sandboxed iframe. It
// gets the model's bytes from the host page (it has no network but the approved CDN it loads
// three.js from), draws it with the same orbit camera as the iPad, applies the Agent's part
// settings (params.parts) and the person's moves (state "part:<name>"), and answers Anchor
// requests by casting rays through the Mark: the part it covers, and the camera pose.
// The viewer can't save, so here parts don't move by hand; the iPad does that.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { USDZLoader } from "three/addons/loaders/USDZLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const FOV = 40;
const NAMED = { red: 0xe5484d, orange: 0xf76b15, yellow: 0xf5c400, green: 0x30a46c, teal: 0x12a594, blue: 0x0090ff, violet: 0x6e56cf, pink: 0xd6409f, black: 0x1d1d1f, grey: 0x8e8e93, white: 0xffffff };

let props = reflex.element.props();
let state = reflex.element.state();
const box = document.getElementById("view");
const note = document.getElementById("note");
const title = document.getElementById("title");
const say = (t) => {
  note.textContent = t; // text, never markup
  note.hidden = !t;
};

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
box.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.001, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.addEventListener("change", () => draw());

let model = null;
/** Part name -> its object, and each part's original transform. */
const parts = new Map();
const original = new Map();
let center = new THREE.Vector3();
let fitDistance = 1;

function size() {
  const w = box.clientWidth || innerWidth, h = box.clientHeight || innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  draw();
}
function draw() {
  sun.position.copy(camera.position).add(new THREE.Vector3(0, fitDistance, 0));
  renderer.render(scene, camera);
}

/** The orbit camera from {yaw, pitch, zoom}, as on the iPad and in `look`. */
function place(cam) {
  const yaw = THREE.MathUtils.degToRad(Number(cam?.yaw ?? 35));
  const pitch = THREE.MathUtils.degToRad(Math.max(-89, Math.min(89, Number(cam?.pitch ?? 25))));
  const d = (fitDistance * 1.05) / Math.max(0.05, Number(cam?.zoom ?? 1));
  camera.position.set(center.x + d * Math.sin(yaw) * Math.cos(pitch), center.y + d * Math.sin(pitch), center.z + d * Math.cos(yaw) * Math.cos(pitch));
  controls.target.copy(center);
  camera.near = d / 1000;
  camera.far = d * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

/** The camera as a Mark records it. */
function pose() {
  const v = camera.position.clone().sub(controls.target);
  const d = v.length();
  const r = (x) => +x.toFixed(4);
  return {
    yaw: r(THREE.MathUtils.radToDeg(Math.atan2(v.x, v.z))),
    pitch: r(THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, v.y / d))))),
    zoom: r((fitDistance * 1.05) / d),
    position: camera.position.toArray().map(r),
    target: controls.target.toArray().map(r),
    fov: FOV,
  };
}

/** Named nodes that hold a mesh, except one holding every mesh (the whole model) when there are others. */
function findParts(root, isNode) {
  const meshes = (o) => {
    let n = 0;
    o.traverse((c) => (n += c.isMesh ? 1 : 0));
    return n;
  };
  const total = meshes(root);
  const named = [];
  root.traverse((o) => {
    if (o !== root && o.name && isNode(o) && meshes(o) > 0) named.push(o);
  });
  for (const o of named) if (named.length === 1 || meshes(o) < total) parts.set(o.name, o);
  for (const o of parts.values()) original.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
}

const partOf = (o) => {
  for (let x = o; x; x = x.parent) if (x.name && parts.get(x.name) === x) return x.name;
  return undefined;
};

/** The Agent's part settings, then the person's moves where the Agent hasn't set that part since. */
function applySettings() {
  const settings = props.parts && typeof props.parts === "object" ? props.parts : {};
  for (const [name, o] of parts) {
    const base = original.get(o);
    const s = settings[name] ?? {};
    o.position.copy(base.p);
    o.quaternion.copy(base.q);
    o.scale.copy(base.s);
    if (Array.isArray(s.position) && s.position.length === 3) o.position.fromArray(s.position);
    if (Array.isArray(s.rotation) && s.rotation.length === 4) o.quaternion.fromArray(s.rotation);
    else if (Array.isArray(s.rotation) && s.rotation.length === 3) o.quaternion.setFromEuler(new THREE.Euler(...s.rotation.map(THREE.MathUtils.degToRad), "XYZ"));
    if (typeof s.scale === "number") o.scale.setScalar(s.scale);
    else if (Array.isArray(s.scale) && s.scale.length === 3) o.scale.fromArray(s.scale);
    const moved = state["part:" + name];
    if (moved && Array.isArray(moved.position) && moved.position.length === 3) {
      const agent = s.position;
      if (!agent || JSON.stringify(agent) === JSON.stringify(moved.base ?? null)) o.position.fromArray(moved.position);
    }
    o.visible = !s.hidden;
    const hl = s.highlight ? new THREE.Color(NAMED[s.highlight] ?? NAMED.orange) : null;
    o.traverse((m) => {
      if (!m.isMesh) return;
      m.userData.base ??= m.material;
      if (!hl) m.material = m.userData.base;
      else {
        const mats = (Array.isArray(m.userData.base) ? m.userData.base : [m.userData.base]).map((b) => {
          const c = b.clone();
          if (c.color) c.color.copy(hl);
          if (c.emissive) c.emissive.copy(hl).multiplyScalar(0.35);
          return c;
        });
        m.material = Array.isArray(m.userData.base) ? mats : mats[0];
      }
    });
  }
  title.textContent = typeof props.title === "string" ? props.title : "";
  title.hidden = !title.textContent;
  draw();
}

async function load(bytes) {
  const head = new Uint8Array(bytes, 0, 4);
  const glb = String.fromCharCode(...head) === "glTF";
  try {
    if (glb) {
      const gltf = await new GLTFLoader().parseAsync(bytes, "");
      model = gltf.scene;
      findParts(model, (o) => gltf.parser.associations.get(o)?.nodes !== undefined);
    } else {
      model = new USDZLoader().parse(bytes);
      findParts(model, () => true);
    }
  } catch (e) {
    say("This model can't be shown here: " + String(e?.message ?? e).slice(0, 200));
    return;
  }
  scene.add(model);
  const bb = new THREE.Box3().setFromObject(model);
  center = bb.getCenter(new THREE.Vector3());
  const radius = Math.max(1e-6, bb.getSize(new THREE.Vector3()).length() / 2);
  const half = THREE.MathUtils.degToRad(FOV / 2);
  fitDistance = radius / Math.sin(Math.min(half, Math.atan(Math.tan(half) * camera.aspect)));
  applySettings();
  place(props.camera);
  draw();
}

// What a Mark points at: rays through the points it encloses (a closed loop) or covers (a stroke).
reflex.anchors.register({
  resolve(region) {
    if (!model) return null;
    const pts = (region.points ?? []).map((q) => [q[0], q[1]]);
    if (!pts.length) return null;
    const [bx, by, bw, bh] = region.bounds;
    const a = pts[0], z = pts[pts.length - 1];
    const closed = pts.length > 8 && Math.hypot(a[0] - z[0], a[1] - z[1]) < 0.35 * Math.hypot(bw, bh);
    const inside = (p) => {
      let c = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const samples = [];
    if (closed) {
      const step = Math.max(2, Math.sqrt((bw * bh) / 400));
      for (let y = by; y <= by + bh; y += step) for (let x = bx; x <= bx + bw; x += step) if (inside([x, y])) samples.push([x, y]);
    }
    if (!samples.length) for (const p of pts) samples.push(p);
    const w = box.clientWidth || innerWidth, h = box.clientHeight || innerHeight;
    const ray = new THREE.Raycaster();
    const count = new Map();
    for (const [x, y] of samples) {
      ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), camera);
      const hit = ray.intersectObject(model, true).find((i) => i.object.visible);
      const name = hit && partOf(hit.object);
      if (name) count.set(name, (count.get(name) ?? 0) + 1);
    }
    const camera_ = pose();
    if (!count.size) return { kind: "local", bounds: region.bounds.map(Math.round), label: "the model, away from its parts", camera: camera_ };
    const total = [...count.values()].reduce((t, n) => t + n, 0);
    const ranked = [...count].sort((p, q) => q[1] - p[1]).filter(([, n], i) => i === 0 || n / total >= 0.08).map(([n]) => n);
    return { kind: "part", part: ranked[0], parts: ranked.slice(0, 100), label: ranked.length === 1 ? `part ${ranked[0]}` : `parts ${ranked.slice(0, 4).join(", ")}${ranked.length > 4 ? ", …" : ""}`.slice(0, 200), camera: camera_ };
  },
});

addEventListener("message", (e) => {
  const m = e.data;
  if (e.source !== parent || !m || m.__reflex !== 2) return;
  if (m.t === "model" && m.bytes instanceof ArrayBuffer && !model) load(m.bytes);
  if (m.t === "update") {
    props = m.props ?? props;
    state = m.state ?? state;
    if (model) applySettings();
  }
});
addEventListener("resize", size);
size();
// Listening now: ask the host for the model's bytes.
parent.postMessage({ __reflex: 1, t: "model_ready" }, "*");
