// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ReflexEmbed",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "ReflexEmbed", targets: ["ReflexEmbed"]),
    ],
    targets: [
        // Resources/bridge.js links to apps/web/src/bridge.js: one bridge for the web and the iPad.
        .target(name: "ReflexEmbed", resources: [.copy("Resources/bridge.js")]),
    ]
)
