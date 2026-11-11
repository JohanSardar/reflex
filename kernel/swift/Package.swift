// swift-tools-version: 5.10
// The Reflex kernel for Swift: the Rust kernel as an XCFramework plus the
// UniFFI-generated bindings. Run kernel/swift/build.sh first; both are build
// outputs and are not checked in.
import PackageDescription

let package = Package(
    name: "ReflexKernel",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "ReflexKernel", targets: ["ReflexKernel"]),
    ],
    targets: [
        .binaryTarget(name: "reflex_kernel_ffiFFI", path: "ReflexKernelFFI.xcframework"),
        .target(name: "ReflexKernel", dependencies: ["reflex_kernel_ffiFFI"], path: "Sources/ReflexKernel"),
    ]
)
