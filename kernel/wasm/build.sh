#!/bin/sh
# Builds the WASM binding into kernel/wasm/pkg (Node, browsers, Cloudflare Workers).
# Needs: rustup target add wasm32-unknown-unknown; cargo install wasm-bindgen-cli --version <the wasm-bindgen version in Cargo.lock>
set -eu
cd "$(dirname "$0")/../.."
cargo build --release --target wasm32-unknown-unknown -p reflex-kernel-wasm
wasm-bindgen --target web --out-dir kernel/wasm/pkg target/wasm32-unknown-unknown/release/reflex_kernel_wasm.wasm
ls -l kernel/wasm/pkg/reflex_kernel_wasm_bg.wasm
