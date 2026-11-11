// Op normalization and repair (ARCHITECTURE §4.2: repair first, warn second,
// reject last). Repairs fix the mistakes models commonly make, and each one is
// reported back in `repaired`. Then every op is checked against the one
// protocol variant it means, so an error names the fields of that variant.
import { ADD_TYPES, explain, variantOf, type ProtocolError } from "../protocol.ts";

type Op = Record<string, any>;

const ALIASES: Record<string, string> = { label: "text", width: "w", height: "h", content: "text", title_text: "text" };
const TEXT_TYPES = new Set(["text", "note", "shape", "connector"]);

function repairOp(op: Op, i: number, repaired: string[]): Op {
  if (op === null || typeof op !== "object" || Array.isArray(op)) return op;
  const o: Op = { ...op };
  const note = (s: string) => repaired.push(`ops[${i}]: ${s}`);
  if (o.op === undefined && typeof o.type === "string") {
    o.op = "add";
    note("no op; treated as add");
  }
  if (o.op === "add") {
    for (const [from, to] of Object.entries(ALIASES)) {
      if (from in o && !(to in o) && !(from === "width" && o.type === "ink")) {
        if (to === "text" && !TEXT_TYPES.has(o.type)) continue;
        o[to] = o[from];
        delete o[from];
        note(`'${from}' read as '${to}'`);
      }
    }
    if (("x" in o || "y" in o) && !("at" in o)) {
      o.at = { x: Math.round(o.x ?? 0), y: Math.round(o.y ?? 0) };
      delete o.x;
      delete o.y;
      note("x and y moved into at");
    }
    if (o.type === "shape" && o.shape === undefined) {
      o.shape = "rect";
      note("shape defaulted to rect");
    }
    if (o.type === "rect" || o.type === "ellipse" || o.type === "diamond") {
      o.shape = o.type;
      o.type = "shape";
      note(`type '${o.shape}' read as a shape`);
    }
    if ((o.type === "arrow" || o.type === "line") && !ADD_TYPES.includes(o.type)) {
      o.type = "connector";
      note("arrow read as a connector");
    }
  }
  if (o.op === "patch") {
    if (o.set && typeof o.set === "object" && ("x" in o.set || "y" in o.set)) {
      const set = { ...o.set };
      set.at = { x: Math.round(set.x ?? 0), y: Math.round(set.y ?? 0) };
      delete set.x;
      delete set.y;
      o.set = set;
      note("set.x and set.y moved into set.at");
    }
    for (const k of ["text_insert", "text_delete"]) {
      if (o[k] && !Array.isArray(o[k]) && typeof o[k] === "object") {
        o[k] = [{ field: "text", ...o[k] }];
        note(`${k} wrapped in a list`);
      }
    }
    for (const k of ["map_put"]) {
      const v = o[k];
      if (v && !Array.isArray(v) && typeof v === "object") {
        o[k] = Object.entries(v).map(([key, value]) => ({ field: "data", key, value }));
        note(`${k} object read as data keys`);
      }
    }
    if (Array.isArray(o.map_delete) && o.map_delete.every((k: unknown) => typeof k === "string")) {
      o.map_delete = o.map_delete.map((key: string) => ({ field: "data", key }));
      note("map_delete keys read as data keys");
    }
  }
  if ((o.op === "remove" || o.op === "arrange" || o.op === "focus") && typeof o.ids === "string") {
    o.ids = [o.ids];
    note("ids wrapped in a list");
  }
  for (const k of ["w", "h", "gap"]) if (typeof o[k] === "number" && !Number.isInteger(o[k])) o[k] = Math.round(o[k]);
  if (o.at && typeof o.at === "object") for (const k of ["x", "y", "gap"]) if (typeof o.at[k] === "number" && !Number.isInteger(o.at[k])) o.at = { ...o.at, [k]: Math.round(o.at[k]) };
  return o;
}

/** Repairs, then checks every op. Returns the ops to send, what was repaired, and every error. */
export function normalizeOps(ops: unknown[]): { ops: Op[]; repaired: string[]; errors: ProtocolError[] } {
  const repaired: string[] = [];
  const errors: ProtocolError[] = [];
  const out = ops.map((op, i) => repairOp(op as Op, i, repaired));
  out.forEach((op, i) => {
    if (op === null || typeof op !== "object" || Array.isArray(op)) {
      errors.push({ op: i, code: "invalid_input", msg: `ops[${i}] is not an object.`, fix: 'Each op is an object with an "op" field.' });
      return;
    }
    const v = variantOf(op);
    if (!v) {
      if (op.op === "add" && op.type === undefined)
        errors.push({ op: i, field: "/type", code: "invalid_input", msg: `ops[${i}] adds an Element without a type.`, fix: `Set type to one of: ${ADD_TYPES.join(", ")}.` });
      else if (op.op === "define")
        errors.push({ op: i, field: "/kind", code: "invalid_input", msg: `ops[${i}] defines something without a known kind.`, fix: 'Set kind to "recipe" or "embed".' });
      else
        errors.push({ op: i, field: "/op", code: "invalid_input", msg: `ops[${i}].op ${JSON.stringify(op.op)} is not an op.`, fix: "Use one of: add, patch, remove, arrange, focus, define." });
      return;
    }
    if (v.title === "add extension" && !("props" in op)) {
      errors.push({
        op: i,
        field: "/type",
        code: "unknown_type",
        msg: `ops[${i}]: '${op.type}' is not a built-in Element type.`,
        fix: `Use one of: ${ADD_TYPES.join(", ")}. Extension types need props; read_me("index") lists them.`,
      });
      return;
    }
    if (!v.validate(op)) errors.push(...explain(v.validate.errors ?? [], `ops[${i}]`, v.fields, i));
  });
  return { ops: out, repaired, errors };
}
