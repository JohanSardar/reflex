import CoreGraphics
import Foundation

/// A Space's scene as the canvas draws it.
///
/// This is a stand-in for the scene JSON the protocol (T1) defines, shaped after
/// ARCHITECTURE §4.3: typed top-level fields for built-in types, `bounds` as
/// `[x, y, w, h]` in Space points, and `by` naming whose Element it is. The
/// kernel's `scene` replaces the bundled file in the round-trip ticket (T6).
public struct SceneDocument: Decodable, Sendable {
    public var space: String
    public var elements: [SceneElement]

    public static func load(from url: URL) throws -> SceneDocument {
        try JSONDecoder().decode(SceneDocument.self, from: Data(contentsOf: url))
    }
}

public struct SceneElement: Decodable, Identifiable, Sendable {
    public var id: String
    /// `text`, `shape`, `note`, `connector`, `image`, or a type this app doesn't
    /// know yet, which is drawn as a labelled placeholder and kept as-is.
    public var type: String
    public var by: String?
    public var bounds: [Double]?
    public var text: String?
    /// `plain` (default) or `markdown`, for `text`.
    public var format: String?
    /// `rect` (default), `rounded`, `ellipse` or `diamond`, for `shape`.
    public var shape: String?
    /// Connector endpoints: Element IDs.
    public var from: String?
    public var to: String?
    /// Image source: a `data:` URL or the name of a bundled resource.
    public var src: String?
    public var style: Style?

    public struct Style: Decodable, Sendable {
        public var fill: String?
        public var stroke: String?
        public var color: String?
        public var size: Double?
        public var dash: Bool?
    }

    public var frame: CGRect? {
        guard let b = bounds, b.count == 4 else { return nil }
        return CGRect(x: b[0], y: b[1], width: b[2], height: b[3])
    }
}
