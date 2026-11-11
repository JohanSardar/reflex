// The kernel in the Worker, instantiated here rather than through
// @reflex/kernel/workers so the cloud session can report the WASM memory a
// materialized Space takes (the 128 MB question, ARCHITECTURE §14.3).
import wasm from "../../kernel/wasm/pkg/reflex_kernel_wasm_bg.wasm";
import { initSync, Space } from "../../kernel/wasm/pkg/reflex_kernel_wasm.js";
import type { Kernel } from "../domain/session.ts";

const exports = initSync({ module: wasm }) as unknown as { memory: WebAssembly.Memory };

export const kernel: Kernel = {
  create: (id, kind, actor) => Space.create(id, kind, actor) as never,
  memoryBytes: () => exports.memory.buffer.byteLength,
};
