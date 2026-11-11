// Builds heart.glb: a simplified human heart for the anatomy Recipe (SPEC §16, scenario 11).
// Chambers are ellipsoids and vessels are tubes, each a named part, so a Mark on the model names
// the vessel it points at. Not to anatomical scale; the layout follows a front (anterior) view:
// the person's right is the model's -X, the front is +Z, up is +Y. Run:
//   node extensions/models/make-heart.ts
import { writeFileSync } from "node:fs";
import { writeGlb } from "../../agent/src/model.ts";

type V = [number, number, number];
type Mesh = { pos: number[]; nrm: number[]; idx: number[] };

const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => mul(a, 1 / (Math.hypot(...a) || 1));

function ellipsoid(r: V, tilt = 0): Mesh {
  const m: Mesh = { pos: [], nrm: [], idx: [] };
  const U = 28, W = 18;
  const rot = (p: V): V => [p[0] * Math.cos(tilt) - p[1] * Math.sin(tilt), p[0] * Math.sin(tilt) + p[1] * Math.cos(tilt), p[2]];
  for (let j = 0; j <= W; j++) {
    const v = (j / W) * Math.PI;
    for (let i = 0; i <= U; i++) {
      const u = (i / U) * 2 * Math.PI;
      const s: V = [Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u)];
      m.pos.push(...rot([s[0] * r[0], s[1] * r[1], s[2] * r[2]]));
      m.nrm.push(...rot(norm([s[0] / r[0], s[1] / r[1], s[2] / r[2]])));
    }
  }
  for (let j = 0; j < W; j++)
    for (let i = 0; i < U; i++) {
      const a = j * (U + 1) + i, b = a + U + 1;
      m.idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  return m;
}

/** A tube through the points (relative to the part's position), smoothed, with closed ends. */
function tube(pts: V[], radius: number): Mesh {
  const path: V[] = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(pts.length - 1, k + 2)];
    for (let s = 0; s < 8; s++) {
      const t = s / 8, t2 = t * t, t3 = t2 * t;
      path.push([0, 1, 2].map((c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)) as V);
    }
  }
  path.push(pts[pts.length - 1]);
  const m: Mesh = { pos: [], nrm: [], idx: [] };
  const R = 14;
  let prevN: V = [0, 0, 1];
  path.forEach((p, k) => {
    const t = norm(sub(path[Math.min(path.length - 1, k + 1)], path[Math.max(0, k - 1)]));
    let n = cross(prevN, t);
    if (Math.hypot(...n) < 1e-6) n = cross([1, 0, 0], t);
    n = norm(cross(t, norm(n)));
    prevN = n;
    const b = cross(t, n);
    for (let i = 0; i <= R; i++) {
      const a = (i / R) * 2 * Math.PI;
      const d = add(mul(n, Math.cos(a)), mul(b, Math.sin(a)));
      m.pos.push(...add(p, mul(d, radius)));
      m.nrm.push(...d);
    }
  });
  for (let k = 0; k < path.length - 1; k++)
    for (let i = 0; i < R; i++) {
      const a = k * (R + 1) + i, c = a + R + 1;
      m.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  for (const [k, dir] of [[0, -1], [path.length - 1, 1]] as const) {
    const t = norm(sub(path[Math.min(path.length - 1, k + 1)], path[Math.max(0, k - 1)]));
    const center = m.pos.length / 3;
    m.pos.push(...path[k]);
    m.nrm.push(...mul(t, dir));
    for (let i = 0; i < R; i++) m.idx.push(...(dir > 0 ? [center, k * (R + 1) + i, k * (R + 1) + i + 1] : [center, k * (R + 1) + i + 1, k * (R + 1) + i]));
  }
  return m;
}

function merge(...ms: Mesh[]): Mesh {
  const out: Mesh = { pos: [], nrm: [], idx: [] };
  for (const m of ms) {
    const base = out.pos.length / 3;
    out.pos.push(...m.pos);
    out.nrm.push(...m.nrm);
    out.idx.push(...m.idx.map((i) => i + base));
  }
  return out;
}

const RED: number[] = [0.72, 0.12, 0.14, 1];
const MUSCLE: number[] = [0.66, 0.24, 0.24, 1];
const ATRIUM: number[] = [0.76, 0.36, 0.34, 1];
const BLUE: number[] = [0.24, 0.36, 0.72, 1];
const VIOLET: number[] = [0.42, 0.34, 0.7, 1];
const CORONARY: number[] = [0.9, 0.3, 0.2, 1];

// [name, position, mesh relative to position, color]
const parts: [string, V, Mesh, number[]][] = [
  ["left_ventricle", [0.016, -0.022, -0.004], ellipsoid([0.036, 0.052, 0.036], 0.35), MUSCLE],
  ["right_ventricle", [-0.018, -0.014, 0.016], ellipsoid([0.032, 0.044, 0.026], 0.25), MUSCLE],
  ["left_atrium", [0.022, 0.034, -0.02], ellipsoid([0.024, 0.02, 0.022]), ATRIUM],
  ["right_atrium", [-0.034, 0.028, 0.002], ellipsoid([0.024, 0.026, 0.024]), ATRIUM],
  ["aorta", [0.002, 0.06, -0.004], tube([[0, -0.03, 0], [-0.002, 0.012, 0.004], [0.006, 0.034, 0], [0.026, 0.036, -0.012], [0.038, 0.016, -0.026], [0.04, -0.04, -0.034]], 0.011), RED],
  ["pulmonary_trunk", [-0.004, 0.05, 0.02], tube([[-0.012, -0.03, 0.002], [-0.006, 0.0, 0.004], [0.002, 0.018, 0], [0.018, 0.024, -0.008], [0.044, 0.026, -0.016]], 0.01), VIOLET],
  ["superior_vena_cava", [-0.036, 0.07, -0.004], tube([[0, -0.024, 0.002], [0, 0.0, 0], [-0.002, 0.03, -0.002]], 0.009), BLUE],
  ["inferior_vena_cava", [-0.034, -0.012, -0.01], tube([[0, 0.02, 0.006], [-0.001, -0.01, 0], [-0.003, -0.044, -0.006]], 0.0095), BLUE],
  [
    "pulmonary_veins",
    [0.046, 0.036, -0.026],
    merge(tube([[-0.02, 0.006, 0], [0.006, 0.01, 0.002], [0.032, 0.016, 0.004]], 0.0055), tube([[-0.02, -0.006, 0], [0.006, -0.01, 0.002], [0.032, -0.016, 0.004]], 0.0055)),
    RED,
  ],
  ["right_coronary_artery", [-0.026, 0.006, 0.03], tube([[0.018, 0.02, -0.004], [0.002, 0.012, 0.008], [-0.012, -0.004, 0.006], [-0.016, -0.028, 0.0]], 0.0028), CORONARY],
  ["left_coronary_artery", [0.006, 0.0, 0.034], tube([[-0.002, 0.03, -0.008], [0.0, 0.012, 0.004], [0.002, -0.02, 0.008], [0.008, -0.05, -0.002]], 0.0028), CORONARY],
];

const chunks: Buffer[] = [];
let offset = 0;
const views: any[] = [], accessors: any[] = [], meshes: any[] = [], materials: any[] = [], nodes: any[] = [];
const push = (b: Buffer, target: number) => {
  const pad = (4 - (b.length % 4)) % 4;
  views.push({ buffer: 0, byteOffset: offset, byteLength: b.length, target });
  chunks.push(b, Buffer.alloc(pad));
  offset += b.length + pad;
  return views.length - 1;
};
for (const [name, position, m, color] of parts) {
  const pos = Buffer.from(new Float32Array(m.pos).buffer);
  const nrm = Buffer.from(new Float32Array(m.nrm).buffer);
  const idx = Buffer.from(new Uint32Array(m.idx).buffer);
  const min = [0, 1, 2].map((c) => Math.min(...m.pos.filter((_, i) => i % 3 === c)));
  const max = [0, 1, 2].map((c) => Math.max(...m.pos.filter((_, i) => i % 3 === c)));
  const a = accessors.length;
  accessors.push(
    { bufferView: push(pos, 34962), componentType: 5126, count: m.pos.length / 3, type: "VEC3", min, max },
    { bufferView: push(nrm, 34962), componentType: 5126, count: m.nrm.length / 3, type: "VEC3" },
    { bufferView: push(idx, 34963), componentType: 5125, count: m.idx.length, type: "SCALAR" },
  );
  materials.push({ name, pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 0.6 } });
  meshes.push({ name, primitives: [{ attributes: { POSITION: a, NORMAL: a + 1 }, indices: a + 2, material: materials.length - 1 }] });
  nodes.push({ name, mesh: meshes.length - 1, translation: position });
}
nodes.push({ name: "heart", children: parts.map((_, i) => i) });
const gltf = {
  asset: { version: "2.0", generator: "reflex make-heart" },
  scene: 0,
  scenes: [{ nodes: [nodes.length - 1] }],
  nodes,
  meshes,
  materials,
  accessors,
  bufferViews: views,
  buffers: [{ byteLength: offset }],
};
const out = new URL("./heart.glb", import.meta.url);
writeFileSync(out, writeGlb(gltf, Buffer.concat(chunks)));
console.log(`wrote ${out.pathname}: ${parts.length} parts`);
