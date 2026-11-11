// The Reflex kernel in Node: loads the WASM synchronously from disk.
import { readFileSync } from "node:fs";
import { initSync, Space } from "../pkg/reflex_kernel_wasm.js";

initSync({ module: readFileSync(new URL("../pkg/reflex_kernel_wasm_bg.wasm", import.meta.url)) });

export { Space };
