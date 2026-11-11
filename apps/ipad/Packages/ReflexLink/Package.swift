// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ReflexLink",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "ReflexLink", targets: ["ReflexLink"]),
    ],
    dependencies: [
        .package(name: "ReflexKernel", path: "../../../../kernel/swift"),
    ],
    targets: [
        .target(name: "ReflexLink", dependencies: [.product(name: "ReflexKernel", package: "ReflexKernel")]),
    ]
)
