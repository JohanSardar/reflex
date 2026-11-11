// The exec sandbox (SPEC §7): an Agent's JavaScript runs in QuickJS, compiled
// to WebAssembly, with no network, files, clock or host objects. The code
// only builds a list of apply ops and reads a copy of the scene; Core applies
// the ops as one batch, with the same ownership rules, repairs and lints as
// apply. A run is cut off after a few seconds or 64 MB.
import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten";

let quickjs: Promise<QuickJSWASMModule> | undefined;

const PRELUDE = String.raw`
"use strict";
const __ops = [];
const __logs = [];
const __scene = JSON.parse(__sceneJson);
delete globalThis.Date;
const __fmt = (v) => typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
globalThis.console = { log: (...a) => { if (__logs.length < 200) __logs.push(a.map(__fmt).join(" ").slice(0, 2000)); } };
console.info = console.warn = console.error = console.log;
const __pending = new Map();
const __asList = (ids) => Array.isArray(ids) ? ids : [ids];
const __PATCH = ["set", "unset", "text_insert", "text_delete", "list_insert", "list_move", "list_remove", "map_put", "map_delete"];
const __size = (id) => {
  const e = __scene.find((x) => x.id === id);
  if (e) return [e.bounds[2], e.bounds[3]];
  const a = __pending.get(id);
  return [a && a.w || 200, a && a.h || 120];
};
const __place = (id, x, y) => {
  const a = __pending.get(id);
  if (a) a.at = { x: Math.round(x), y: Math.round(y) };
  else __ops.push({ op: "patch", id, set: { at: { x: Math.round(x), y: Math.round(y) } } });
};
globalThis.space = {
  /** Every Element as read's outline shows it, plus what this code added so far (without bounds). */
  get elements() { return __scene.concat([...__pending.values()].map((a) => ({ id: a.id, type: a.type, by: "you", text: a.text }))); },
  add(fields) { const op = Object.assign({ op: "add" }, fields); __ops.push(op); if (op.id) __pending.set(op.id, op); return op.id; },
  patch(id, change) {
    const keys = Object.keys(change || {});
    __ops.push(keys.some((k) => __PATCH.includes(k)) ? Object.assign({ op: "patch", id }, change) : { op: "patch", id, set: change });
  },
  remove(ids) { __ops.push({ op: "remove", ids: __asList(ids) }); },
  arrange(fields) { __ops.push(Object.assign({ op: "arrange" }, fields)); },
  focus(fields) { __ops.push(Object.assign({ op: "focus" }, fields)); },
  get(id) { return this.elements.find((e) => e.id === id); },
  /** find({type, text, by, ids, inside: [x, y, w, h]}): Elements matching every field given. */
  find(q) {
    q = q || {};
    return this.elements.filter((e) =>
      (!q.type || e.type === q.type) &&
      (!q.by || e.by === q.by) &&
      (!q.ids || q.ids.includes(e.id)) &&
      (!q.text || String(e.text || "").toLowerCase().includes(String(q.text).toLowerCase())) &&
      (!q.inside || (e.bounds && e.bounds[0] >= q.inside[0] && e.bounds[1] >= q.inside[1] && e.bounds[0] + e.bounds[2] <= q.inside[0] + q.inside[2] && e.bounds[1] + e.bounds[3] <= q.inside[1] + q.inside[3])));
  },
  layout: {
    /** Places ids evenly on a circle. */
    circle(ids, o) {
      o = o || {};
      const [cx, cy] = o.center || [0, 0];
      const r = o.radius || Math.max(200, ids.length * 40);
      ids.forEach((id, i) => {
        const t = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
        const [w, h] = __size(id);
        __place(id, cx + Math.cos(t) * r - w / 2, cy + Math.sin(t) * r - h / 2);
      });
    },
    /** A force-directed layout of ids, pulled together along the connectors between them. */
    force(ids, o) {
      o = o || {};
      const n = ids.length;
      if (!n) return;
      const idx = new Map(ids.map((id, i) => [id, i]));
      const edges = [];
      for (const c of this.__connectors()) if (idx.has(c.from) && idx.has(c.to)) edges.push([idx.get(c.from), idx.get(c.to)]);
      const k = o.spacing || 260;
      const p = ids.map((_, i) => [Math.cos(i * 2.399963) * k * Math.sqrt(i + 1) * 0.5, Math.sin(i * 2.399963) * k * Math.sqrt(i + 1) * 0.5]);
      const iters = Math.min(o.iterations || 300, 2000);
      for (let it = 0; it < iters; it++) {
        const d = p.map(() => [0, 0]);
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          let dx = p[i][0] - p[j][0], dy = p[i][1] - p[j][1];
          const dist = Math.max(1, Math.hypot(dx, dy));
          const f = (k * k) / dist;
          dx /= dist; dy /= dist;
          d[i][0] += dx * f; d[i][1] += dy * f; d[j][0] -= dx * f; d[j][1] -= dy * f;
        }
        for (const [a, b] of edges) {
          let dx = p[a][0] - p[b][0], dy = p[a][1] - p[b][1];
          const dist = Math.max(1, Math.hypot(dx, dy));
          const f = (dist * dist) / k;
          dx /= dist; dy /= dist;
          d[a][0] -= dx * f; d[a][1] -= dy * f; d[b][0] += dx * f; d[b][1] += dy * f;
        }
        const temp = k * (1 - it / iters) * 0.5 + 1;
        for (let i = 0; i < n; i++) {
          const len = Math.max(1, Math.hypot(d[i][0], d[i][1]));
          p[i][0] += (d[i][0] / len) * Math.min(len, temp);
          p[i][1] += (d[i][1] / len) * Math.min(len, temp);
        }
      }
      const [ox, oy] = o.origin || [0, 0];
      const minx = Math.min(...p.map((q) => q[0])), miny = Math.min(...p.map((q) => q[1]));
      ids.forEach((id, i) => __place(id, ox + p[i][0] - minx, oy + p[i][1] - miny));
    },
  },
  __connectors() {
    return __scene.filter((e) => e.type === "connector").concat([...__ops].filter((o) => o.op === "add" && o.type === "connector"));
  },
};
`;

export type ExecOutput = { ops: Record<string, any>[]; result: unknown; logs: string[] } | { error: string; logs: string[] };

export async function runExec(code: string, scene: Record<string, any>[], o: { ms?: number } = {}): Promise<ExecOutput> {
  const qjs = await (quickjs ??= getQuickJS());
  const rt = qjs.newRuntime();
  rt.setMemoryLimit(64 * 1024 * 1024);
  rt.setMaxStackSize(1024 * 1024);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + (o.ms ?? 5000)));
  const vm = rt.newContext();
  try {
    const sceneJson = vm.newString(JSON.stringify(scene));
    vm.setProp(vm.global, "__sceneJson", sceneJson);
    sceneJson.dispose();
    const program = `${PRELUDE}\nconst __result = (function () {\n${code}\n})();\nJSON.stringify({ ops: __ops, result: __result === undefined ? null : __result, logs: __logs });`;
    const r = vm.evalCode(program, "exec.js");
    if (r.error) {
      const err = vm.dump(r.error);
      r.error.dispose();
      const logs = (() => {
        const l = vm.evalCode("JSON.stringify(typeof __logs === 'undefined' ? [] : __logs)");
        if (l.error) {
          l.error.dispose();
          return [];
        }
        const v = JSON.parse(vm.getString(l.value));
        l.value.dispose();
        return v;
      })();
      const msg = typeof err === "object" && err ? `${err.name ?? "Error"}: ${err.message ?? JSON.stringify(err)}${err.stack ? `\n${String(err.stack).split("\n").slice(0, 3).join("\n")}` : ""}` : String(err);
      return { error: msg.slice(0, 1500), logs };
    }
    const out = JSON.parse(vm.getString(r.value));
    r.value.dispose();
    return out;
  } finally {
    vm.dispose();
    rt.dispose();
  }
}
