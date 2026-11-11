// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ReflexRender",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "ReflexRender", targets: ["ReflexRender"]),
    ],
    targets: [
        .target(name: "ReflexRender"),
    ]
)
