import PencilKit
import SwiftUI

// MARK: Shapes

struct BoardShape: Shape {
    let kind: ShapeKind

    func path(in r: CGRect) -> Path {
        var p = Path()
        let w = r.width, h = r.height, x = r.minX, y = r.minY
        func pt(_ fx: CGFloat, _ fy: CGFloat) -> CGPoint { CGPoint(x: x + w * fx, y: y + h * fy) }
        func poly(_ pts: [(CGFloat, CGFloat)]) {
            p.move(to: pt(pts[0].0, pts[0].1))
            for q in pts.dropFirst() { p.addLine(to: pt(q.0, q.1)) }
            p.closeSubpath()
        }
        func regular(_ n: Int, rotation: CGFloat = -.pi / 2) {
            let c = CGPoint(x: r.midX, y: r.midY)
            for i in 0 ..< n {
                let a = rotation + CGFloat(i) * 2 * .pi / CGFloat(n)
                let q = CGPoint(x: c.x + cos(a) * w / 2, y: c.y + sin(a) * h / 2)
                if i == 0 { p.move(to: q) } else { p.addLine(to: q) }
            }
            p.closeSubpath()
        }
        switch kind {
        case .roundedRect: p.addRoundedRect(in: r, cornerSize: CGSize(width: min(w, h) * 0.18, height: min(w, h) * 0.18))
        case .square: p.addRect(r)
        case .circle: p.addEllipse(in: r)
        case .triangle: poly([(0.5, 0), (1, 1), (0, 1)])
        case .rightTriangle: poly([(0, 0), (1, 1), (0, 1)])
        case .pentagon: regular(5)
        case .hexagon: regular(6, rotation: 0)
        case .octagon: regular(8, rotation: .pi / 8)
        case .diamond: poly([(0.5, 0), (1, 0.5), (0.5, 1), (0, 0.5)])
        case .terminator: p.addRoundedRect(in: r, cornerSize: CGSize(width: min(w, h) / 2, height: min(w, h) / 2))
        case .parallelogram: poly([(0.25, 0), (1, 0), (0.75, 1), (0, 1)])
        case .trapezoid: poly([(0.2, 0), (0.8, 0), (1, 1), (0, 1)])
        case .blockArrow: poly([(0, 0.3), (0.6, 0.3), (0.6, 0), (1, 0.5), (0.6, 1), (0.6, 0.7), (0, 0.7)])
        case .doubleArrow: poly([(0, 0.5), (0.25, 0), (0.25, 0.3), (0.75, 0.3), (0.75, 0), (1, 0.5), (0.75, 1), (0.75, 0.7), (0.25, 0.7), (0.25, 1)])
        case .chevron: poly([(0, 0), (0.7, 0), (1, 0.5), (0.7, 1), (0, 1), (0.3, 0.5)])
        case .plus: poly([(0.35, 0), (0.65, 0), (0.65, 0.35), (1, 0.35), (1, 0.65), (0.65, 0.65), (0.65, 1), (0.35, 1), (0.35, 0.65), (0, 0.65), (0, 0.35), (0.35, 0.35)])
        case .star:
            let c = CGPoint(x: r.midX, y: r.midY)
            for i in 0 ..< 10 {
                let a = -CGFloat.pi / 2 + CGFloat(i) * .pi / 5
                let k: CGFloat = i % 2 == 0 ? 0.5 : 0.2
                let q = CGPoint(x: c.x + cos(a) * w * k, y: c.y + sin(a) * h * k * 1.05 + h * 0.03)
                if i == 0 { p.move(to: q) } else { p.addLine(to: q) }
            }
            p.closeSubpath()
        case .speech:
            p.addRoundedRect(in: CGRect(x: x, y: y, width: w, height: h * 0.78), cornerSize: CGSize(width: min(w, h) * 0.16, height: min(w, h) * 0.16))
            p.move(to: pt(0.22, 0.74)); p.addLine(to: pt(0.16, 1)); p.addLine(to: pt(0.42, 0.74)); p.closeSubpath()
        case .cloud:
            for (cx, cy, rr) in [(0.3, 0.6, 0.26), (0.5, 0.42, 0.3), (0.72, 0.58, 0.26), (0.5, 0.68, 0.26)] as [(CGFloat, CGFloat, CGFloat)] {
                p.addEllipse(in: CGRect(x: x + w * (cx - rr), y: y + h * (cy - rr), width: w * rr * 2, height: h * rr * 2))
            }
        case .heart:
            p.move(to: pt(0.5, 0.95))
            p.addCurve(to: pt(0.02, 0.32), control1: pt(0.2, 0.75), control2: pt(0.0, 0.55))
            p.addArc(center: pt(0.27, 0.28), radius: w * 0.25, startAngle: .degrees(190), endAngle: .degrees(-20), clockwise: false)
            p.addArc(center: pt(0.73, 0.28), radius: w * 0.25, startAngle: .degrees(200), endAngle: .degrees(-10), clockwise: false)
            p.addCurve(to: pt(0.5, 0.95), control1: pt(1.0, 0.55), control2: pt(0.8, 0.75))
            p.closeSubpath()
        case .cylinder:
            let e = h * 0.14
            p.addEllipse(in: CGRect(x: x, y: y, width: w, height: e * 2))
            p.move(to: CGPoint(x: x, y: y + e)); p.addLine(to: CGPoint(x: x, y: y + h - e))
            p.addArc(center: CGPoint(x: r.midX, y: y + h - e), radius: w / 2, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: true)
            p.addLine(to: CGPoint(x: x + w, y: y + e))
        case .line, .arrow, .curve:
            p.move(to: pt(0, 1)); p.addLine(to: pt(1, 0))
        }
        return p
    }
}

// MARK: Connector geometry

enum ConnectorGeometry {
    /// Where the line from a rectangle's middle toward a point leaves the rectangle.
    static func edgePoint(of r: CGRect, toward p: CGPoint, oval: Bool = false) -> CGPoint {
        let c = CGPoint(x: r.midX, y: r.midY)
        let dx = p.x - c.x, dy = p.y - c.y
        guard dx != 0 || dy != 0 else { return c }
        if oval {
            // Where the ray meets the ellipse, plus a small gap.
            let a = r.width / 2 + 6, b = r.height / 2 + 6
            let s = 1 / sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b))
            return CGPoint(x: c.x + dx * s, y: c.y + dy * s)
        }
        let sx = dx == 0 ? .infinity : (r.width / 2 + 6) / abs(dx)
        let sy = dy == 0 ? .infinity : (r.height / 2 + 6) / abs(dy)
        let s = min(sx, sy)
        return CGPoint(x: c.x + dx * s, y: c.y + dy * s)
    }

    static func path(_ o: BoardObject) -> Path {
        var p = Path()
        guard let a = o.from?.point, let b = o.to?.point else { return p }
        p.move(to: a)
        switch o.connectorStyle {
        case .straight: p.addLine(to: b)
        case .elbow:
            let horizontal = abs(b.x - a.x) > abs(b.y - a.y)
            if horizontal {
                p.addLine(to: CGPoint(x: (a.x + b.x) / 2, y: a.y)); p.addLine(to: CGPoint(x: (a.x + b.x) / 2, y: b.y))
            } else {
                p.addLine(to: CGPoint(x: a.x, y: (a.y + b.y) / 2)); p.addLine(to: CGPoint(x: b.x, y: (a.y + b.y) / 2))
            }
            p.addLine(to: b)
        case .curved:
            let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
            let n = CGPoint(x: -(b.y - a.y) * 0.25, y: (b.x - a.x) * 0.25)
            p.addQuadCurve(to: b, control: CGPoint(x: mid.x + n.x, y: mid.y + n.y))
        }
        return p
    }

    /// Direction into each end, for arrowheads.
    static func endDirections(_ o: BoardObject) -> (start: CGFloat, end: CGFloat) {
        guard let a = o.from?.point, let b = o.to?.point else { return (0, 0) }
        switch o.connectorStyle {
        case .straight: return (atan2(a.y - b.y, a.x - b.x), atan2(b.y - a.y, b.x - a.x))
        case .elbow:
            let horizontal = abs(b.x - a.x) > abs(b.y - a.y)
            if horizontal { return (a.x < b.x ? .pi : 0, b.x > a.x ? 0 : .pi) }
            return (a.y < b.y ? -.pi / 2 : .pi / 2, b.y > a.y ? .pi / 2 : -.pi / 2)
        case .curved:
            let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
            let c = CGPoint(x: mid.x - (b.y - a.y) * 0.25, y: mid.y + (b.x - a.x) * 0.25)
            return (atan2(a.y - c.y, a.x - c.x), atan2(b.y - c.y, b.x - c.x))
        }
    }

    static func arrowHead(at p: CGPoint, angle: CGFloat, size: CGFloat) -> Path {
        var path = Path()
        let l = CGPoint(x: p.x - cos(angle - 0.45) * size, y: p.y - sin(angle - 0.45) * size)
        let r = CGPoint(x: p.x - cos(angle + 0.45) * size, y: p.y - sin(angle + 0.45) * size)
        path.move(to: p); path.addLine(to: l); path.addLine(to: r); path.closeSubpath()
        return path
    }

    /// Draws a connector in a GraphicsContext already transformed to Space points.
    static func draw(_ o: BoardObject, in ctx: inout GraphicsContext, ink: Color, selected: Bool = false) {
        let color = o.stroke.map { Color(hex: $0) } ?? ink
        let w = CGFloat(o.lineWidth)
        let style: StrokeStyle
        switch o.dash {
        case .dashed: style = StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round, dash: [w * 4, w * 3])
        case .dotted: style = StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round, dash: [0.1, w * 2.5])
        default: style = StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round)
        }
        if selected { ctx.stroke(path(o), with: .color(.accentColor.opacity(0.35)), style: StrokeStyle(lineWidth: w + 8, lineCap: .round, lineJoin: .round)) }
        ctx.stroke(path(o), with: .color(color), style: style)
        let dirs = endDirections(o)
        let head = max(12, w * 4)
        if o.endArrow, let b = o.to?.point { ctx.fill(arrowHead(at: b, angle: dirs.end, size: head), with: .color(color)) }
        if o.startArrow, let a = o.from?.point { ctx.fill(arrowHead(at: a, angle: dirs.start, size: head), with: .color(color)) }
    }
}

// MARK: Object views

/// One object drawn at its own size, in Space points. The board scales it.
struct ObjectContent: View {
    let object: BoardObject
    let files: BoardFiles
    /// Ink-coloured things (text, outlines) follow the paper: light on dark paper.
    let darkPaper: Bool
    var hideText = false

    private var inkColor: Color { darkPaper ? .white : Color(red: 0.11, green: 0.11, blue: 0.12) }
    private var textColor: Color { object.textColor.map { Color(hex: $0) } ?? (object.kind == .sticky || (object.kind == .table && !object.autoTableColors) ? Color(red: 0.11, green: 0.11, blue: 0.12) : inkColor) }

    /// A table in the default colours follows the paper: white on light paper, dark grey on dark paper.
    private var tableFill: Color? {
        if object.autoTableColors { return darkPaper ? Color(red: 0.17, green: 0.17, blue: 0.18) : .white }
        return object.fill.map { Color(hex: $0) }
    }
    private var tableLines: Color {
        if object.autoTableColors && (object.stroke == nil || object.stroke?.uppercased() == "#AEAEB2") {
            return darkPaper ? Color(red: 0.39, green: 0.39, blue: 0.40) : Color(red: 0.68, green: 0.68, blue: 0.70)
        }
        return object.stroke.map { Color(hex: $0) } ?? .gray.opacity(0.5)
    }

    private var font: Font {
        var f = Font.system(size: object.fontSize, weight: object.bold ? .bold : .regular)
        if object.italic { f = f.italic() }
        return f
    }

    var body: some View {
        switch object.kind {
        case .sticky:
            ZStack {
                Rectangle().fill(Color(hex: object.fill ?? Palette.sticky[0]))
                    .shadow(color: .black.opacity(object.shadow ? 0.18 : 0), radius: 6, x: 0, y: 4)
                if object.text.isEmpty && !hideText {
                    Text("Tap to type").font(.system(size: object.fontSize * 0.8)).foregroundStyle(.black.opacity(0.28)).multilineTextAlignment(.center).padding(16)
                } else if !hideText {
                    label.padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: object.align.frame)
                }
            }
        case .text where object.text.isEmpty && !hideText:
            Text("Text").font(font).foregroundStyle(inkColor.opacity(0.3))
                .padding(.horizontal, 8).padding(.vertical, 6).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        case .text:
            label.padding(.horizontal, 8).padding(.vertical, 6).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: Alignment(horizontal: object.align.frame.horizontal, vertical: .top))
                .opacity(hideText ? 0 : 1)
        case .shape:
            let kind = object.shape ?? .roundedRect
            ZStack {
                if let fill = object.fill { BoardShape(kind: kind).fill(Color(hex: fill)) }
                if object.dash != .none {
                    BoardShape(kind: kind).stroke(object.stroke.map { Color(hex: $0) } ?? inkColor, style: dashStyle)
                }
                if !object.text.isEmpty && !hideText { label.padding(12) }
            }
            .shadow(color: .black.opacity(object.shadow ? 0.2 : 0), radius: 6, x: 0, y: 3)
        case .symbol:
            Image(systemName: object.symbol ?? "star")
                .resizable()
                .scaledToFit()
                .fontWeight(object.bold ? .bold : .regular)
                .foregroundStyle(object.fill.map { Color(hex: $0) } ?? inkColor)
        case .image:
            if let name = object.image, let ui = UIImage(contentsOfFile: files.mediaURL(name).path(percentEncoded: false)) {
                Image(uiImage: ui).resizable()
                    .clipShape(RoundedRectangle(cornerRadius: object.cornerRadius))
                    .shadow(color: .black.opacity(object.shadow ? 0.22 : 0), radius: 8, x: 0, y: 4)
            } else {
                RoundedRectangle(cornerRadius: 8).fill(.gray.opacity(0.2)).overlay(Image(systemName: "photo").font(.largeTitle).foregroundStyle(.secondary))
            }
        case .table:
            TableContent(object: object, textColor: textColor, font: font, fill: tableFill, lines: tableLines, hideText: hideText)
        case .connector:
            EmptyView()
        }
    }

    private var label: some View {
        Text(object.text)
            .font(font)
            .underline(object.underline)
            .foregroundStyle(textColor)
            .multilineTextAlignment(object.align.swiftUI)
            .minimumScaleFactor(object.kind == .text ? 1 : 0.3)
    }

    private var dashStyle: StrokeStyle {
        let w = CGFloat(object.lineWidth)
        switch object.dash {
        case .dashed: return StrokeStyle(lineWidth: w, dash: [w * 4, w * 3])
        case .dotted: return StrokeStyle(lineWidth: w, lineCap: .round, dash: [0.1, w * 2.5])
        default: return StrokeStyle(lineWidth: w)
        }
    }
}

struct TableContent: View {
    let object: BoardObject
    let textColor: Color
    let font: Font
    let fill: Color?
    let lines: Color
    let hideText: Bool

    var body: some View {
        let t = object.table ?? TableData(cells: [[""]])
        GeometryReader { g in
            let cw = g.size.width / CGFloat(max(t.cols, 1)), rh = g.size.height / CGFloat(max(t.rows, 1))
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 10).fill(fill ?? Color.white.opacity(0.001))
                // The first row reads as a header.
                UnevenRoundedRectangle(topLeadingRadius: 10, topTrailingRadius: 10)
                    .fill(lines.opacity(0.18))
                    .frame(height: rh)
                Path { p in
                    for c in 1 ..< max(t.cols, 1) { p.move(to: CGPoint(x: CGFloat(c) * cw, y: 0)); p.addLine(to: CGPoint(x: CGFloat(c) * cw, y: g.size.height)) }
                    for r in 1 ..< max(t.rows, 1) { p.move(to: CGPoint(x: 0, y: CGFloat(r) * rh)); p.addLine(to: CGPoint(x: g.size.width, y: CGFloat(r) * rh)) }
                }
                .stroke(lines, lineWidth: 1.5)
                RoundedRectangle(cornerRadius: 10).stroke(lines, lineWidth: 1.5)
                if !hideText {
                    ForEach(0 ..< t.rows, id: \.self) { r in
                        ForEach(0 ..< t.cols, id: \.self) { c in
                            Text(t.cells[r][c].isEmpty && r == 0 ? "Column \(c + 1)" : t.cells[r][c])
                                .font(r == 0 ? font.weight(.semibold) : font)
                                .foregroundStyle(t.cells[r][c].isEmpty ? textColor.opacity(0.3) : textColor)
                                .frame(width: cw - 16, height: rh - 8, alignment: object.align.frame)
                                .offset(x: CGFloat(c) * cw + 8, y: CGFloat(r) * rh + 4)
                        }
                    }
                }
            }
        }
    }
}

// MARK: Paper

enum PaperDrawing {
    /// Draws the paper's pattern for a viewport. `origin` is the Space point at the top-left; `zoom` is points per Space point.
    static func draw(_ paper: Paper, dark: Bool, in ctx: GraphicsContext, size: CGSize, origin: CGPoint, zoom: CGFloat) {
        guard paper.style != .blank else { return }
        var step = paper.spacing.points * zoom
        var every: CGFloat = paper.spacing.points
        // Far out, fewer lines, so the paper doesn't turn grey.
        // Never denser than 16pt on screen, so the pattern stays even and readable at every zoom.
        while step < 16 { step *= 2; every *= 2 }
        let color = dark ? Color.white.opacity(paper.style == .dots ? 0.24 : 0.16) : Color.black.opacity(paper.style == .dots ? 0.28 : 0.10)
        let startX = (ceil(origin.x / every) * every - origin.x) * zoom
        let startY = (ceil(origin.y / every) * every - origin.y) * zoom
        switch paper.style {
        case .dots:
            let d: CGFloat = max(2.2, min(2.8, 2.4 * zoom))
            var path = Path()
            var y = startY
            while y < size.height {
                var x = startX
                while x < size.width {
                    path.addEllipse(in: CGRect(x: x - d / 2, y: y - d / 2, width: d, height: d))
                    x += step
                }
                y += step
            }
            ctx.fill(path, with: .color(color))
        case .lines, .squares:
            var path = Path()
            var y = startY
            while y < size.height {
                path.move(to: CGPoint(x: 0, y: y)); path.addLine(to: CGPoint(x: size.width, y: y))
                y += step
            }
            if paper.style == .squares {
                var x = startX
                while x < size.width {
                    path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: size.height))
                    x += step
                }
            }
            ctx.stroke(path, with: .color(color), lineWidth: 1)
        case .blank:
            break
        }
    }
}

// MARK: Offscreen rendering (thumbnails, PDF)

/// A board region drawn as a still picture: paper, objects, connectors and ink.
struct BoardStill: View {
    let rect: CGRect
    let drawing: PKDrawing
    let objects: [BoardObject]
    let files: BoardFiles
    let paper: Paper
    let dark: Bool
    let scale: CGFloat
    var showPattern = true

    var body: some View {
        let darkPaper = paper.tint.isDark(system: dark)
        ZStack(alignment: .topLeading) {
            paper.tint.color(dark: dark)
            if showPattern {
                Canvas { ctx, size in PaperDrawing.draw(paper, dark: darkPaper, in: ctx, size: size, origin: rect.origin, zoom: scale) }
            }
            objectsLayer(above: false, darkPaper: darkPaper)
            if let ink = inkImage {
                Image(uiImage: ink).resizable().frame(width: rect.width * scale, height: rect.height * scale)
            }
            objectsLayer(above: true, darkPaper: darkPaper)
        }
        .frame(width: rect.width * scale, height: rect.height * scale, alignment: .topLeading)
        .clipped()
        .environment(\.colorScheme, darkPaper ? .dark : .light)
    }

    @ViewBuilder private func objectsLayer(above: Bool, darkPaper: Bool) -> some View {
        Canvas { ctx, _ in
            var c = ctx
            c.scaleBy(x: scale, y: scale)
            c.translateBy(x: -rect.minX, y: -rect.minY)
            for o in objects where o.isConnector && o.isAboveInk == above { ConnectorGeometry.draw(o, in: &c, ink: darkPaper ? .white : .black) }
        }
        ForEach(objects.filter { !$0.isConnector && $0.isAboveInk == above && $0.frame.intersects(rect) }) { o in
            ObjectContent(object: o, files: files, darkPaper: darkPaper)
                .frame(width: o.frame.width, height: o.frame.height)
                .scaleEffect(scale, anchor: .topLeading)
                .offset(x: (o.frame.minX - rect.minX) * scale, y: (o.frame.minY - rect.minY) * scale)
        }
    }

    private var inkImage: UIImage? {
        guard !drawing.strokes.isEmpty else { return nil }
        var image: UIImage?
        UITraitCollection(userInterfaceStyle: paper.tint.isDark(system: dark) ? .dark : .light).performAsCurrent {
            image = drawing.image(from: rect, scale: max(scale, 0.25) * 2)
        }
        return image
    }
}

enum BoardRenderer {
    @MainActor
    static func image(of rect: CGRect, drawing: PKDrawing, objects: [BoardObject], files: BoardFiles, paper: Paper, maxSide: CGFloat, dark: Bool) -> UIImage? {
        let scale = min(1, maxSide / max(rect.width, rect.height, 1))
        let renderer = ImageRenderer(content: BoardStill(rect: rect, drawing: drawing, objects: objects, files: files, paper: paper, dark: dark, scale: scale))
        renderer.scale = 2
        return renderer.uiImage
    }

    /// A PDF with one page per rectangle.
    @MainActor
    static func pdf(pages: [CGRect], drawing: PKDrawing, objects: [BoardObject], files: BoardFiles, paper: Paper, name: String) -> URL? {
        let url = FileManager.default.temporaryDirectory.appending(path: "\(name).pdf")
        guard let consumer = CGDataConsumer(url: url as CFURL) else { return nil }
        var box = CGRect(x: 0, y: 0, width: 612, height: 792)
        guard let pdf = CGContext(consumer: consumer, mediaBox: &box, nil) else { return nil }
        for rect in pages where !rect.isNull && rect.width > 0 {
            let scale = min(1.5, 1100 / max(rect.width, rect.height))
            let renderer = ImageRenderer(content: BoardStill(rect: rect, drawing: drawing, objects: objects, files: files, paper: paper, dark: false, scale: scale))
            renderer.render { size, draw in
                var page = CGRect(origin: .zero, size: size)
                pdf.beginPage(mediaBox: &page)
                draw(pdf)
                pdf.endPage()
            }
        }
        pdf.closePDF()
        return url
    }
}
