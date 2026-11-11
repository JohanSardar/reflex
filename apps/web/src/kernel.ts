// The Reflex kernel in the browser: the same WASM build the Link and the
// Relay run (kernel/wasm, built with --target web), served at /kernel/.
import type { Space as KernelSpace } from "../../../kernel/wasm/pkg/reflex_kernel_wasm.js";

export type Space = KernelSpace;
type KernelModule = {
  default: (o: { module_or_path: string }) => Promise<unknown>;
  Space: { create(space: string, kind: string, actorHex: string): Space };
};

let ready: Promise<KernelModule> | undefined;

/** Loads the kernel once. */
export function kernel(): Promise<KernelModule> {
  ready ??= (async () => {
    const url = "/kernel/reflex_kernel_wasm.js";
    const mod = (await import(url)) as KernelModule;
    await mod.default({ module_or_path: "/kernel/reflex_kernel_wasm_bg.wasm" });
    return mod;
  })();
  return ready;
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
