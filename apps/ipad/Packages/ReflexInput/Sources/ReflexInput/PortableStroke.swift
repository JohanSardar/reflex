import Foundation
import PencilKit

/// The portable form of a finished stroke, captured only inside an explicit Send.
/// The native PencilKit archive stays on the iPad.
///
/// Coordinates are Space points. `points` are the path's control points, before
/// `transform`. `visible` lists the parametric ranges of the path left after a
/// precise erase; a stroke never erased has one range covering the whole path.
public struct PortableStroke: Codable, Equatable, Sendable {
    public struct Point: Codable, Equatable, Sendable {
        public var x: Double
        public var y: Double
        /// Seconds since the stroke began.
        public var t: Double
        public var force: Double
        public var azimuth: Double
        public var altitude: Double
        public var width: Double
        public var height: Double
        public var opacity: Double
    }

    public var id: String
    public var parent: String?
    public var ink: String
    public var color: String
    public var transform: [Double]
    public var createdAt: Date
    public var visible: [[Double]]
    /// Rendered bounds in Space points, as `[x, y, w, h]`.
    public var bounds: [Double]
    public var points: [Point]

    /// The visible points in Space coordinates for a Send:
    /// `[x, y, t, pressure]`, with `t` in milliseconds since the stroke began.
    public var spacePoints: [[Double]] {
        let (a, b, c, d, tx, ty) = (transform[0], transform[1], transform[2], transform[3], transform[4], transform[5])
        let shown = points.enumerated().filter { i, _ in
            visible.isEmpty || visible.contains { Double(i) >= $0[0].rounded(.down) && Double(i) <= $0[1].rounded(.up) }
        }
        return shown.map { _, p in
            [
                ((a * p.x + c * p.y + tx) * 10).rounded() / 10, ((b * p.x + d * p.y + ty) * 10).rounded() / 10,
                (p.t * 1000).rounded(), p.force > 0 ? (p.force * 100).rounded() / 100 : 0.5,
            ]
        }
    }

    /// The protocol's named color for this stroke's ink: the nearest of the pen colors.
    public var namedColor: String {
        let hex = color.dropFirst()
        guard hex.count >= 6, let v = UInt32(hex.prefix(6), radix: 16) else { return "black" }
        let r = Int(v >> 16 & 0xff)
        let g = Int(v >> 8 & 0xff)
        let b = Int(v & 0xff)
        if r > 150 && g < 100 { return "red" }
        if b > 150 && r < 100 { return "blue" }
        return "black"
    }

    init(record: StrokeRecord, stroke: PKStroke) {
        id = record.id
        parent = record.parent
        ink = stroke.ink.inkType.rawValue
        color = stroke.ink.color.reflexHex
        let t = stroke.transform
        transform = [t.a, t.b, t.c, t.d, t.tx, t.ty].map(Double.init)
        createdAt = stroke.path.creationDate
        visible = stroke.maskedPathRanges.map { [Double($0.lowerBound), Double($0.upperBound)] }
        let b = stroke.renderBounds
        bounds = [b.minX, b.minY, b.width, b.height].map(Double.init)
        points = stroke.path.map { p in
            Point(
                x: Double(p.location.x), y: Double(p.location.y), t: p.timeOffset,
                force: Double(p.force), azimuth: Double(p.azimuth), altitude: Double(p.altitude),
                width: Double(p.size.width), height: Double(p.size.height), opacity: Double(p.opacity)
            )
        }
    }
}
