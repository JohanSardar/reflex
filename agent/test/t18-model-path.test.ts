// A model the Agent places by a path on the Link's computer, in a folder whose name has a space
// (as macOS folders do). T18, "Place one": "an https URL, or a file path on the Link's computer".
//
//   node agent/test/t18-model-path.test.ts
//
// Passes when both folders work; fails when only the folder without a space does.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Core } from "../src/capabilities/index.ts";
import { SvgRenderer } from "../src/render.ts";
import { MemoryInbox, MemorySpaces } from "../src/author/memory.ts";
import { writeGlb } from "../src/model.ts";

/** A two-part model: nodes "gear" and "motor", each a triangle, 1 unit apart. */
function twoPartGlb(): Buffer {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const idx = new Uint16Array([0, 1, 2]);
  const bin = Buffer.concat([Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength), Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength)]);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { name: "gear", mesh: 0, translation: [0, 0, 0] },
      { name: "motor", mesh: 1, translation: [1, 0, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }, { primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  return writeGlb(gltf, bin);
}

const inbox = new MemoryInbox();
const spaces = new MemorySpaces(inbox);
const store = new Map<string, Buffer>();
const assets = {
  get: (hash: string) => store.get(hash),
  put: (bytes: Buffer) => {
    const hash = createHash("sha256").update(bytes).digest("hex");
    store.set(hash, bytes);
    return hash;
  },
};
// The Link: it is the person's own computer, so a model may be read from a path.
const core = new Core({ spaces, inbox, assets, renderer: new SvgRenderer(), person: { person: "p1", name: "Ana" }, localFiles: true });
const ctx = { who: { agent: "a1", name: "Claude", color: "blue" } };
await core.call("open_space", { space: "s1", create: true }, ctx);

const root = await mkdtemp(join(tmpdir(), "t18-"));
let failed = 0;
let n = 0;
for (const [dir, name] of [[join(root, "cad"), "motor-mount.glb"], [join(root, "Motor Mounts"), "gear box.glb"]] as const) {
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${name}`, twoPartGlb());
  const r = await core.call("apply", { space: "s1", ops: [{ op: "add", type: "embed", id: `m${n++}`, w: 640, h: 460, model: `${dir}/${name}`, at: { x: 10, y: 10 } }] }, ctx);
  const ok = r.json.ok === true && /2 parts: gear, motor/.test((r.json.repaired ?? []).join(" "));
  console.log(`${ok ? "ok  " : "FAIL"} ${dir}/${name}: ${JSON.stringify(r.json).slice(0, 220)}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
