import CoreGraphics
import Foundation
import SwiftUI

/// A Space's scene as the kernel projects it: Protocol v0 Elements
/// (`protocol/schema/element.schema.json`), from `scene({detail: "full"})`.
/// Built-in types have typed, top-level fields; `bounds` is `[x, y, w, h]` in
/// Space points. Fields this app doesn't draw yet are ignored, and a type it
/// doesn't know is drawn as a labelled placeholder.
public struct SceneDocument: Decodable, Sendable, Equatable {
    public var space: String?
    public var elements: [SceneElement]

    public init(space: String?, elements: [SceneElement]) {
        self.space = space
        self.elements = elements
    }

    public static func decode(_ json: String) throws -> SceneDocument {
        try JSONDecoder().decode(SceneDocument.self, from: Data(json.utf8))
    }
}

public struct SceneElement: Decodable, Identifiable, Sendable, Equatable {
    public struct Owner: Decodable, Sendable, Equatable {
        public var person: String?
        public var agent: String?
        public var name: String?
    }

    public var id: String
    public var type: String
    public var owner: Owner?
    public var bounds: [Double]?
    public var text: String?
    public var markdown: Bool?
    /// `s`, `m`, `l` or `xl`.
    public var size: String?
    /// A named protocol color: black, grey, white, red, orange, yellow, green, teal, blue, violet, pink.
    public var color: String?
    /// `start`, `middle` or `end`.
    public var align: String?
    /// `rect`, `rounded`, `ellipse`, `diamond`, `triangle` or `hexagon`.
    public var shape: String?
    /// `none`, `tint` or `solid`.
    public var fill: String?
    /// `solid`, `dashed` or `dotted`.
    public var stroke: String?
    public var from: String?
    public var to: String?
    /// `end` (default), `start`, `both` or `none`.
    public var arrow: String?
    /// A free polyline, when a connector has no `from` and `to`.
    public var points: [[Double]]?
    public var src: String?
    public var alt: String?
    public var latex: String?
    public var title: String?
    public var name: String?
    public var template: String?

    public var frame: CGRect? {
        guard let b = bounds, b.count == 4 else { return nil }
        return CGRect(x: b[0], y: b[1], width: b[2], height: b[3])
    }

    public var isAgents: Bool { owner?.agent != nil }
}

/// The named colors, matching the Agent layer's renderer (`agent/src/render.ts`),
/// so a `look` and the iPad agree.
enum Palette {
    static let strong: [String: UInt32] = [
        "black": 0x1d1d1f, "grey": 0x8e8e93, "white": 0xffffff, "red": 0xe5484d, "orange": 0xf76b15,
        "yellow": 0xf5c400, "green": 0x30a46c, "teal": 0x12a594, "blue": 0x0090ff, "violet": 0x6e56cf, "pink": 0xd6409f,
    ]
    static let tint: [String: UInt32] = [
        "black": 0xe8e8ea, "grey": 0xf0f0f2, "white": 0xffffff, "red": 0xffe5e5, "orange": 0xffefe0,
        "yellow": 0xfff8c5, "green": 0xe2f6ea, "teal": 0xdff6f2, "blue": 0xe1f0ff, "violet": 0xeeeaff, "pink": 0xfde8f3,
    ]
    static let textSize: [String: CGFloat] = ["s": 14, "m": 18, "l": 24, "xl": 34]

    static func color(_ name: String?, default fallback: String = "black") -> Color {
        rgb(strong[name ?? ""] ?? strong[fallback]!)
    }

    static func tint(_ name: String?, default fallback: String = "blue") -> Color {
        rgb(tint[name ?? ""] ?? tint[fallback]!)
    }

    static func rgb(_ v: UInt32) -> Color {
        Color(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}
