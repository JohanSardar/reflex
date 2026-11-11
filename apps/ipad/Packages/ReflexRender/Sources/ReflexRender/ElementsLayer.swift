import SwiftUI
import UIKit

/// Draws a scene's Elements in Space coordinates, following the Ink canvas's
/// scroll offset and zoom. It sits under the Ink layer and never re-renders Ink.
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

    private var framesByID: [String: CGRect] {
        var frames: [String: CGRect] = [:]
        for element in scene.elements {
            if let frame = element.frame { frames[element.id] = frame }
        }
        return frames
    }

    public var body: some View {
        let frames = framesByID
        // Color.clear takes the screen's size; the Space-sized content hangs off
        // it as an overlay, so it never makes the screen layout larger.
        Color.clear.overlay(alignment: .topLeading) {
            space(frames: frames)
                .frame(width: spaceSize.width, height: spaceSize.height, alignment: .topLeading)
                .scaleEffect(zoom, anchor: .topLeading)
                .offset(x: -offset.x, y: -offset.y)
        }
        .clipped()
        .allowsHitTesting(false)
    }

    private func space(frames: [String: CGRect]) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(scene.elements.filter { $0.type == "connector" }) { element in
                ConnectorView(element: element, frames: frames)
            }
            ForEach(scene.elements.filter { $0.type != "connector" }) { element in
                if let frame = element.frame {
                    ElementView(element: element)
                        .frame(width: frame.width, height: frame.height)
                        .offset(x: frame.minX, y: frame.minY)
                }
            }
        }
    }
}

struct ElementView: View {
    let element: SceneElement

    var body: some View {
        switch element.type {
        case "text": textView
        case "shape": ShapeElementView(element: element)
        case "note": noteView
        case "image": ImageElementView(element: element)
        default: unknownView
        }
    }

    private var textColor: Color { Color(hex: element.style?.color) ?? .primary }

    private var textView: some View {
        let size = element.style?.size ?? 17
        let string = element.text ?? ""
        let content: Text
        if element.format == "markdown", let attributed = try? AttributedString(
            markdown: string, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            content = Text(attributed)
        } else {
            content = Text(string)
        }
        return content
            .font(.system(size: size))
            .foregroundStyle(textColor)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .accessibilityIdentifier(element.id)
    }

    private var noteView: some View {
        Text(element.text ?? "")
            .font(.system(size: element.style?.size ?? 16))
            .foregroundStyle(Color.black.opacity(0.85))
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color(hex: element.style?.fill) ?? Color(red: 1, green: 0.93, blue: 0.55))
            .shadow(color: .black.opacity(0.12), radius: 3, y: 2)
            .accessibilityIdentifier(element.id)
    }

    private var unknownView: some View {
        RoundedRectangle(cornerRadius: 8)
            .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
            .foregroundStyle(.secondary)
            .overlay(Text(element.type).font(.caption).foregroundStyle(.secondary))
            .accessibilityIdentifier(element.id)
    }
}

struct ShapeElementView: View {
    let element: SceneElement

    var body: some View {
        let fill = Color(hex: element.style?.fill) ?? Color(.systemBackground)
        let stroke = Color(hex: element.style?.stroke) ?? Color.primary
        let dash: [CGFloat] = element.style?.dash == true ? [8, 5] : []
        let style = StrokeStyle(lineWidth: 2, dash: dash)
        ZStack {
            switch element.shape ?? "rect" {
            case "ellipse":
                Ellipse().fill(fill)
                Ellipse().stroke(stroke, style: style)
            case "diamond":
                Diamond().fill(fill)
                Diamond().stroke(stroke, style: style)
            case "rounded":
                RoundedRectangle(cornerRadius: 14).fill(fill)
                RoundedRectangle(cornerRadius: 14).stroke(stroke, style: style)
            default:
                Rectangle().fill(fill)
                Rectangle().stroke(stroke, style: style)
            }
            if let text = element.text {
                Text(text)
                    .font(.system(size: element.style?.size ?? 17, weight: .medium))
                    .foregroundStyle(Color(hex: element.style?.color) ?? .primary)
                    .multilineTextAlignment(.center)
                    .padding(8)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(element.id)
    }
}

struct Diamond: Shape {
    func path(in rect: CGRect) -> Path {
        Path { p in
            p.move(to: CGPoint(x: rect.midX, y: rect.minY))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            p.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
            p.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
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
        .accessibilityLabel(element.text ?? "Image")
        .accessibilityIdentifier(element.id)
    }

    static func load(_ src: String?) -> UIImage? {
        guard let src else { return nil }
        if src.hasPrefix("data:"), let comma = src.firstIndex(of: ",") {
            let payload = String(src[src.index(after: comma)...])
            return Data(base64Encoded: payload).flatMap(UIImage.init(data:))
        }
        return UIImage(named: src)
    }
}

/// A line between two Elements, clipped to their edges, with an arrowhead at
/// `to` and an optional label at its middle.
struct ConnectorView: View {
    let element: SceneElement
    let frames: [String: CGRect]

    var body: some View {
        if let from = element.from.flatMap({ frames[$0] }), let to = element.to.flatMap({ frames[$0] }) {
            let start = Self.edgePoint(of: from, toward: CGPoint(x: to.midX, y: to.midY))
            let end = Self.edgePoint(of: to, toward: CGPoint(x: from.midX, y: from.midY))
            let color = Color(hex: element.style?.stroke) ?? Color.primary
            ZStack(alignment: .topLeading) {
                Path { p in
                    p.move(to: start)
                    p.addLine(to: end)
                }
                .stroke(color, style: StrokeStyle(lineWidth: 2, dash: element.style?.dash == true ? [8, 5] : []))
                Self.arrowhead(at: end, from: start).fill(color)
                if let text = element.text {
                    Text(text)
                        .font(.system(size: 14))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color(.systemBackground))
                        .fixedSize()
                        .position(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(element.id)
        }
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

extension Color {
    /// `#rrggbb` or `#rrggbbaa`.
    init?(hex: String?) {
        guard var s = hex, s.hasPrefix("#") else { return nil }
        s.removeFirst()
        guard s.count == 6 || s.count == 8, let value = UInt64(s, radix: 16) else { return nil }
        let hasAlpha = s.count == 8
        let r = Double((value >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        let g = Double((value >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        let b = Double((value >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        let a = hasAlpha ? Double(value & 0xff) / 255 : 1
        self.init(red: r, green: g, blue: b, opacity: a)
    }
}
