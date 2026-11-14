import ReflexInput
import SwiftUI

/// Touches on objects, selection handles, the lasso, guides, typing and the mini-toolbar.
/// Drawn over the ink; empty space lets touches through to the canvas.
struct InteractionLayer: View {
    @Bindable var session: BoardSession
    let darkPaper: Bool
    let guides: BoardSession.GuideSettings
    let screen: CGSize

    @State private var dragging = false
    @State private var lasso: [CGPoint] = []
    @State private var resizeStart: CGRect?
    @State private var connectorID: String?
    @State private var canvasMenu: CGPoint?

    private var ink: InkCanvasController { session.ink }
    private var z: CGFloat { ink.zoomScale }
    private var o: CGPoint { ink.contentOffset }

    private func toScreen(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * z - o.x, y: p.y * z - o.y) }
    private func toScreen(_ r: CGRect) -> CGRect { CGRect(x: r.minX * z - o.x, y: r.minY * z - o.y, width: r.width * z, height: r.height * z) }
    private func toSpace(_ p: CGPoint) -> CGPoint { CGPoint(x: (p.x + o.x) / z, y: (p.y + o.y) / z) }

    /// Objects take finger touches when the palette is closed, or in Select mode.
    private var objectsLive: Bool { !ink.pickerVisible || session.selecting || (ink.pickerVisible && !ink.fingerDraws) }
    private var lassoLive: Bool { session.selecting || (ink.pickerVisible && ink.lassoPicked) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            if lassoLive { lassoCapture }
            if ink.pickerVisible, let tool = ink.customTool { placementCapture(tool) }
            if objectsLive || lassoLive {
                ForEach(session.objects) { obj in proxy(obj) }
                if session.selection.count > 1 || !session.selectedStrokes.isEmpty, let b = session.selectionBounds { selectionProxy(b) }
            }
            guideLines
            selectionChrome
            editor
            if !dragging, resizeStart == nil, connectorID == nil, session.editing == nil, let b = session.selectionBounds {
                MiniToolbar(session: session)
                    .fixedSize()
                    .position(toolbarPosition(for: toScreen(b)))
                    .transition(.opacity.combined(with: .scale(scale: 0.95)))
            }
            if session.selecting { selectBanner }
            if let p = canvasMenu { canvasMenuView(at: p) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .animation(.easeOut(duration: 0.15), value: session.selection)
        .onChange(of: ink.pickerVisible) { _, _ in canvasMenu = nil }
        .onChange(of: session.objects.count) { _, _ in canvasMenu = nil }
        .onChange(of: session.selection) { _, _ in canvasMenu = nil }
        .onAppear {
            ink.onTap = { p in tapCanvas(p) }
            ink.onLongPress = { p in
                session.clearSelection()
                canvasMenu = toScreen(p)
            }
        }
    }

    private func tapCanvas(_ p: CGPoint) {
        if canvasMenu != nil { canvasMenu = nil; return }
        if session.editing != nil { session.endEditing(); return }
        if !session.selection.isEmpty || !session.selectedStrokes.isEmpty { session.clearSelection(); return }
        if session.selecting { return }
        canvasMenu = toScreen(p)
    }

    // MARK: Hit targets

    @ViewBuilder private func proxy(_ obj: BoardObject) -> some View {
        if obj.isConnector {
            let path = ConnectorGeometry.path(obj).applying(CGAffineTransform(scaleX: z, y: z).concatenating(CGAffineTransform(translationX: -o.x, y: -o.y)))
            Color.clear
                .contentShape(path.strokedPath(StrokeStyle(lineWidth: 26, lineCap: .round)))
                .onTapGesture { tap(obj, at: nil) }
                .gesture(moveGesture(obj))
                .accessibilityElement()
                .accessibilityLabel("Connector")
                .accessibilityIdentifier("object-\(obj.id)")
        } else {
            let r = toScreen(obj.frame)
            Color.clear
                .contentShape(Rectangle())
                .frame(width: max(r.width, 24), height: max(r.height, 24))
                .onTapGesture(count: 1, coordinateSpace: .local) { loc in tap(obj, at: loc) }
                .gesture(moveGesture(obj))
                .position(x: r.midX, y: r.midY)
                .accessibilityElement()
                .accessibilityLabel(label(obj))
                .accessibilityIdentifier("object-\(obj.kind.rawValue)")
                .accessibilityAddTraits(session.selection.contains(obj.id) ? [.isSelected, .isButton] : .isButton)
        }
    }

    private func label(_ obj: BoardObject) -> String {
        switch obj.kind {
        case .sticky: "Sticky note\(obj.text.isEmpty ? "" : ": \(obj.text)")"
        case .text: "Text: \(obj.text)"
        case .shape: obj.shape?.name ?? "Shape"
        case .symbol: "Symbol \(obj.symbol ?? "")"
        case .image: "Image"
        case .table: "Table"
        case .connector: "Connector"
        }
    }

    private func tap(_ obj: BoardObject, at loc: CGPoint?) {
        canvasMenu = nil
        if session.selecting {
            session.select(obj.id, adding: true)
            return
        }
        let already = session.selection == [obj.id] || (session.selection.contains(obj.id) && obj.group == nil && session.selection.count == 1)
        if already, obj.hasText, !obj.locked {
            if obj.kind == .table, let loc, let t = obj.table {
                let r = toScreen(obj.frame)
                let col = min(t.cols - 1, max(0, Int(loc.x / (r.width / CGFloat(t.cols)))))
                let row = min(t.rows - 1, max(0, Int(loc.y / (r.height / CGFloat(t.rows)))))
                session.editingCell = (row, col)
            }
            session.editing = obj.id
        } else if session.selection.contains(obj.id), obj.group != nil, session.selection.count > 1 {
            // A second tap on a group picks the one thing inside it.
            session.selection = [obj.id]
        } else {
            session.select(obj.id)
        }
    }

    private func moveGesture(_ obj: BoardObject) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { v in
                if !dragging {
                    if !session.selection.contains(obj.id) { session.select(obj.id, adding: session.selecting) }
                    guard !obj.locked else { return }
                    canvasMenu = nil
                    dragging = true
                    session.beginMove()
                }
                session.move(by: CGSize(width: v.translation.width / z, height: v.translation.height / z), guidesOn: guides)
            }
            .onEnded { _ in
                guard dragging else { return }
                dragging = false
                session.endMove()
            }
    }

    private func selectionProxy(_ b: CGRect) -> some View {
        let r = toScreen(b)
        return Color.clear
            .contentShape(Rectangle())
            .frame(width: r.width, height: r.height)
            .gesture(
                DragGesture(minimumDistance: 4)
                    .onChanged { v in
                        if !dragging { dragging = true; session.beginMove() }
                        session.move(by: CGSize(width: v.translation.width / z, height: v.translation.height / z), guidesOn: guides)
                    }
                    .onEnded { _ in
                        dragging = false
                        session.endMove()
                    }
            )
            .position(x: r.midX, y: r.midY)
    }

    // MARK: Lasso and placement

    private var lassoCapture: some View {
        Color.clear
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in lasso.append(v.location) }
                    .onEnded { _ in
                        defer { lasso = [] }
                        guard lasso.count > 3 else { return }
                        let pts = lasso.map(toSpace)
                        let path = CGMutablePath()
                        // A drag that encloses almost nothing selects the rectangle it spans, like a marquee.
                        let box = CGRect(x: pts.map(\.x).min()!, y: pts.map(\.y).min()!, width: 0, height: 0)
                            .union(CGRect(x: pts.map(\.x).max()!, y: pts.map(\.y).max()!, width: 0, height: 0))
                        var area: CGFloat = 0
                        for i in pts.indices { let a = pts[i], b = pts[(i + 1) % pts.count]; area += a.x * b.y - b.x * a.y }
                        if abs(area) / 2 < box.width * box.height * 0.15 { path.addRect(box) } else {
                            path.addLines(between: pts)
                            path.closeSubpath()
                        }
                        session.select(lasso: path, adding: session.selecting)
                    }
            )
            .overlay {
                if lasso.count > 1 {
                    Path { p in p.addLines(lasso) }
                        .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [6, 5]))
                        .allowsHitTesting(false)
                }
            }
            .accessibilityIdentifier("lasso-area")
    }

    private func placementCapture(_ tool: String) -> some View {
        Color.clear
            .contentShape(Rectangle())
            .onTapGesture(coordinateSpace: .local) { loc in
                let p = toSpace(loc)
                switch tool {
                case "reflex.sticky": session.addSticky(at: p)
                case "reflex.text": session.addText(at: p)
                default: session.addShape(session.shapeTool, at: p)
                }
            }
            .accessibilityIdentifier("placement-area")
    }

    private var selectBanner: some View {
        HStack(spacing: 14) {
            Image(systemName: "lasso").foregroundStyle(.secondary)
            Text("Drag around things to select them, or tap them one by one.").font(.callout)
            Button("Select All") { session.selectAll() }
            Button("Done") { session.selecting = false }.fontWeight(.semibold)
        }
        .padding(.horizontal, 18).padding(.vertical, 10)
        .glassEffect(.regular, in: Capsule())
        .position(x: screen.width / 2, y: 92)
        .accessibilityIdentifier("select-banner")
    }

    // MARK: Canvas menu (tap on empty board)

    private func canvasMenuView(at p: CGPoint) -> some View {
        let space = toSpace(p)
        return HStack(spacing: 0) {
            menuButton("Paste", "doc.on.clipboard", enabled: session.canPaste) { session.paste(at: space) }
            Divider().frame(height: 22)
            menuButton("Select", "checkmark.circle") { session.selecting = true }
            Divider().frame(height: 22)
            menuButton("Sticky", "note.text") { session.addSticky(at: space) }
            Divider().frame(height: 22)
            menuButton("Text", "character.textbox") { session.addText(at: space) }
        }
        .padding(.horizontal, 6)
        .glassEffect(.regular, in: Capsule())
        .fixedSize()
        .position(x: min(max(p.x, 220), screen.width - 220), y: max(p.y - 40, 110))
        .accessibilityIdentifier("canvas-menu")
    }

    private func menuButton(_ title: String, _ symbol: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button {
            canvasMenu = nil
            action()
        } label: {
            Label(title, systemImage: symbol).font(.system(size: 15, weight: .medium)).padding(.horizontal, 12).frame(height: 42)
        }
        .disabled(!enabled)
        .foregroundStyle(enabled ? Color.primary : Color.secondary)
    }

    // MARK: Guides

    private var guideLines: some View {
        Canvas { ctx, size in
            var path = Path()
            for x in session.guides.x { let sx = x * z - o.x; path.move(to: CGPoint(x: sx, y: 0)); path.addLine(to: CGPoint(x: sx, y: size.height)) }
            for y in session.guides.y { let sy = y * z - o.y; path.move(to: CGPoint(x: 0, y: sy)); path.addLine(to: CGPoint(x: size.width, y: sy)) }
            ctx.stroke(path, with: .color(Color(red: 1, green: 0.78, blue: 0)), style: StrokeStyle(lineWidth: 1.2, dash: [5, 4]))
        }
        .allowsHitTesting(false)
    }

    // MARK: Selection chrome

    @ViewBuilder private var selectionChrome: some View {
        let selected = session.selectedObjects
        if selected.count == 1, let obj = selected.first, session.selectedStrokes.isEmpty {
            if obj.isConnector { connectorHandles(obj) } else { objectHandles(obj) }
        } else if let b = session.selectionBounds, selected.count + session.selectedStrokes.count > 0 {
            let r = toScreen(b).insetBy(dx: -6, dy: -6)
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
                .frame(width: r.width, height: r.height)
                .position(x: r.midX, y: r.midY)
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder private func objectHandles(_ obj: BoardObject) -> some View {
        let r = toScreen(obj.frame)
        let color = obj.locked ? Color.gray : Color.accentColor
        Rectangle()
            .stroke(color, lineWidth: 1.5)
            .frame(width: r.width, height: r.height)
            .position(x: r.midX, y: r.midY)
            .allowsHitTesting(false)
        if obj.locked {
            ForEach(corners(r), id: \.self) { p in
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.gray).position(p).allowsHitTesting(false)
            }
        } else {
            let handles: [(UnitPoint, CGPoint)] = obj.kind == .text
                ? [(.leading, CGPoint(x: r.minX, y: r.midY)), (.trailing, CGPoint(x: r.maxX, y: r.midY))]
                : [(.topLeading, CGPoint(x: r.minX, y: r.minY)), (.top, CGPoint(x: r.midX, y: r.minY)), (.topTrailing, CGPoint(x: r.maxX, y: r.minY)),
                   (.leading, CGPoint(x: r.minX, y: r.midY)), (.trailing, CGPoint(x: r.maxX, y: r.midY)),
                   (.bottomLeading, CGPoint(x: r.minX, y: r.maxY)), (.bottom, CGPoint(x: r.midX, y: r.maxY)), (.bottomTrailing, CGPoint(x: r.maxX, y: r.maxY))]
            ForEach(handles, id: \.0) { anchor, p in
                Circle().fill(.white).stroke(Color.accentColor, lineWidth: 2)
                    .frame(width: 14, height: 14)
                    .frame(width: 36, height: 36)
                    .contentShape(Circle())
                    .gesture(resizeGesture(obj, anchor: anchor))
                    .position(p)
                    .accessibilityIdentifier("handle-\(anchorName(anchor))")
            }
            if !dragging, resizeStart == nil {
                ForEach([CGPoint(x: r.midX, y: r.minY - 30), CGPoint(x: r.maxX + 30, y: r.midY), CGPoint(x: r.midX, y: r.maxY + 30), CGPoint(x: r.minX - 30, y: r.midY)], id: \.self) { p in
                    Image(systemName: "arrow.up.right.circle.fill")
                        .font(.system(size: 20))
                        .rotationEffect(.degrees(connectorAngle(p, r)))
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, Color.accentColor)
                        .frame(width: 40, height: 40)
                        .contentShape(Circle())
                        .gesture(connectorGesture(obj))
                        .position(p)
                        .opacity(connectorID == nil ? 1 : 0)
                        .accessibilityLabel("Drag to connect")
                        .accessibilityIdentifier("connector-handle")
                }
            }
        }
    }

    private func connectorAngle(_ p: CGPoint, _ r: CGRect) -> Double {
        if p.y < r.minY { return -45 }
        if p.x > r.maxX { return 45 }
        if p.y > r.maxY { return 135 }
        return -135
    }

    private func anchorName(_ a: UnitPoint) -> String { "\(Int(a.x * 2))\(Int(a.y * 2))" }

    private func corners(_ r: CGRect) -> [CGPoint] {
        [CGPoint(x: r.minX, y: r.minY), CGPoint(x: r.maxX, y: r.minY), CGPoint(x: r.minX, y: r.maxY), CGPoint(x: r.maxX, y: r.maxY)]
    }

    private func resizeGesture(_ obj: BoardObject, anchor: UnitPoint) -> some Gesture {
        DragGesture(minimumDistance: 1, coordinateSpace: .global)
            .onChanged { v in
                if resizeStart == nil { resizeStart = obj.frame; session.beginResize() }
                guard let s = resizeStart else { return }
                let dx = v.translation.width / z, dy = v.translation.height / z
                var minX = s.minX, minY = s.minY, maxX = s.maxX, maxY = s.maxY
                if anchor.x == 0 { minX += dx } else if anchor.x == 1 { maxX += dx }
                if anchor.y == 0 { minY += dy } else if anchor.y == 1 { maxY += dy }
                var f = CGRect(x: min(minX, maxX), y: min(minY, maxY), width: abs(maxX - minX), height: abs(maxY - minY))
                // Pictures and symbols keep their proportions from a corner.
                if (obj.kind == .image || obj.kind == .symbol || obj.shape == .circle && false), anchor.x != 0.5, anchor.y != 0.5 {
                    let k = max(f.width / s.width, f.height / s.height)
                    let w = s.width * k, h = s.height * k
                    f = CGRect(x: anchor.x == 0 ? s.maxX - w : s.minX, y: anchor.y == 0 ? s.maxY - h : s.minY, width: w, height: h)
                }
                if guides.snapToGrid {
                    let g = guides.grid
                    f = CGRect(x: (f.minX / g).rounded() * g, y: (f.minY / g).rounded() * g, width: max(g, (f.width / g).rounded() * g), height: max(g, (f.height / g).rounded() * g))
                }
                session.resize(obj.id, to: f)
            }
            .onEnded { _ in
                resizeStart = nil
                session.endResize()
            }
    }

    private func connectorGesture(_ obj: BoardObject) -> some Gesture {
        DragGesture(minimumDistance: 2, coordinateSpace: .global)
            .onChanged { v in
                let p = toSpace(v.location)
                if connectorID == nil { connectorID = session.beginConnector(from: obj.id, at: CGPoint(x: obj.frame.midX, y: obj.frame.midY)) }
                if let id = connectorID { session.moveEnd(id, start: false, to: p, attach: true) }
            }
            .onEnded { _ in
                if let id = connectorID { session.endConnector(id) }
                connectorID = nil
            }
    }

    @ViewBuilder private func connectorHandles(_ obj: BoardObject) -> some View {
        if let a = obj.from?.point, let b = obj.to?.point, !obj.locked {
            ForEach([true, false], id: \.self) { start in
                let p = toScreen(start ? a : b)
                Circle().fill(.white).stroke(Color.accentColor, lineWidth: 2.5)
                    .frame(width: 16, height: 16)
                    .frame(width: 40, height: 40)
                    .contentShape(Circle())
                    .gesture(
                        DragGesture(minimumDistance: 1, coordinateSpace: .global)
                            .onChanged { v in
                                if resizeStart == nil { resizeStart = obj.frame; session.beginResize() }
                                session.moveEnd(obj.id, start: start, to: toSpace(v.location), attach: obj.shape == nil)
                            }
                            .onEnded { _ in
                                resizeStart = nil
                                session.endResize()
                            }
                    )
                    .position(p)
                    .accessibilityIdentifier(start ? "connector-start" : "connector-end")
            }
        }
    }

    // MARK: Typing

    @ViewBuilder private var editor: some View {
        if let id = session.editing, let obj = session.object(id) {
            if obj.kind == .table, let cell = session.editingCell, let t = obj.table, cell.row < t.rows, cell.col < t.cols {
                let r = toScreen(obj.frame)
                let cw = r.width / CGFloat(t.cols), rh = r.height / CGFloat(t.rows)
                let cellRect = CGRect(x: r.minX + CGFloat(cell.col) * cw, y: r.minY + CGFloat(cell.row) * rh, width: cw, height: rh)
                ObjectTextEditor(text: Binding(get: { session.object(id)?.table?.cells[cell.row][cell.col] ?? "" },
                                               set: { session.setCell(id, row: cell.row, col: cell.col, $0) }),
                                 object: obj, zoom: z, darkPaper: darkPaper, onTab: { nextCell(obj, cell) }, onDone: { session.endEditing() })
                    .frame(width: cellRect.width, height: cellRect.height)
                    .background(Color.accentColor.opacity(0.08))
                    .position(x: cellRect.midX, y: cellRect.midY)
                    .id("\(id)-\(cell.row)-\(cell.col)")
            } else if obj.kind != .table {
                let r = toScreen(obj.frame)
                ObjectTextEditor(text: Binding(get: { session.object(id)?.text ?? "" }, set: { session.setText(id, $0) }),
                                 object: obj, zoom: z, darkPaper: darkPaper, onTab: nil, onDone: { session.endEditing() })
                    .frame(width: r.width, height: r.height)
                    .position(x: r.midX, y: r.midY)
                    .id(id)
            }
        }
    }

    private func nextCell(_ obj: BoardObject, _ cell: (row: Int, col: Int)) {
        guard let t = obj.table else { return }
        var c = cell.col + 1, r = cell.row
        if c >= t.cols { c = 0; r += 1 }
        if r >= t.rows { session.resizeTable(obj.id, rows: t.rows + 1, cols: t.cols) }
        session.editingCell = (r, c)
    }

    // MARK: Toolbar placement

    private func toolbarPosition(for r: CGRect) -> CGPoint {
        let half: CGFloat = 200
        let x = min(max(r.midX, half + 12), max(screen.width - half - 12, half + 12))
        let above = r.minY - 74
        let y = above > 120 ? above : min(r.maxY + 74, screen.height - 120)
        return CGPoint(x: x, y: y)
    }
}

/// Typing into a sticky note, text box, shape or table cell, at the board's zoom.
struct ObjectTextEditor: View {
    @Binding var text: String
    let object: BoardObject
    let zoom: CGFloat
    let darkPaper: Bool
    let onTab: (() -> Void)?
    let onDone: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        let color = object.textColor.map { Color(hex: $0) } ?? (object.kind == .sticky ? Color(red: 0.11, green: 0.11, blue: 0.12) : (darkPaper ? .white : Color(red: 0.11, green: 0.11, blue: 0.12)))
        var font = Font.system(size: object.fontSize * zoom, weight: object.bold ? .bold : .regular)
        if object.italic { font = font.italic() }
        return TextField("", text: $text, axis: .vertical)
            .font(font)
            .underline(object.underline)
            .foregroundStyle(color)
            .multilineTextAlignment(object.align.swiftUI)
            .textFieldStyle(.plain)
            .focused($focused)
            .padding(.horizontal, (object.kind == .text ? 8 : 16) * zoom)
            .padding(.vertical, (object.kind == .text ? 6 : 12) * zoom)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: object.kind == .text ? .topLeading : Alignment(horizontal: object.align.frame.horizontal, vertical: .center))
            .onAppear { focused = true }
            .onKeyPress(.tab) {
                onTab?()
                return onTab == nil ? .ignored : .handled
            }
            .onKeyPress(.escape) {
                onDone()
                return .handled
            }
            .accessibilityIdentifier("object-editor")
    }
}
