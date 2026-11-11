#!/bin/sh
# Builds the Swift binding: the kernel as an XCFramework (iOS device and
# Simulator) plus the UniFFI-generated Swift, into kernel/swift.
# Needs: rustup target add aarch64-apple-ios aarch64-apple-ios-sim
set -eu
cd "$(dirname "$0")/../.."
OUT=kernel/swift
for t in aarch64-apple-ios aarch64-apple-ios-sim; do
  IPHONEOS_DEPLOYMENT_TARGET=17.0 cargo build --release --target "$t" -p reflex-kernel-ffi
done
cargo build --release -p reflex-kernel-ffi
GEN=target/uniffi-swift
rm -rf "$GEN" && mkdir -p "$GEN"
cargo run -q --release -p reflex-kernel-ffi --features bindgen --bin uniffi-bindgen -- \
  generate --library target/release/libreflex_kernel_ffi.dylib --language swift --out-dir "$GEN"

# Headers and module map for the C layer.
INC=target/uniffi-swift/include
mkdir -p "$INC"
cp "$GEN"/reflex_kernel_ffiFFI.h "$INC"/
cat > "$INC"/module.modulemap <<'MAP'
module reflex_kernel_ffiFFI {
    header "reflex_kernel_ffiFFI.h"
    export *
}
MAP
rm -rf "$OUT"/ReflexKernelFFI.xcframework
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libreflex_kernel_ffi.a -headers "$INC" \
  -library target/aarch64-apple-ios-sim/release/libreflex_kernel_ffi.a -headers "$INC" \
  -output "$OUT"/ReflexKernelFFI.xcframework >/dev/null
mkdir -p "$OUT"/Sources/ReflexKernel
cp "$GEN"/reflex_kernel_ffi.swift "$OUT"/Sources/ReflexKernel/reflex_kernel_ffi.swift
ls -l target/aarch64-apple-ios-sim/release/libreflex_kernel_ffi.a
echo "Swift binding ready in $OUT"
