// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ReflexInput",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "ReflexInput", targets: ["ReflexInput"]),
    ],
    targets: [
        .target(name: "ReflexInput"),
        .testTarget(name: "ReflexInputTests", dependencies: ["ReflexInput"]),
    ]
)
