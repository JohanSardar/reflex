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
    /// embed: an Embed Template's name, its params, inline HTML, or a `ui://` or https URL; its extra hosts; its saved state.
    public var template: String?
    public var params: JSONValue?
    public var html: String?
    public var url: String?
    /// embed: a 3D model, `asset:<sha256>` of a GLB or USDZ.
    public var model: String?
    public var allow: [String]?
    public var state: JSONValue?
    /// What the person entered in this Element's Panels: Panel ID → component ID → value.
    public var values: JSONValue?
    /// The free map its Agent defined.
    public var data: JSONValue?
    /// A file's media type and size in bytes.
    public var mime: String?
    public var fileSize: Int?
    /// A PDF page's 1-based number.
    public var page: Int?
    /// Ink: its pen width.
    public var width: Double?
    public var behaviors: [Behavior]?
    public var draggable: Bool?
    public var locked: Bool?
    /// Region rules: whether the person may write there, watch mode, Agents read-only, and its Send button's label.
    public var ink: Bool?
    public var watch: Bool?
    public var agentsReadOnly: Bool?
    public var sendButton: String?

    enum CodingKeys: String, CodingKey {
        case id, type, owner, bounds, text, markdown, size, color, align, shape, fill, stroke, from, to, arrow, points
        case src, alt, latex, title, name, template, params, html, url, model, allow, state, values, data, mime, page, width, behaviors, draggable, locked
        case ink, watch, agentsReadOnly = "agents_read_only", sendButton = "send_button"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = try c.decode(String.self, forKey: .type)
        owner = try? c.decodeIfPresent(Owner.self, forKey: .owner)
        bounds = try? c.decodeIfPresent([Double].self, forKey: .bounds)
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        markdown = try? c.decodeIfPresent(Bool.self, forKey: .markdown)
        // `size` is a text size on text and a byte count on files.
        size = try? c.decodeIfPresent(String.self, forKey: .size)
        fileSize = try? c.decodeIfPresent(Int.self, forKey: .size)
        color = try? c.decodeIfPresent(String.self, forKey: .color)
        align = try? c.decodeIfPresent(String.self, forKey: .align)
        shape = try? c.decodeIfPresent(String.self, forKey: .shape)
        fill = try? c.decodeIfPresent(String.self, forKey: .fill)
        stroke = try? c.decodeIfPresent(String.self, forKey: .stroke)
        from = try? c.decodeIfPresent(String.self, forKey: .from)
        to = try? c.decodeIfPresent(String.self, forKey: .to)
        arrow = try? c.decodeIfPresent(String.self, forKey: .arrow)
        points = try? c.decodeIfPresent([[Double]].self, forKey: .points)
        src = try? c.decodeIfPresent(String.self, forKey: .src)
        alt = try? c.decodeIfPresent(String.self, forKey: .alt)
        latex = try? c.decodeIfPresent(String.self, forKey: .latex)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        template = try? c.decodeIfPresent(String.self, forKey: .template)
        params = try? c.decodeIfPresent(JSONValue.self, forKey: .params)
        html = try? c.decodeIfPresent(String.self, forKey: .html)
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        allow = try? c.decodeIfPresent([String].self, forKey: .allow)
        state = try? c.decodeIfPresent(JSONValue.self, forKey: .state)
        values = try? c.decodeIfPresent(JSONValue.self, forKey: .values)
        data = try? c.decodeIfPresent(JSONValue.self, forKey: .data)
        mime = try? c.decodeIfPresent(String.self, forKey: .mime)
        page = try? c.decodeIfPresent(Int.self, forKey: .page)
        width = try? c.decodeIfPresent(Double.self, forKey: .width)
        behaviors = try? c.decodeIfPresent([Behavior].self, forKey: .behaviors)
        draggable = try? c.decodeIfPresent(Bool.self, forKey: .draggable)
        locked = try? c.decodeIfPresent(Bool.self, forKey: .locked)
        ink = try? c.decodeIfPresent(Bool.self, forKey: .ink)
        watch = try? c.decodeIfPresent(Bool.self, forKey: .watch)
        agentsReadOnly = try? c.decodeIfPresent(Bool.self, forKey: .agentsReadOnly)
        sendButton = try? c.decodeIfPresent(String.self, forKey: .sendButton)
    }

    public var frame: CGRect? {
        guard let b = bounds, b.count == 4 else { return nil }
        return CGRect(x: b[0], y: b[1], width: b[2], height: b[3])
    }

    public var isAgents: Bool { owner?.agent != nil }

    /// This Element's Behaviors for one trigger, with their index in its list.
    public func behaviors(on trigger: String) -> [(index: Int, behavior: Behavior)] {
        (behaviors ?? []).enumerated().filter { $0.element.on == trigger }.map { ($0.offset, $0.element) }
    }
}

/// What happens when the person interacts with an Element: one trigger paired
/// with one action (`common.schema.json#/$defs/behavior`).
public struct Behavior: Decodable, Sendable, Equatable {
    /// `tap`, `long_press`, `drag_end`, `ink_inside`, `panel_change` or `embed_event`.
    public var on: String
    /// `open_panel`, `notify`, `send`, `set` or `apply_recipe`.
    public var action: String
    public var event: String?
    public var panel: Panel?
    public var payload: JSONValue?
    public var target: String?
    public var set: JSONValue?
    public var recipe: String?
    public var params: JSONValue?

    enum CodingKeys: String, CodingKey {
        case on, action = "do", event, panel, payload, target, set, recipe, params
    }
}

/// Native interface declared as JSON (`common.schema.json#/$defs/panel`).
public struct Panel: Decodable, Sendable, Equatable {
    public var id: String?
    public var title: String?
    public var components: [Component]

    public struct Component: Decodable, Sendable, Equatable, Identifiable {
        /// `text`, `markdown`, `button`, `choice`, `text_field`, `number`, `slider`, `toggle` or `embed`.
        public var kind: String
        public var key: String?
        public var label: String?
        public var text: String?
        public var options: [String]?
        public var multiple: Bool?
        public var value: JSONValue?
        public var min: Double?
        public var max: Double?
        public var step: Double?
        /// button only: `send` or `notify`.
        public var action: String?
        /// embed only: an Embed Template's name and its params, or inline HTML, and its height.
        public var template: String?
        public var params: JSONValue?
        public var html: String?
        public var h: Double?

        public var id: String { key ?? (kind == "embed" ? template ?? "embed" : "\(kind):\(label ?? text ?? "")") }

        enum CodingKeys: String, CodingKey {
            case kind, key = "id", label, text, options, multiple, value, min, max, step, action = "do", template, params, html, h
        }
    }
}

/// Any JSON value, for the open maps Reflex carries without interpreting
/// (`payload`, `set`, `params`, Panel values).
public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// The value as JSON text, keys sorted.
    public var json: String {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? e.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "null"
    }

    /// The fields of an object, or nil.
    public var object: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    /// As Foundation objects, for JSONSerialization.
    public var any: Any {
        switch self {
        case .null: NSNull()
        case .bool(let b): b
        case .number(let n): n == n.rounded() && abs(n) < 9e15 ? Int(n) as Any : n
        case .string(let s): s
        case .array(let a): a.map(\.any)
        case .object(let o): o.mapValues(\.any)
        }
    }

    public init(any v: Any) {
        switch v {
        case let b as Bool: self = .bool(b)
        case let n as Int: self = .number(Double(n))
        case let n as Double: self = .number(n)
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map(JSONValue.init(any:)))
        case let o as [String: Any]: self = .object(o.mapValues(JSONValue.init(any:)))
        default: self = .null
        }
    }
}

/// The named colors, matching the Agent layer's renderer (`agent/src/render.ts`),
/// so a `look` and the iPad agree.
public enum Palette {
    static let strong: [String: UInt32] = [
        "black": 0x1d1d1f, "grey": 0x8e8e93, "white": 0xffffff, "red": 0xe5484d, "orange": 0xf76b15,
        "yellow": 0xf5c400, "green": 0x30a46c, "teal": 0x12a594, "blue": 0x0090ff, "violet": 0x6e56cf, "pink": 0xd6409f,
    ]
    static let tint: [String: UInt32] = [
        "black": 0xe8e8ea, "grey": 0xf0f0f2, "white": 0xffffff, "red": 0xffe5e5, "orange": 0xffefe0,
        "yellow": 0xfff8c5, "green": 0xe2f6ea, "teal": 0xdff6f2, "blue": 0xe1f0ff, "violet": 0xeeeaff, "pink": 0xfde8f3,
    ]
    static let textSize: [String: CGFloat] = ["s": 14, "m": 18, "l": 24, "xl": 34]

    public static func color(_ name: String?, default fallback: String = "black") -> Color {
        rgb(strong[name ?? ""] ?? strong[fallback]!)
    }

    static func tint(_ name: String?, default fallback: String = "blue") -> Color {
        rgb(tint[name ?? ""] ?? tint[fallback]!)
    }

    static func rgb(_ v: UInt32) -> Color {
        Color(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}
