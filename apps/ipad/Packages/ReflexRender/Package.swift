// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ReflexRender",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "ReflexRender", targets: ["ReflexRender"]),
    ],
    dependencies: [
        // Native LaTeX typesetting (CoreText and OpenType math fonts), MIT.
        .package(url: "https://github.com/mgriebling/SwiftMath", exact: "1.7.3"),
        .package(path: "../ReflexEmbed"),
    ],
    targets: [
        .target(name: "ReflexRender", dependencies: [.product(name: "SwiftMath", package: "SwiftMath"), .product(name: "ReflexEmbed", package: "ReflexEmbed")]),
    ]
)
