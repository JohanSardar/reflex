// swift-tools-version: 6.0
// reflex-p2p: the Apple-only helper behind the Link's peer-to-peer transport
// (link/transports/p2p.ts). It listens over Apple peer-to-peer Wi-Fi with
// Network.framework and pipes each connection's bytes to the Link on stdio.
import PackageDescription

let package = Package(
    name: "reflex-p2p",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "reflex-p2p", path: "Sources/reflex-p2p"),
    ]
)
