// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ReflexModel",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "ReflexModel", targets: ["ReflexModel"]),
    ],
    targets: [
        .target(name: "ReflexModel"),
    ]
)
