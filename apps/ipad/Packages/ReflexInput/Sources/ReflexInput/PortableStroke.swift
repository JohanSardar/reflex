import Foundation
import PencilKit

/// The portable form of one finished stroke: what the web viewer, export and
/// an Agent's `read(detail: "strokes")` use. The native PencilKit archive is kept
/// next to it for fidelity.
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
