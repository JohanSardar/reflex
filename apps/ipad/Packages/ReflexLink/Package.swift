// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ReflexLink",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "ReflexLink", targets: ["ReflexLink"])
    ],
    targets: [
        .target(name: "ReflexLink")
    ]
)
