// The Reflex kernel in Cloudflare Workers: wrangler hands over the compiled
// WebAssembly.Module for a .wasm import, so instantiation is synchronous.
import wasm from "../pkg/reflex_kernel_wasm_bg.wasm";
import { initSync, Space } from "../pkg/reflex_kernel_wasm.js";

initSync({ module: wasm });

export { Space };
