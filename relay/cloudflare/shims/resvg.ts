// @resvg/resvg-js for the Agent layer inside the Worker: resvg's WASM build,
// with DejaVu Sans bundled (a Worker has no system fonts). `ready` must
// resolve before the first render; the log's Durable Object waits for it.
import { initWasm, Resvg as WasmResvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import sans from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf";

let started: Promise<void> | null = null;
export const ready = (): Promise<void> => (started ??= initWasm(wasm));

const font = { fontBuffers: [new Uint8Array(sans)], loadSystemFonts: false, defaultFontFamily: "DejaVu Sans", sansSerifFamily: "DejaVu Sans" };

export class Resvg extends WasmResvg {
  constructor(svg: string, opts: Record<string, unknown> = {}) {
    super(svg, { ...opts, font });
  }
}
