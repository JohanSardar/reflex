import SwiftUI
import UIKit

/// Draws a scene's Elements in Space coordinates, following the Ink canvas's
/// scroll offset and zoom. It sits under the Ink layer and never re-renders
/// Ink: the person's own strokes are PencilKit's, so `ink` Elements are skipped.
public struct ElementsLayer: View {
    let scene: SceneDocument
    let offset: CGPoint
    let zoom: CGFloat
    let spaceSize: CGSize

    public init(scene: SceneDocument, offset: CGPoint, zoom: CGFloat, spaceSize: CGSize) {
        self.scene = scene
        self.offset = offset
        self.zoom = zoom
        self.spaceSize = spaceSize
    }

    /// Containers first, then shapes and text, then connectors (as in `agent/src/render.ts`).
    private static let layer: [String: Int] = ["region": 0, "frame": 1, "image": 2, "embed": 2, "file": 2, "connector": 4]

    public var body: some View {
        let drawn = scene.elements
            .filter { $0.type != "ink" }
            .sorted { (Self.layer[$0.type] ?? 3) < (Self.layer[$1.type] ?? 3) }
        var frames: [String: CGRect] = [:]
        for element in drawn { frames[element.id] = element.frame }
        // Color.clear takes the screen's size; the Space-sized content hangs off
        // it as an overlay, so it never makes the screen layout larger.
        return Color.clear.overlay(alignment: .topLeading) {
            ZStack(alignment: .topLeading) {
                ForEach(drawn) { element in
                    if element.type == "connector" {
                        ConnectorView(element: element, frames: frames)
                    } else if let frame = element.frame {
                        ElementView(element: element)
                            .frame(width: frame.width, height: frame.height)
                            .offset(x: frame.minX, y: frame.minY)
                    }
                }
            }
            .frame(width: spaceSize.width, height: spaceSize.height, alignment: .topLeading)
            .scaleEffect(zoom, anchor: .topLeading)
            .offset(x: -offset.x, y: -offset.y)
        }
        .clipped()
        .allowsHitTesting(false)
    }
}

struct ElementView: View {
    let element: SceneElement

    var body: some View {
        switch element.type {
        case "text": textView
        case "shape": ShapeElementView(element: element)
        case "note": noteView
        case "math": mathView
        case "image": ImageElementView(element: element)
        case "frame": frameView
        case "region": regionView
        default: unknownView
        }
    }

    private var textView: some View {
        let size = Palette.textSize[element.size ?? ""] ?? 18
        let string = element.text ?? ""
        let content: Text
        if element.markdown == true, let attributed = try? AttributedString(
            markdown: string, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            content = Text(attributed)
        } else {
            content = Text(string)
        }
        let alignment: Alignment = element.align == "middle" ? .top : element.align == "end" ? .topTrailing : .topLeading
        return content
            .font(.system(size: size, weight: element.markdown == true && string.hasPrefix("#") ? .semibold : .regular))
            .foregroundStyle(Palette.color(element.color))
            .multilineTextAlignment(element.align == "middle" ? .center : element.align == "end" ? .trailing : .leading)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
            .accessibilityIdentifier(element.id)
    }

    private var noteView: some View {
        Text(element.text ?? "")
            .font(.system(size: 17))
            .foregroundStyle(Palette.color("black"))
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Palette.tint(element.color, default: "yellow"))
            .overlay(Rectangle().stroke(Palette.color(element.color, default: "yellow"), lineWidth: 1.5))
            .shadow(color: .black.opacity(0.10), radius: 3, y: 2)
            .accessibilityIdentifier(element.id)
    }

    private var mathView: some View {
        Text(element.latex ?? "")
            .font(.system(size: Palette.textSize[element.size ?? ""] ?? 22, design: .serif).italic())
            .foregroundStyle(Palette.color(element.color))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .accessibilityIdentifier(element.id)
    }

    private var frameView: some View {
        RoundedRectangle(cornerRadius: 6)
            .stroke(Palette.color("grey"), lineWidth: 1.5)
            .overlay(alignment: .topLeading) {
                if let title = element.title {
                    Text(title).font(.system(size: 15)).foregroundStyle(Palette.color("grey")).fixedSize().offset(y: -22)
                }
            }
            .accessibilityIdentifier(element.id)
    }

    private var regionView: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Palette.tint("blue").opacity(0.35))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.color("blue"), style: StrokeStyle(lineWidth: 1.5, dash: [8, 6])))
            .overlay(alignment: .topLeading) {
                if let title = element.title {
                    Text(title).font(.system(size: 15)).foregroundStyle(Palette.color("blue")).padding(8)
                }
            }
            .accessibilityIdentifier(element.id)
    }

    private var unknownView: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Color(red: 0.96, green: 0.96, blue: 0.97))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])).foregroundStyle(Palette.color("grey")))
            .overlay(Text(label).font(.caption).foregroundStyle(Palette.color("grey")).padding(6))
            .accessibilityIdentifier(element.id)
    }

    private var label: String {
        switch element.type {
        case "embed": "embed: \(element.template ?? "html")"
        case "file": "file: \(element.name ?? "")"
        default: element.type
        }
    }
}

struct ShapeElementView: View {
    let element: SceneElement

    var body: some View {
        let line = Palette.color(element.color, default: "black")
        let fill: Color = switch element.fill {
        case "solid": Palette.color(element.color, default: "blue")
        case "tint": Palette.tint(element.color)
        default: .white
        }
        let ink = element.fill == "solid" ? Color.white : Palette.color("black")
        let dash: [CGFloat] = element.stroke == "dashed" ? [10, 6] : element.stroke == "dotted" ? [2, 5] : []
        let style = StrokeStyle(lineWidth: 2.5, dash: dash)
        let shape = AnyShape(Self.outline(element.shape))
        ZStack {
            shape.fill(fill)
            shape.stroke(line, style: style)
            if let text = element.text {
                Text(text)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(ink)
                    .multilineTextAlignment(.center)
                    .padding(8)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(element.id)
    }

    static func outline(_ name: String?) -> any Shape {
        switch name {
        case "ellipse": Ellipse()
        case "diamond": Polygon(points: [(0.5, 0), (1, 0.5), (0.5, 1), (0, 0.5)])
        case "triangle": Polygon(points: [(0.5, 0), (1, 1), (0, 1)])
        case "hexagon": Polygon(points: [(0.25, 0), (0.75, 0), (1, 0.5), (0.75, 1), (0.25, 1), (0, 0.5)])
        case "rounded": RoundedRectangle(cornerRadius: 18)
        default: RoundedRectangle(cornerRadius: 3)
        }
    }
}

/// A closed polygon through unit points scaled to the rect.
struct Polygon: Shape {
    let points: [(CGFloat, CGFloat)]

    func path(in rect: CGRect) -> Path {
        Path { p in
            for (i, (x, y)) in points.enumerated() {
                let pt = CGPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height)
                if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
            }
            p.closeSubpath()
        }
    }
}

struct ImageElementView: View {
    let element: SceneElement

    var body: some View {
        Group {
            if let image = Self.load(element.src) {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Rectangle().fill(Color.secondary.opacity(0.15))
                    .overlay(Image(systemName: "photo").foregroundStyle(.secondary))
            }
        }
        .accessibilityLabel(element.alt ?? "Image")
        .accessibilityIdentifier(element.id)
    }

    /// `data:` URLs. Assets (`asset:<hash>`) are drawn once the iPad fetches them.
    static func load(_ src: String?) -> UIImage? {
        guard let src, src.hasPrefix("data:"), let comma = src.firstIndex(of: ",") else { return nil }
        let payload = String(src[src.index(after: comma)...])
        return Data(base64Encoded: payload).flatMap(UIImage.init(data:))
    }
}

/// A line between two Elements, clipped to their edges, or a free polyline,
/// with arrowheads and an optional label at its middle.
struct ConnectorView: View {
    let element: SceneElement
    let frames: [String: CGRect]

    var body: some View {
        if let points = Self.points(element, frames), points.count >= 2 {
            let color = Palette.color(element.color)
            let arrow = element.arrow ?? "end"
            let dash: [CGFloat] = element.stroke == "dashed" ? [10, 6] : element.stroke == "dotted" ? [2, 5] : []
            ZStack(alignment: .topLeading) {
                Path { p in
                    p.move(to: points[0])
                    for pt in points.dropFirst() { p.addLine(to: pt) }
                }
                .stroke(color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round, dash: dash))
                if arrow == "end" || arrow == "both" {
                    Self.arrowhead(at: points[points.count - 1], from: points[points.count - 2]).fill(color)
                }
                if arrow == "start" || arrow == "both" {
                    Self.arrowhead(at: points[0], from: points[1]).fill(color)
                }
                if let text = element.text, !text.isEmpty {
                    let a = points[(points.count - 1) / 2], b = points[points.count / 2]
                    Text(text)
                        .font(.system(size: 14))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.white)
                        .fixedSize()
                        .position(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(element.id)
        }
    }

    static func points(_ e: SceneElement, _ frames: [String: CGRect]) -> [CGPoint]? {
        if let from = e.from.flatMap({ frames[$0] }), let to = e.to.flatMap({ frames[$0] }) {
            return [
                edgePoint(of: from, toward: CGPoint(x: to.midX, y: to.midY)),
                edgePoint(of: to, toward: CGPoint(x: from.midX, y: from.midY)),
            ]
        }
        if let pts = e.points { return pts.compactMap { $0.count >= 2 ? CGPoint(x: $0[0], y: $0[1]) : nil } }
        guard let f = e.frame else { return nil }
        return [CGPoint(x: f.minX, y: f.minY), CGPoint(x: f.maxX, y: f.maxY)]
    }

    /// Where the line from the center of `rect` toward `target` leaves `rect`.
    static func edgePoint(of rect: CGRect, toward target: CGPoint) -> CGPoint {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let dx = target.x - center.x, dy = target.y - center.y
        guard dx != 0 || dy != 0 else { return center }
        let sx = dx == 0 ? CGFloat.infinity : (rect.width / 2) / abs(dx)
        let sy = dy == 0 ? CGFloat.infinity : (rect.height / 2) / abs(dy)
        let s = min(sx, sy)
        return CGPoint(x: center.x + dx * s, y: center.y + dy * s)
    }

    static func arrowhead(at tip: CGPoint, from start: CGPoint) -> Path {
        let angle = atan2(tip.y - start.y, tip.x - start.x)
        let length: CGFloat = 12, spread: CGFloat = .pi / 7
        return Path { p in
            p.move(to: tip)
            p.addLine(to: CGPoint(x: tip.x - length * cos(angle - spread), y: tip.y - length * sin(angle - spread)))
            p.addLine(to: CGPoint(x: tip.x - length * cos(angle + spread), y: tip.y - length * sin(angle + spread)))
            p.closeSubpath()
        }
    }
}
