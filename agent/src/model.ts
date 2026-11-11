// 3D models for 3D Embeds (SPEC §5, "3D"). A model is one asset: a binary glTF
// (GLB) or a USDZ. A glTF that comes as JSON with separate buffers and images
// is packed into one GLB when it is imported, so every device draws it from a
// single file. This module also reads a GLB's part map (its named nodes) and
// draws a snapshot of it for `look`, with the camera and part settings the
// iPad and the web viewer use:
//
// - params (the Agent's): `camera: {yaw, pitch, zoom}` and
//   `parts: {<name>: {position?, rotation?, scale?, highlight?, hidden?}}`.
// - state (the person's, saved by dragging a part): `"part:<name>": {position, base}`.
//   `base` is the Agent's position for that part when the person moved it; if the
//   Agent sets another one later, the Agent's wins.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Vec3 = [number, number, number];
export type Part = { name: string; position: Vec3; center: Vec3; size: Vec3 };
export type Camera = { yaw: number; pitch: number; zoom: number };
export type PartSetting = { position?: number[]; rotation?: number[]; scale?: number | number[]; highlight?: string | boolean; hidden?: boolean };

/** The largest model Reflex imports. */
export const MAX_MODEL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CAMERA: Camera = { yaw: 35, pitch: 25, zoom: 1 };
/** Vertical field of view, in degrees, on every device. */
export const FOV = 40;

export const isGlb = (b: Buffer) => b.length >= 12 && b.toString("latin1", 0, 4) === "glTF";
export const isUsdz = (b: Buffer) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
const looksJson = (b: Buffer) => /^\s*\{/.test(b.toString("utf8", 0, Math.min(64, b.length)));

/** A model that can't be imported, with what to do instead. */
export class ModelError extends Error {
  fix: string;
  constructor(msg: string, fix: string) {
    super(msg);
    this.fix = fix;
  }
}

// MARK: Import

type Loader = (ref: string) => Promise<Buffer>;

/** Fetches an https resource, refusing anything bigger than the model limit. */
async function fetchCapped(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  if (!url.startsWith("https://")) throw new ModelError(`'${url}' is not an https URL.`, "Give the model as an https URL, a file path on this computer, or 'asset:<sha256>'.");
  const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) }).catch((e: Error) => {
    throw new ModelError(`Couldn't download ${url}: ${e.message}.`, "Check the URL, or save the file and pass its path.");
  });
  if (!res.ok) throw new ModelError(`Downloading ${url} answered ${res.status}.`, "Check the URL, or save the file and pass its path.");
  if (!res.url.startsWith("https://")) throw new ModelError(`${url} redirected away from https.`, "Use a URL that stays on https.");
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_MODEL_BYTES) throw new ModelError(`${url} is ${Math.round(len / 1e6)} MB; the limit is ${MAX_MODEL_BYTES / 1e6} MB.`, "Use a smaller or compressed model.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += c.length;
    if (total > MAX_MODEL_BYTES) throw new ModelError(`${url} is over ${MAX_MODEL_BYTES / 1e6} MB.`, "Use a smaller or compressed model.");
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

/**
 * Reads a model from an https URL or (when `files` is set, on the person's own Link) a path on
 * this computer, and returns the one file to store: a GLB or a USDZ. A glTF in JSON form is
 * packed with its buffers and images into a GLB.
 */
export async function importModel(ref: string, o: { fetch?: typeof fetch; files?: boolean } = {}): Promise<{ bytes: Buffer; format: "glb" | "usdz"; name: string }> {
  const fetchImpl = o.fetch ?? fetch;
  let load: Loader;
  let base: string;
  if (ref.startsWith("https://")) {
    load = (r) => fetchCapped(r, fetchImpl);
    base = ref;
  } else {
    if (!o.files) throw new ModelError(`'${ref}' isn't a model Reflex can open here.`, "Give an https URL; file paths work only with a Link on this computer.");
    const file = ref.startsWith("file://") ? fileURLToPath(ref) : ref.replace(/^~(?=\/)/, process.env.HOME ?? "~");
    if (!path.isAbsolute(file)) throw new ModelError(`'${ref}' is not an absolute path.`, "Pass the model's full path, such as /Users/me/models/gearbox.glb.");
    load = async (r) => {
      const p = r.startsWith("file://") ? fileURLToPath(r) : r;
      const b = await readFile(p).catch((e: Error) => {
        throw new ModelError(`Couldn't read ${p}: ${e.message}.`, "Check the path.");
      });
      if (b.length > MAX_MODEL_BYTES) throw new ModelError(`${p} is over ${MAX_MODEL_BYTES / 1e6} MB.`, "Use a smaller or compressed model.");
      return b;
    };
    base = pathToFileURL(file).href;
  }
  const bytes = await load(base.startsWith("file://") ? fileURLToPath(base) : base);
  const name = decodeURIComponent(new URL(base).pathname.split("/").pop() || "model");
  if (isGlb(bytes)) {
    parseGlb(bytes); // throws on a broken file
    return { bytes, format: "glb", name };
  }
  if (isUsdz(bytes)) return { bytes, format: "usdz", name };
  if (looksJson(bytes)) return { bytes: await packGltf(bytes, base, load), format: "glb", name: name.replace(/\.gltf$/i, ".glb") };
  throw new ModelError(`${name} is not a glTF, GLB or USDZ file.`, "Export the model as .glb, .gltf or .usdz.");
}

const pad4 = (n: number) => (n + 3) & ~3;

/** Packs a JSON glTF and everything its `uri`s name into one GLB. */
export async function packGltf(jsonBytes: Buffer, base: string, load: Loader): Promise<Buffer> {
  let gltf: any;
  try {
    gltf = JSON.parse(jsonBytes.toString("utf8"));
  } catch {
    throw new ModelError("The glTF's JSON doesn't parse.", "Export it again, or as .glb.");
  }
  if (!gltf?.asset?.version?.startsWith?.("2")) throw new ModelError("Only glTF 2.0 is supported.", "Export it as glTF 2.0.");
  const resolve = async (uri: string): Promise<Buffer> => {
    const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(uri);
    if (m) return m[1] ? Buffer.from(m[2], "base64") : Buffer.from(decodeURIComponent(m[2]));
    const abs = new URL(uri, base).toString();
    if (base.startsWith("file://") !== abs.startsWith("file://")) throw new ModelError(`The glTF refers to ${uri}, which is somewhere else.`, "Keep its buffers and images next to it.");
    return load(abs.startsWith("file://") ? fileURLToPath(abs) : abs);
  };
  const buffers: Buffer[] = await Promise.all((gltf.buffers ?? []).map((b: any) => (b.uri ? resolve(b.uri) : Promise.reject(new ModelError("A glTF buffer has no uri.", "Export it as .glb.")))));
  // One BIN chunk: every buffer back to back, each 4-byte aligned.
  const offsets: number[] = [];
  let size = 0;
  for (const b of buffers) {
    offsets.push(size);
    size = pad4(size + b.length);
  }
  const parts: Buffer[] = [];
  for (const [i, b] of buffers.entries()) parts.push(b, Buffer.alloc(pad4(offsets[i] + b.length) - offsets[i] - b.length));
  for (const v of gltf.bufferViews ?? []) {
    v.byteOffset = (v.byteOffset ?? 0) + offsets[v.buffer ?? 0];
    v.buffer = 0;
  }
  // Images by uri become buffer views in the same chunk.
  for (const img of gltf.images ?? []) {
    if (!img.uri) continue;
    const b = await resolve(img.uri);
    const mime = /^data:([^;,]+)/.exec(img.uri)?.[1] ?? (b[0] === 0x89 ? "image/png" : "image/jpeg");
    gltf.bufferViews = gltf.bufferViews ?? [];
    gltf.bufferViews.push({ buffer: 0, byteOffset: size, byteLength: b.length });
    parts.push(b, Buffer.alloc(pad4(b.length) - b.length));
    size = pad4(size + b.length);
    img.bufferView = gltf.bufferViews.length - 1;
    img.mimeType = mime;
    delete img.uri;
  }
  gltf.buffers = size ? [{ byteLength: size }] : [];
  return writeGlb(gltf, Buffer.concat(parts));
}

/** A GLB from its JSON and its BIN chunk. */
export function writeGlb(gltf: unknown, bin: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPad = Buffer.concat([json, Buffer.alloc(pad4(json.length) - json.length, 0x20)]);
  const binPad = Buffer.concat([bin, Buffer.alloc(pad4(bin.length) - bin.length)]);
  const total = 12 + 8 + jsonPad.length + (bin.length ? 8 + binPad.length : 0);
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "latin1");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const chunk = (type: string, body: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(body.length, 0);
    h.write(type, 4, "latin1");
    return [h, body];
  };
  return Buffer.concat([head, ...chunk("JSON", jsonPad), ...(bin.length ? chunk("BIN\0", binPad) : [])]);
}

// MARK: Reading a GLB

export function parseGlb(b: Buffer): { json: any; bin: Buffer } {
  if (!isGlb(b) || b.readUInt32LE(4) !== 2) throw new ModelError("The file is not a glTF 2.0 GLB.", "Export it as glTF 2.0 (.glb).");
  let at = 12;
  let json: any;
  let bin = Buffer.alloc(0);
  while (at + 8 <= b.length) {
    const len = b.readUInt32LE(at);
    const type = b.toString("latin1", at + 4, at + 8);
    const body = b.subarray(at + 8, at + 8 + len);
    if (type === "JSON") json = JSON.parse(body.toString("utf8"));
    else if (type === "BIN\0") bin = body;
    at += 8 + len;
  }
  if (!json) throw new ModelError("The GLB has no JSON chunk.", "Export it again.");
  return { json, bin };
}

type Mat4 = Float64Array;
const ident = (): Mat4 => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const mul = (a: Mat4, b: Mat4): Mat4 => {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};
const apply = (m: Mat4, p: Vec3): Vec3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const trs = (t: number[], q: number[], s: number[]): Mat4 => {
  const [x, y, z, w] = q;
  const m = new Float64Array([
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ]);
  return m;
};
/** Euler angles in degrees (applied X, then Y, then Z) as a quaternion [x, y, z, w]. */
export const eulerQuat = (deg: number[]): number[] => {
  const [ax, ay, az] = deg.map((d) => ((d ?? 0) * Math.PI) / 360);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz];
};

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function accessor(json: any, bin: Buffer, i: number): number[][] {
  const a = json.accessors?.[i];
  if (!a || a.bufferView === undefined) return [];
  const v = json.bufferViews[a.bufferView];
  const n = COMPONENTS[a.type] ?? 1;
  const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType as number] ?? 4;
  const stride = v.byteStride || n * size;
  const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const read = (o: number) =>
    a.componentType === 5126 ? bin.readFloatLE(o) : a.componentType === 5125 ? bin.readUInt32LE(o) : a.componentType === 5123 ? bin.readUInt16LE(o) : a.componentType === 5121 ? bin.readUInt8(o) : a.componentType === 5122 ? bin.readInt16LE(o) : bin.readInt8(o);
  const out: number[][] = [];
  for (let k = 0; k < a.count; k++) {
    const row: number[] = [];
    for (let c = 0; c < n; c++) row.push(read(start + k * stride + c * size));
    out.push(row);
  }
  return out;
}

type Node = { index: number; name?: string; local: Mat4; t: number[]; r: number[]; s: number[]; mesh?: number; children: number[] };

function nodesOf(json: any): Node[] {
  return (json.nodes ?? []).map((n: any, index: number) => {
    let t = n.translation ?? [0, 0, 0];
    let r = n.rotation ?? [0, 0, 0, 1];
    let s = n.scale ?? [1, 1, 1];
    let local = trs(t, r, s);
    if (Array.isArray(n.matrix)) {
      local = new Float64Array(n.matrix);
      t = [n.matrix[12], n.matrix[13], n.matrix[14]];
    }
    return { index, name: typeof n.name === "string" && n.name ? n.name : undefined, local, t, r, s, mesh: n.mesh, children: n.children ?? [] };
  });
}

const roots = (json: any, nodes: Node[]) => {
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene?.nodes) return scene.nodes as number[];
  const child = new Set(nodes.flatMap((n) => n.children));
  return nodes.map((n) => n.index).filter((i) => !child.has(i));
};

type Tri = { a: Vec3; b: Vec3; c: Vec3; color: [number, number, number]; part?: string };

/** Every triangle in model space, with its part, after the Agent's and the person's part settings. */
function triangles(b: Buffer, settings: Record<string, PartSetting>, moved: Record<string, Vec3>, maxTris = 40_000): { tris: Tri[]; parts: Part[] } {
  const { json, bin } = parseGlb(b);
  const nodes = nodesOf(json);
  const partNames = partsOf(json, nodes);
  const tris: Tri[] = [];
  const boxes = new Map<string, { min: Vec3; max: Vec3; position: Vec3 }>();
  const meshCache = new Map<number, { pos: number[][]; idx: number[]; color: [number, number, number] }[]>();
  const meshOf = (m: number) => {
    if (!meshCache.has(m)) {
      meshCache.set(
        m,
        (json.meshes?.[m]?.primitives ?? [])
          .filter((p: any) => (p.mode ?? 4) === 4 && p.attributes?.POSITION !== undefined)
          .map((p: any) => {
            const pos = accessor(json, bin, p.attributes.POSITION);
            const idx = p.indices !== undefined ? accessor(json, bin, p.indices).map((r) => r[0]) : pos.map((_, i) => i);
            const f = json.materials?.[p.material]?.pbrMetallicRoughness?.baseColorFactor ?? [0.75, 0.75, 0.78, 1];
            return { pos, idx, color: [f[0], f[1], f[2]] as [number, number, number] };
          }),
      );
    }
    return meshCache.get(m)!;
  };
  const visit = (i: number, parent: Mat4, part: string | undefined, highlight: string | boolean | undefined, depth: number) => {
    const n = nodes[i];
    if (!n || depth > 64) return;
    const name = n.name && partNames.has(n.name) ? n.name : undefined;
    const set = name ? settings[name] : undefined;
    if (set?.hidden) return;
    let local = n.local;
    let position: Vec3 = [n.t[0], n.t[1], n.t[2]];
    if (name && (set || moved[name])) {
      const t = (moved[name] ?? set?.position ?? n.t) as number[];
      position = [t[0], t[1], t[2]];
      const r = Array.isArray(set?.rotation) ? (set!.rotation!.length === 4 ? set!.rotation! : eulerQuat(set!.rotation!)) : n.r;
      const s = set?.scale === undefined ? n.s : typeof set.scale === "number" ? [set.scale, set.scale, set.scale] : set.scale;
      local = trs(position, r, s);
    }
    const world = mul(parent, local);
    const owner = name ?? part;
    const hl = set?.highlight ?? highlight;
    if (n.mesh !== undefined) {
      for (const prim of meshOf(n.mesh)) {
        const color = hl ? HIGHLIGHT(hl) : prim.color;
        const pts = prim.pos.map((p) => apply(world, [p[0], p[1], p[2]]));
        for (let k = 0; k + 2 < prim.idx.length; k += 3) {
          const t = { a: pts[prim.idx[k]], b: pts[prim.idx[k + 1]], c: pts[prim.idx[k + 2]], color, part: owner };
          if (t.a && t.b && t.c) tris.push(t);
        }
        // Every named part this mesh is inside grows by it.
        for (const pn of chain(i)) {
          const box = boxes.get(pn) ?? { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3, position: [0, 0, 0] as Vec3 };
          for (const p of pts) for (let c = 0; c < 3; c++) (box.min[c] = Math.min(box.min[c], p[c])), (box.max[c] = Math.max(box.max[c], p[c]));
          boxes.set(pn, box);
        }
      }
    }
    if (name) {
      const box = boxes.get(name) ?? { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3, position };
      box.position = position;
      boxes.set(name, box);
    }
    for (const c of n.children) visit(c, world, owner, hl, depth + 1);
  };
  const parentOf = new Map<number, number>();
  for (const n of nodes) for (const c of n.children) parentOf.set(c, n.index);
  const chain = (i: number) => {
    const out: string[] = [];
    for (let k: number | undefined = i, d = 0; k !== undefined && d < 64; k = parentOf.get(k), d++) {
      const nm = nodes[k]?.name;
      if (nm && partNames.has(nm)) out.push(nm);
    }
    return out;
  };
  for (const r of roots(json, nodes)) visit(r, ident(), undefined, undefined, 0);
  const keep = tris.length > maxTris ? tris.filter((_, k) => k % Math.ceil(tris.length / maxTris) === 0) : tris;
  const r = (v: number) => +v.toFixed(4);
  const parts: Part[] = [...partNames].filter((n) => boxes.get(n) && isFinite(boxes.get(n)!.min[0])).map((name) => {
    const { min, max, position } = boxes.get(name)!;
    return { name, position: position.map(r) as Vec3, center: min.map((v, c) => r((v + max[c]) / 2)) as Vec3, size: min.map((v, c) => r(max[c] - v)) as Vec3 };
  });
  return { tris: keep, parts };
}

/**
 * A model's parts: its named nodes that hold a mesh (their own or a child's), except one that
 * holds every mesh in the model when there are other parts (that one is the whole model).
 */
function partsOf(json: any, nodes: Node[]): Set<string> {
  const meshes = (i: number, d = 0): number => (d > 64 || !nodes[i] ? 0 : (nodes[i].mesh !== undefined ? 1 : 0) + nodes[i].children.reduce((t, c) => t + meshes(c, d + 1), 0));
  const total = roots(json, nodes).reduce((t, r) => t + meshes(r), 0);
  const named = nodes.filter((n) => n.name && meshes(n.index) > 0);
  const out = named.filter((n) => named.length === 1 || meshes(n.index) < total);
  return new Set(out.map((n) => n.name!));
}

/** The parts of a GLB, each with its position (in its parent's space) and its box in model space. */
export function modelParts(b: Buffer): Part[] {
  if (!isGlb(b)) return [];
  return triangles(b, {}, {}, 0).parts;
}

/** What the person moved, from an Embed's state, kept only where the Agent hasn't set that part since. */
export function movedParts(state: Record<string, any> | undefined, settings: Record<string, PartSetting>): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  for (const [k, v] of Object.entries(state ?? {})) {
    if (!k.startsWith("part:") || !Array.isArray(v?.position) || v.position.length !== 3) continue;
    const name = k.slice(5);
    const agent = settings[name]?.position;
    const base = v.base ?? null;
    if (agent && JSON.stringify(agent) !== JSON.stringify(base)) continue;
    out[name] = v.position as Vec3;
  }
  return out;
}

const NAMED: Record<string, [number, number, number]> = {
  red: [0.9, 0.28, 0.3], orange: [0.97, 0.42, 0.08], yellow: [0.96, 0.77, 0], green: [0.19, 0.64, 0.42], teal: [0.07, 0.65, 0.58],
  blue: [0, 0.56, 1], violet: [0.43, 0.34, 0.81], pink: [0.84, 0.25, 0.62], black: [0.11, 0.11, 0.12], grey: [0.56, 0.56, 0.58], white: [1, 1, 1],
};
const HIGHLIGHT = (h: string | boolean): [number, number, number] => (typeof h === "string" && NAMED[h]) || NAMED.orange;

// MARK: Snapshot

/** The orbit camera every device uses: where it is and where it looks, for a model whose box is given. */
export function cameraPose(min: Vec3, max: Vec3, cam: Camera, aspect: number) {
  const target: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(1e-6, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  const half = (FOV * Math.PI) / 360;
  const fit = radius / Math.sin(Math.min(half, Math.atan(Math.tan(half) * aspect)));
  const d = (fit * 1.05) / Math.max(0.05, cam.zoom);
  const yaw = (cam.yaw * Math.PI) / 180;
  const pitch = (Math.max(-89, Math.min(89, cam.pitch)) * Math.PI) / 180;
  const position: Vec3 = [target[0] + d * Math.sin(yaw) * Math.cos(pitch), target[1] + d * Math.sin(pitch), target[2] + d * Math.cos(yaw) * Math.cos(pitch)];
  return { position, target, distance: d };
}

/**
 * An SVG group drawing the model into `box` (Space coordinates) from the Embed's camera: flat
 * shaded triangles, far to near. Returns undefined when the bytes aren't a GLB this can read.
 */
export function modelSvg(b: Buffer, box: [number, number, number, number], o: { params?: Record<string, any>; state?: Record<string, any> } = {}): string | undefined {
  if (!isGlb(b)) return undefined;
  const settings: Record<string, PartSetting> = o.params?.parts && typeof o.params.parts === "object" ? o.params.parts : {};
  let tris: Tri[];
  try {
    tris = triangles(b, settings, movedParts(o.state, settings)).tris;
  } catch {
    return undefined;
  }
  if (!tris.length) return "";
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const p of [t.a, t.b, t.c]) for (let c = 0; c < 3; c++) (min[c] = Math.min(min[c], p[c])), (max[c] = Math.max(max[c], p[c]));
  const [bx, by, bw, bh] = box;
  const c = o.params?.camera ?? {};
  const cam: Camera = { yaw: Number(c.yaw ?? DEFAULT_CAMERA.yaw), pitch: Number(c.pitch ?? DEFAULT_CAMERA.pitch), zoom: Number(c.zoom ?? DEFAULT_CAMERA.zoom) };
  const { position, target } = cameraPose(min, max, cam, bw / Math.max(1, bh));
  // A look-at basis: forward from the camera to the target, right and up.
  const f = norm(sub(target, position));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const focal = bh / 2 / Math.tan((FOV * Math.PI) / 360);
  const light = norm(add(scale(u, 0.6), add(scale(r, -0.3), scale(f, -1))));
  const proj = (p: Vec3): [number, number, number] => {
    const v = sub(p, position);
    const z = Math.max(1e-6, dot(v, f));
    return [bx + bw / 2 + (dot(v, r) * focal) / z, by + bh / 2 - (dot(v, u) * focal) / z, z];
  };
  const drawn = tris
    .map((t) => {
      const [a, b2, c2] = [proj(t.a), proj(t.b), proj(t.c)];
      const n = norm(cross(sub(t.b, t.a), sub(t.c, t.a)));
      const lit = 0.38 + 0.62 * Math.abs(dot(n, light));
      return { pts: [a, b2, c2], z: (a[2] + b2[2] + c2[2]) / 3, fill: t.color.map((v) => Math.round(255 * Math.min(1, v * lit))) };
    })
    .sort((p, q) => q.z - p.z);
  const polys = drawn.map((d) => {
    const fill = `rgb(${d.fill.join(",")})`;
    return `<polygon points="${d.pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="${fill}" stroke="${fill}" stroke-width="0.6" stroke-linejoin="round"/>`;
  });
  return `<g><clipPath id="clip-${bx}-${by}"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}"/></clipPath><g clip-path="url(#clip-${bx}-${by})">${polys.join("")}</g></g>`;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
