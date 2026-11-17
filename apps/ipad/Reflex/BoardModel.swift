import Foundation
import SwiftUI

// MARK: Paper

extension Paper {
    private static let newBoardsKey = "paperForNewBoards"
    /// The paper new boards start with, chosen with "Use for New Boards".
    static var forNewBoards: Paper {
        get {
            UserDefaults.standard.data(forKey: newBoardsKey).flatMap { try? JSONDecoder().decode(Paper.self, from: $0) }
                ?? Paper()
        }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: newBoardsKey) }
    }
}

struct Paper: Codable, Equatable, Hashable {
    enum Style: String, Codable, CaseIterable, Identifiable {
        case blank, dots, lines, squares
        var id: String { rawValue }
        var name: String { rawValue.capitalized }
        var symbol: String {
            switch self {
            case .blank: "square"
            case .dots: "circle.grid.3x3"
            case .lines: "line.3.horizontal"
            case .squares: "squareshape.split.3x3"
            }
        }
    }

    enum Spacing: String, Codable, CaseIterable, Identifiable {
        case small, medium, large
        var id: String { rawValue }
        var name: String { rawValue.capitalized }
        var points: CGFloat {
            switch self {
            case .small: 16
            case .medium: 28
            case .large: 48
            }
        }
    }

    enum Tint: String, Codable, CaseIterable, Identifiable {
        /// White in Light Mode, dark in Dark Mode.
        case automatic, white, cream, gray, green, blue, dark
        var id: String { rawValue }
        var name: String { self == .automatic ? "Match System" : rawValue.capitalized }

        func color(dark: Bool) -> Color {
            switch self {
            case .automatic: dark ? Color(red: 0.11, green: 0.11, blue: 0.12) : .white
            case .white: .white
            case .cream: Color(red: 0.99, green: 0.97, blue: 0.90)
            case .gray: Color(red: 0.93, green: 0.93, blue: 0.94)
            case .green: Color(red: 0.91, green: 0.96, blue: 0.91)
            case .blue: Color(red: 0.91, green: 0.95, blue: 0.99)
            case .dark: Color(red: 0.11, green: 0.11, blue: 0.12)
            }
        }

        func isDark(system dark: Bool) -> Bool {
            self == .dark || (self == .automatic && dark)
        }
    }

    var style: Style = .dots
    var spacing: Spacing = .medium
    var tint: Tint = .automatic
}

// MARK: Board metadata

struct Viewport: Codable, Equatable {
    var center: CGPoint
    var zoom: CGFloat
}

struct BoardScene: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString
    var name: String
    var rect: CGRect
}

struct BoardMeta: Codable, Equatable, Identifiable {
    var id: String
    var title: String
    var created: Date
    var modified: Date
    var opened: Date?
    var lastUsed: Date { max(opened ?? .distantPast, modified) }
    var favorite = false
    var folder: String?
    var paper = Paper()
    var viewport: Viewport?
    var scenes: [BoardScene] = []
    /// Typed text on the board, for search.
    var text = ""
    /// False until something is put on a new board. Empty new boards are discarded when left;
    /// boards from earlier versions are always kept.
    var hasContent = true
    var version = 1
}

struct BoardFolder: Codable, Equatable, Identifiable, Hashable {
    var id: String = "f_" + UUID().uuidString.prefix(8).lowercased()
    var name: String
    var parent: String?
    var created = Date()
}

// MARK: Objects

enum ShapeKind: String, Codable, CaseIterable, Identifiable {
    case roundedRect, line, arrow, curve, circle, triangle, pentagon, square, diamond, terminator, parallelogram,
        blockArrow
    // More shapes for the library.
    case hexagon, octagon, star, rightTriangle, speech, cloud, heart, plus, chevron, doubleArrow, trapezoid, cylinder
    var id: String { rawValue }

    static let basic: [ShapeKind] = [
        .roundedRect, .line, .arrow, .curve, .circle, .triangle, .pentagon, .square, .diamond, .terminator,
        .parallelogram, .blockArrow,
    ]
    static let more: [ShapeKind] = [
        .hexagon, .octagon, .star, .rightTriangle, .speech, .cloud, .heart, .plus, .chevron, .doubleArrow, .trapezoid,
        .cylinder,
    ]

    var name: String {
        switch self {
        case .roundedRect: "Rounded Rectangle"
        case .line: "Line"
        case .arrow: "Arrow"
        case .curve: "Curve"
        case .circle: "Circle"
        case .triangle: "Triangle"
        case .pentagon: "Pentagon"
        case .square: "Square"
        case .diamond: "Diamond"
        case .terminator: "Capsule"
        case .parallelogram: "Parallelogram"
        case .blockArrow: "Block Arrow"
        case .hexagon: "Hexagon"
        case .octagon: "Octagon"
        case .star: "Star"
        case .rightTriangle: "Right Triangle"
        case .speech: "Speech Bubble"
        case .cloud: "Cloud"
        case .heart: "Heart"
        case .plus: "Plus"
        case .chevron: "Chevron"
        case .doubleArrow: "Double Arrow"
        case .trapezoid: "Trapezoid"
        case .cylinder: "Cylinder"
        }
    }

    /// Lines are drawn as connectors with free ends.
    var isLine: Bool { self == .line || self == .arrow || self == .curve }
}

struct TableData: Codable, Equatable {
    var cells: [[String]]
    var rows: Int { cells.count }
    var cols: Int { cells.first?.count ?? 0 }
}

/// One end of a connector: stuck to an object, or free at a Space point.
struct ConnectorEnd: Codable, Equatable {
    var object: String?
    var point: CGPoint
}

enum ObjectKind: String, Codable {
    case sticky, text, shape, symbol, image, table, connector
}

enum TextAlign: String, Codable, CaseIterable {
    case leading, center, trailing
    var symbol: String {
        switch self {
        case .leading: "text.alignleft"
        case .center: "text.aligncenter"
        case .trailing: "text.alignright"
        }
    }
    var swiftUI: TextAlignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
    var frame: Alignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}

enum LineDash: String, Codable, CaseIterable {
    case none, solid, dashed, dotted
    var name: String { self == .none ? "No Line" : rawValue.capitalized }
}

enum ConnectorStyle: String, Codable, CaseIterable {
    case straight, elbow, curved
    var symbol: String {
        switch self {
        case .straight: "line.diagonal"
        case .elbow: "arrow.turn.down.right"
        case .curved: "point.topleft.down.to.point.bottomright.curvepath"
        }
    }
}

struct BoardObject: Codable, Equatable, Identifiable {
    var id: String = "o_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
    var kind: ObjectKind
    /// Frame in Space points. A connector's frame is its ends' bounds.
    var frame: CGRect
    var text = ""
    var fill: String?
    var stroke: String?
    var dash: LineDash = .solid
    var lineWidth: Double = 2
    var textColor: String?
    var fontSize: Double = 20
    var bold = false
    var italic = false
    var underline = false
    var align: TextAlign = .center
    var shape: ShapeKind?
    var symbol: String?
    var image: String?
    var table: TableData?
    var from: ConnectorEnd?
    var to: ConnectorEnd?
    var startArrow = false
    var endArrow = true
    var connectorStyle: ConnectorStyle = .straight
    var locked = false
    var group: String?
    var shadow = true
    var cornerRadius: Double = 0
    /// Drawn in front of the ink instead of under it. Optional so older boards decode.
    var aboveInk: Bool?

    var isAboveInk: Bool { aboveInk ?? false }
    /// A table left in its default white follows the paper (dark grey with light text on dark paper).
    var autoTableColors: Bool { kind == .table && fill?.uppercased() == "#FFFFFF" && textColor == nil }

    var isConnector: Bool { kind == .connector }
    var hasText: Bool { kind == .sticky || kind == .text || kind == .shape || kind == .table }
}

// MARK: Colors

enum Palette {
    static let sticky: [String] = ["#FBE38A", "#FFC48A", "#FFA8B6", "#D9B8FF", "#A8D5FF", "#B6EBB0", "#E6E6E6"]
    static let fills: [String] = [
        "#78BEF3", "#5AC8C8", "#7CD67C", "#FFD54A", "#FF9F45", "#FF6B6B", "#E57AD6", "#A78BFA", "#8E8E93", "#1C1C1E",
        "#FFFFFF", "#F2E6D0",
    ]
    static let strokes: [String] = [
        "#1C1C1E", "#8E8E93", "#0A84FF", "#30B0C7", "#34C759", "#FFCC00", "#FF9500", "#FF3B30", "#AF52DE", "#FFFFFF",
    ]
    static let text: [String] = [
        "#1C1C1E", "#8E8E93", "#0A84FF", "#34C759", "#FF9500", "#FF3B30", "#AF52DE", "#FFFFFF",
    ]
}

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if s.count == 6 { s += "FF" }
        let v = UInt64(s, radix: 16) ?? 0
        self.init(
            .sRGB, red: Double((v >> 24) & 0xFF) / 255, green: Double((v >> 16) & 0xFF) / 255,
            blue: Double((v >> 8) & 0xFF) / 255, opacity: Double(v & 0xFF) / 255)
    }
}

extension UIColor {
    convenience init(hex: String) {
        var s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if s.count == 6 { s += "FF" }
        let v = UInt64(s, radix: 16) ?? 0
        self.init(
            red: CGFloat((v >> 24) & 0xFF) / 255, green: CGFloat((v >> 16) & 0xFF) / 255,
            blue: CGFloat((v >> 8) & 0xFF) / 255, alpha: CGFloat(v & 0xFF) / 255)
    }
}
