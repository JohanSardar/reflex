import SwiftUI

/// The one small toolbar every selection gets: two to four buttons for its type, then
/// Duplicate, Delete and a short "…" menu that starts with Bring to Front and Send to Back.
struct MiniToolbar: View {
    @Bindable var session: BoardSession
    @State private var popover: Pop?

    enum Pop: String, Identifiable {
        case fill, stroke, text, size, table, ends, style, arrange, inkColor
        var id: String { rawValue }
    }

    private var objects: [BoardObject] { session.selectedObjects }
    private var single: BoardObject? { objects.count == 1 && session.selectedStrokes.isEmpty ? objects.first : nil }
    private var locked: Bool { !objects.isEmpty && objects.allSatisfy(\.locked) }

    var body: some View {
        HStack(spacing: 2) {
            if locked {
                button("lock.open", "Unlock") { session.toggleLock() }
            } else {
                typeButtons
                if hasTypeButtons { Divider().frame(height: 24).padding(.horizontal, 4) }
                button("plus.square.on.square", "Duplicate") { session.duplicateSelection() }
                button("trash", "Delete", tint: .red) { session.deleteSelection() }
            }
            moreMenu
        }
        .padding(.horizontal, 8)
        .frame(height: 50)
        .background(Color(.systemBackground).opacity(0.82), in: Capsule())
        .glassEffect(.regular, in: Capsule())
        .accessibilityIdentifier("mini-toolbar")
    }

    private var hasTypeButtons: Bool { single != nil || objects.count > 1 || !session.selectedStrokes.isEmpty }

    @ViewBuilder private var typeButtons: some View {
        if let o = single {
            switch o.kind {
            case .sticky:
                swatchButton(o.fill ?? Palette.sticky[0], .fill)
                textFormatButton
            case .text:
                swatchButton(o.textColor ?? "#1C1C1E", .fill, label: "Color")
                textFormatButton
                button("textformat.size", "Size") { popover = .size }.popover(item: binding(.size)) { _ in sizePicker }
            case .shape:
                swatchButton(o.fill ?? "#00000000", .fill)
                button("pencil.and.outline", "Stroke") { popover = .stroke }.popover(item: binding(.stroke)) { _ in
                    strokePicker
                }
                textFormatButton
            case .symbol:
                swatchButton(o.fill ?? "#0A84FF", .fill, label: "Color")
                button(o.bold ? "bold" : "bold", "Weight", on: o.bold) {
                    session.changeSelection("Weight") { $0.bold.toggle() }
                }
            case .image:
                button("rectangle.roundedtop", "Round Corners", on: o.cornerRadius > 0) {
                    session.changeSelection("Corners") { $0.cornerRadius = $0.cornerRadius > 0 ? 0 : 18 }
                }
                button("shadow", "Shadow", on: o.shadow) { session.changeSelection("Shadow") { $0.shadow.toggle() } }
            case .table:
                button("tablecells.badge.ellipsis", "Rows and Columns") { popover = .table }.popover(
                    item: binding(.table)
                ) { _ in tablePicker(o) }
                swatchButton(o.fill ?? "#00000000", .fill)
                textFormatButton
            case .connector:
                button("arrow.left.and.right", "Line Ends") { popover = .ends }.popover(item: binding(.ends)) { _ in
                    endsPicker(o)
                }
                button(o.connectorStyle.symbol, "Line Style") { popover = .style }.popover(item: binding(.style)) { _ in
                    stylePicker
                }
                button("pencil.and.outline", "Stroke") { popover = .stroke }.popover(item: binding(.stroke)) { _ in
                    strokePicker
                }
            }
        } else if !session.selectedStrokes.isEmpty && objects.isEmpty {
            swatchButton("#1C1C1E", .inkColor, label: "Ink Color")
        } else if objects.count > 1 || !session.selectedStrokes.isEmpty {
            button("align.horizontal.left", "Arrange") { popover = .arrange }
                .popover(item: binding(.arrange)) { _ in arrangePicker }
                .accessibilityIdentifier("arrange-button")
            if objects.count > 1 {
                // Spelled out, as in Freeform: an icon alone doesn't say which one it does.
                Button {
                    session.selectionIsGroup ? session.ungroup() : session.group()
                } label: {
                    Label(
                        session.selectionIsGroup ? "Ungroup" : "Group",
                        systemImage: session.selectionIsGroup ? "rectangle.3.group.bubble" : "rectangle.3.group"
                    )
                    .labelStyle(.titleAndIcon)
                    .font(.system(size: 15, weight: .medium))
                    .padding(.horizontal, 10).frame(height: 44)
                }
                .foregroundStyle(session.selectionIsGroup ? Color.accentColor : .primary)
                .accessibilityIdentifier("group-button")
            }
        }
    }

    private var textFormatButton: some View {
        Button {
            popover = .text
        } label: {
            Text("Aa").font(.system(size: 18, weight: .medium)).frame(width: 44, height: 44)
        }
        .foregroundStyle(.primary)
        .accessibilityLabel("Text Format")
        .popover(item: binding(.text)) { _ in textPicker }
    }

    private var moreMenu: some View {
        Menu {
            ControlGroup {
                Button("Send to Back", systemImage: "square.3.layers.3d.bottom.filled") { session.sendToBack() }
                Button("Bring to Front", systemImage: "square.3.layers.3d.top.filled") { session.bringToFront() }
            }
            .controlGroupStyle(.menu)
            if session.selectionAboveInk {
                Button("Send Below Drawing", systemImage: "square.2.layers.3d.bottom.filled") {
                    session.setAboveInk(false)
                }
            } else {
                Button("Bring Above Drawing", systemImage: "square.2.layers.3d.top.filled") {
                    session.setAboveInk(true)
                }
            }
            Button("Cut", systemImage: "scissors") { session.cutSelection() }
            Button("Copy", systemImage: "doc.on.doc") { session.copySelection() }
            Button(locked ? "Unlock" : "Lock", systemImage: locked ? "lock.open" : "lock") { session.toggleLock() }
            if objects.count > 1 {
                Button(session.selectionIsGroup ? "Ungroup" : "Group", systemImage: "rectangle.3.group") {
                    session.selectionIsGroup ? session.ungroup() : session.group()
                }
            }
            if single?.kind == .shape {
                Menu("Change Shape", systemImage: "square.on.circle") {
                    ForEach(ShapeKind.basic.filter { !$0.isLine } + ShapeKind.more) { k in
                        Button(k.name) { session.changeSelection("Change Shape") { $0.shape = k } }
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 18, weight: .medium)).frame(width: 44, height: 44)
        }
        .foregroundStyle(.primary)
        .accessibilityLabel("More")
        .accessibilityIdentifier("object-more")
    }

    private func binding(_ p: Pop) -> Binding<Pop?> {
        Binding(get: { popover == p ? p : nil }, set: { popover = $0 })
    }

    private func button(
        _ symbol: String, _ label: String, tint: Color = .primary, on: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .frame(width: 44, height: 44)
                .foregroundStyle(on ? Color.accentColor : tint)
        }
        .accessibilityLabel(label)
    }

    private func swatchButton(_ hex: String, _ pop: Pop, label: String = "Fill") -> some View {
        Button {
            popover = pop
        } label: {
            Circle()
                .fill(hex.hasSuffix("00") && hex.count == 9 ? AnyShapeStyle(.clear) : AnyShapeStyle(Color(hex: hex)))
                .overlay(Circle().stroke(.secondary.opacity(0.5), lineWidth: 1))
                .overlay {
                    if hex.hasSuffix("00") && hex.count == 9 {
                        Image(systemName: "line.diagonal").foregroundStyle(.red)
                    }
                }
                .frame(width: 26, height: 26)
                .frame(width: 44, height: 44)
        }
        .accessibilityLabel(label)
        .popover(item: binding(pop)) { p in
            if p == .inkColor {
                ColorGrid(colors: Palette.strokes, selected: nil) { session.recolorSelectedStrokes($0) }.padding()
            } else {
                fillPicker
            }
        }
    }

    // MARK: Popovers

    @ViewBuilder private var fillPicker: some View {
        if let o = single {
            VStack(alignment: .leading, spacing: 12) {
                switch o.kind {
                case .sticky:
                    ColorGrid(colors: Palette.sticky, selected: o.fill, columns: 7) { c in
                        session.changeSelection("Fill") { $0.fill = c }
                    }
                case .text:
                    ColorGrid(colors: Palette.text, selected: o.textColor) { c in
                        session.changeSelection("Color") { $0.textColor = c }
                    }
                default:
                    ColorGrid(colors: Palette.fills, selected: o.fill) { c in
                        session.changeSelection("Fill") { $0.fill = c }
                    }
                    if o.kind != .symbol {
                        Button {
                            session.changeSelection("Fill") { $0.fill = nil }
                        } label: {
                            Label("No Fill", systemImage: "circle.slash")
                        }
                    }
                    ColorPicker(
                        "Custom",
                        selection: Binding(
                            get: { Color(hex: o.fill ?? "#78BEF3") },
                            set: { c in
                                let hex = UIColor(c).hexString
                                session.change(session.selection, "Fill", record: false) { $0.fill = hex }
                            }))
                }
            }
            .padding()
            .frame(width: 300)
        }
    }

    private var strokePicker: some View {
        let o = single
        return VStack(alignment: .leading, spacing: 14) {
            Picker(
                "Line",
                selection: Binding(
                    get: { o?.dash ?? .solid }, set: { d in session.changeSelection("Stroke") { $0.dash = d } })
            ) {
                ForEach(LineDash.allCases.filter { o?.isConnector == true ? $0 != .none : true }, id: \.self) {
                    Text($0.name).tag($0)
                }
            }
            .pickerStyle(.segmented)
            HStack {
                Text("Width")
                Spacer()
                Stepper(
                    "\(Int(o?.lineWidth ?? 2)) pt",
                    value: Binding(
                        get: { o?.lineWidth ?? 2 }, set: { w in session.changeSelection("Stroke") { $0.lineWidth = w } }
                    ), in: 1...20
                )
                .fixedSize()
            }
            ColorGrid(colors: Palette.strokes, selected: o?.stroke) { c in
                session.changeSelection("Stroke") {
                    $0.stroke = c
                    if $0.dash == .none { $0.dash = .solid }
                }
            }
        }
        .padding()
        .frame(width: 320)
    }

    private var textPicker: some View {
        let o = single
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                toggle("bold", o?.bold ?? false) { $0.bold.toggle() }
                toggle("italic", o?.italic ?? false) { $0.italic.toggle() }
                toggle("underline", o?.underline ?? false) { $0.underline.toggle() }
                Divider().frame(height: 28)
                ForEach(TextAlign.allCases, id: \.self) { a in
                    toggle(a.symbol, o?.align == a) { $0.align = a }
                }
            }
            HStack {
                Text("Size")
                Spacer()
                Stepper(
                    "\(Int(o?.fontSize ?? 20)) pt",
                    value: Binding(
                        get: { o?.fontSize ?? 20 }, set: { v in session.changeSelection("Size") { $0.fontSize = v } }),
                    in: 8...144, step: 2
                )
                .fixedSize()
            }
            ColorGrid(colors: Palette.text, selected: o?.textColor) { c in
                session.changeSelection("Text Color") { $0.textColor = c }
            }
        }
        .padding()
        .frame(width: 320)
    }

    private func toggle(_ symbol: String, _ on: Bool, _ f: @escaping (inout BoardObject) -> Void) -> some View {
        Button {
            session.changeSelection("Format", f)
        } label: {
            Image(systemName: symbol).frame(width: 36, height: 32)
                .foregroundStyle(on ? Color.white : .primary)
                .background(
                    on ? Color.accentColor : Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }

    private static let sizes: [Double] = [12, 14, 17, 20, 24, 28, 36, 48, 64, 96, 144]

    private var sizePicker: some View {
        List(Self.sizes, id: \.self) { s in
            Button {
                session.changeSelection("Size") { $0.fontSize = s }
                popover = nil
            } label: {
                HStack {
                    Text("\(Int(s)) pt")
                    Spacer()
                    if single?.fontSize == s { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                }
            }
            .foregroundStyle(.primary)
        }
        .listStyle(.plain)
        .frame(width: 200, height: 420)
    }

    private func tablePicker(_ o: BoardObject) -> some View {
        let t = o.table ?? TableData(cells: [[""]])
        return VStack(spacing: 14) {
            Stepper(
                "Rows: \(t.rows)",
                value: Binding(get: { t.rows }, set: { session.resizeTable(o.id, rows: $0, cols: t.cols) }), in: 1...30)
            Stepper(
                "Columns: \(t.cols)",
                value: Binding(get: { t.cols }, set: { session.resizeTable(o.id, rows: t.rows, cols: $0) }), in: 1...12)
        }
        .padding()
        .frame(width: 280)
    }

    private func endsPicker(_ o: BoardObject) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle(
                "Arrow at Start",
                isOn: Binding(
                    get: { o.startArrow }, set: { v in session.changeSelection("Line Ends") { $0.startArrow = v } }))
            Toggle(
                "Arrow at End",
                isOn: Binding(
                    get: { o.endArrow }, set: { v in session.changeSelection("Line Ends") { $0.endArrow = v } }))
        }
        .padding()
        .frame(width: 260)
    }

    private var stylePicker: some View {
        HStack(spacing: 10) {
            ForEach(ConnectorStyle.allCases, id: \.self) { s in
                Button {
                    session.changeSelection("Line Style") { $0.connectorStyle = s }
                } label: {
                    VStack(spacing: 6) {
                        Image(systemName: s.symbol).font(.title2).frame(width: 60, height: 44)
                        Text(s.rawValue.capitalized).font(.caption)
                    }
                    .padding(8)
                    .background(
                        single?.connectorStyle == s ? Color.accentColor.opacity(0.15) : .clear,
                        in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
            }
        }
        .padding()
    }

    private var arrangePicker: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Align").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                alignButton("align.horizontal.left", .left)
                alignButton("align.horizontal.center", .centerX)
                alignButton("align.horizontal.right", .right)
                alignButton("align.vertical.top", .top)
                alignButton("align.vertical.center", .centerY)
                alignButton("align.vertical.bottom", .bottom)
            }
            Text("Distribute").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button {
                    session.distribute(horizontally: true)
                } label: {
                    Label("Horizontally", systemImage: "distribute.horizontal.center")
                }
                Button {
                    session.distribute(horizontally: false)
                } label: {
                    Label("Vertically", systemImage: "distribute.vertical.center")
                }
            }
            .buttonStyle(.bordered)
            Divider()
            Button(session.selectionIsGroup ? "Ungroup" : "Group", systemImage: "rectangle.3.group") {
                session.selectionIsGroup ? session.ungroup() : session.group()
                popover = nil
            }
            .disabled(objects.count < 2)
        }
        .padding()
        .frame(width: 420)
    }

    private func alignButton(_ symbol: String, _ edge: BoardSession.AlignEdge) -> some View {
        Button {
            session.align(edge)
        } label: {
            Image(systemName: symbol).font(.title3).frame(width: 28, height: 30)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.roundedRectangle(radius: 10))
        .tint(.primary)
        .accessibilityLabel(alignName(edge))
    }

    private func alignName(_ edge: BoardSession.AlignEdge) -> String {
        switch edge {
        case .left: "Align Left Edges"
        case .centerX: "Align Centers"
        case .right: "Align Right Edges"
        case .top: "Align Top Edges"
        case .centerY: "Align Middles"
        case .bottom: "Align Bottom Edges"
        }
    }
}

struct ColorGrid: View {
    let colors: [String]
    let selected: String?
    var columns = 6
    let pick: (String) -> Void

    init(colors: [String], selected: String?, columns: Int = 6, pick: @escaping (String) -> Void) {
        self.colors = colors
        self.selected = selected
        self.columns = columns
        self.pick = pick
    }

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(36), spacing: 10), count: columns), spacing: 10) {
            ForEach(colors, id: \.self) { c in
                Button {
                    pick(c)
                } label: {
                    Circle().fill(Color(hex: c))
                        .overlay(Circle().stroke(.secondary.opacity(0.35), lineWidth: 1))
                        .overlay(
                            Circle().stroke(Color.accentColor, lineWidth: 3).padding(-4).opacity(
                                selected?.uppercased() == c.uppercased() ? 1 : 0)
                        )
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Color \(c)")
            }
        }
    }
}

extension UIColor {
    var hexString: String {
        var r: CGFloat = 0
        var g: CGFloat = 0
        var b: CGFloat = 0
        var a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        func byte(_ v: CGFloat) -> Int { Int((min(max(v, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(r), byte(g), byte(b))
    }
}

// MARK: Paper

struct PaperPicker: View {
    @Binding var paper: Paper
    @Environment(\.colorScheme) private var scheme
    @State private var newBoards = Paper.forNewBoards

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Paper").font(.headline)
            HStack(spacing: 10) {
                ForEach(Paper.Style.allCases) { s in
                    Button {
                        paper.style = s
                    } label: {
                        VStack(spacing: 6) {
                            Canvas { ctx, size in
                                var p = paper
                                p.style = s
                                p.spacing = .small
                                PaperDrawing.draw(
                                    p, dark: paper.tint.isDark(system: scheme == .dark), in: ctx, size: size,
                                    origin: .zero, zoom: 1)
                            }
                            .frame(width: 64, height: 64)
                            .background(paper.tint.color(dark: scheme == .dark), in: RoundedRectangle(cornerRadius: 10))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10).stroke(
                                    paper.style == s ? Color.accentColor : .secondary.opacity(0.3),
                                    lineWidth: paper.style == s ? 3 : 1))
                            Text(s.name).font(.caption)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(s.name) paper")
                    .accessibilityAddTraits(paper.style == s ? .isSelected : [])
                }
            }
            Picker("Spacing", selection: $paper.spacing) {
                ForEach(Paper.Spacing.allCases) { Text($0.name).tag($0) }
            }
            .pickerStyle(.segmented)
            .disabled(paper.style == .blank)
            Text("Color").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                ForEach(Paper.Tint.allCases) { t in
                    Button {
                        paper.tint = t
                    } label: {
                        ZStack {
                            if t == .automatic {
                                Circle().fill(
                                    LinearGradient(
                                        colors: [.white, Color(white: 0.12)], startPoint: .topLeading,
                                        endPoint: .bottomTrailing))
                            } else {
                                Circle().fill(t.color(dark: false))
                            }
                            Circle().stroke(.secondary.opacity(0.4), lineWidth: 1)
                            Circle().stroke(Color.accentColor, lineWidth: 3).padding(-4).opacity(
                                paper.tint == t ? 1 : 0)
                        }
                        .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(t.name)
                    .accessibilityAddTraits(paper.tint == t ? .isSelected : [])
                }
            }
            Text(paper.tint.name).font(.footnote).foregroundStyle(.secondary)
            Divider()
            Button {
                Paper.forNewBoards = paper
                newBoards = paper
            } label: {
                Label(
                    newBoards == paper ? "Default for New Boards" : "Make Default for New Boards",
                    systemImage: newBoards == paper ? "checkmark" : "doc.badge.plus"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(newBoards == paper ? .green : .accentColor)
            .allowsHitTesting(newBoards != paper)
            .accessibilityAddTraits(newBoards == paper ? .isSelected : [])
            .accessibilityIdentifier("paper-default")
        }
        .padding(20)
        .frame(width: 360)
        .accessibilityIdentifier("paper-picker")
    }
}

// MARK: Shapes and symbols

struct ShapeGrid: View {
    let pick: (ShapeKind) -> Void
    let more: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(84), spacing: 12), count: 3), spacing: 12) {
                ForEach(ShapeKind.basic) { k in
                    Button {
                        pick(k)
                    } label: {
                        ShapeIcon(kind: k).frame(width: 84, height: 84)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(k.name)
                    .accessibilityIdentifier("shape-\(k.rawValue)")
                }
            }
            Button(action: more) {
                Label("More Shapes and Symbols", systemImage: "square.grid.3x3.square").frame(maxWidth: .infinity)
                    .frame(height: 40)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("shape-library-button")
        }
        .padding(16)
        .frame(width: 310)
    }
}

struct ShapeIcon: View {
    let kind: ShapeKind
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16).fill(Color.secondary.opacity(0.1))
            switch kind {
            case .line: LineIcon(arrow: false, curve: false)
            case .arrow: LineIcon(arrow: true, curve: false)
            case .curve: LineIcon(arrow: false, curve: true)
            default:
                BoardShape(kind: kind).fill(Color(hex: Palette.fills[0]))
                    .frame(
                        width: kind == .terminator ? 48 : 46,
                        height: kind == .terminator ? 22 : kind == .parallelogram || kind == .blockArrow ? 32 : 46)
            }
        }
    }
}

private struct LineIcon: View {
    let arrow: Bool
    let curve: Bool
    var body: some View {
        Canvas { ctx, size in
            var p = Path()
            let a = CGPoint(x: size.width * 0.28, y: size.height * 0.72)
            let b = CGPoint(x: size.width * 0.72, y: size.height * 0.28)
            p.move(to: a)
            if curve { p.addQuadCurve(to: b, control: CGPoint(x: a.x, y: b.y)) } else { p.addLine(to: b) }
            ctx.stroke(p, with: .color(.primary), lineWidth: 2.2)
            if arrow { ctx.fill(ConnectorGeometry.arrowHead(at: b, angle: -.pi / 4, size: 10), with: .color(.primary)) }
        }
    }
}

enum LibraryChoice {
    case shape(ShapeKind)
    case symbol(String)
}

/// The full library: every shape, and SF Symbols by category, with search.
struct ShapeLibrary: View {
    let pick: (LibraryChoice) -> Void
    @State private var query = ""
    @State private var category = "Shapes"
    @Environment(\.dismiss) private var dismiss

    private var categories: [String] { ["Shapes"] + SymbolCatalog.categories.map(\.name) }

    private var symbols: [String] {
        if !query.isEmpty {
            // Every typed word must start a word of the symbol's name ("car" finds car.fill, not scarf).
            let words = query.lowercased().split(separator: " ").map(String.init)
            return SymbolCatalog.all.filter { name in
                let parts = name.split(separator: ".")
                return words.allSatisfy { w in parts.contains { $0.hasPrefix(w) } }
            }
        }
        return SymbolCatalog.categories.first { $0.name == category }?.symbols ?? []
    }

    private var shapes: [ShapeKind] {
        let all = ShapeKind.basic + ShapeKind.more
        return query.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if query.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(categories, id: \.self) { c in
                                Button(c) { category = c }
                                    .buttonStyle(.bordered)
                                    .tint(category == c ? .accentColor : .secondary)
                            }
                        }
                        .padding(.horizontal)
                        .padding(.vertical, 10)
                    }
                }
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: 12)], spacing: 12) {
                        if category == "Shapes" || !query.isEmpty {
                            ForEach(shapes) { k in
                                Button {
                                    pick(.shape(k))
                                    dismiss()
                                } label: {
                                    ShapeIcon(kind: k).frame(width: 84, height: 84)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(k.name)
                            }
                        }
                        if category != "Shapes" || !query.isEmpty {
                            ForEach(symbols, id: \.self) { s in
                                Button {
                                    pick(.symbol(s))
                                    dismiss()
                                } label: {
                                    Image(systemName: s).font(.system(size: 32)).frame(width: 84, height: 84)
                                        .background(
                                            Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(s)
                            }
                        }
                    }
                    .padding()
                }
                .overlay {
                    if !query.isEmpty && shapes.isEmpty && symbols.isEmpty {
                        ContentUnavailableView.search(text: query)
                    }
                }
            }
            .navigationTitle("Shapes and Symbols")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search shapes and symbols"
            )
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.large])
    }
}

// MARK: Scenes

/// A small picture of the part of the board a Scene shows.
struct SceneThumbnail: View {
    let session: BoardSession
    let rect: CGRect
    @Environment(\.colorScheme) private var scheme
    @State private var image: UIImage?

    var body: some View {
        let aspect = rect.height > 0 ? rect.width / rect.height : 4 / 3
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFill() } else { Color(.tertiarySystemFill) }
        }
        .frame(width: 72, height: 72 / max(0.6, min(aspect, 2.2)))
        .frame(width: 72, height: 54)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator, lineWidth: 0.5))
        .task(id: rect) {
            image = BoardRenderer.image(
                of: rect, drawing: session.ink.drawing, objects: session.objects, files: session.files,
                paper: session.meta.paper, maxSide: 200, dark: scheme == .dark)
        }
    }
}

struct ScenesList: View {
    let session: BoardSession
    let export: () -> Void
    @State private var renaming: BoardScene?
    @State private var name = ""

    var body: some View {
        NavigationStack {
            List {
                if session.meta.scenes.isEmpty {
                    Text("Add scenes to jump between parts of the board, or to present them one by one.")
                        .foregroundStyle(.secondary)
                }
                ForEach(session.meta.scenes) { scene in
                    Button {
                        session.show(scene)
                    } label: {
                        HStack(spacing: 12) {
                            SceneThumbnail(session: session, rect: scene.rect)
                            Text(scene.name)
                        }
                    }
                    .foregroundStyle(.primary)
                    .contextMenu {
                        Button("Rename", systemImage: "pencil") {
                            name = scene.name
                            renaming = scene
                        }
                        Button("Replace with Current View", systemImage: "arrow.triangle.2.circlepath") {
                            let r = session.ink.visibleRect
                            session.updateMeta { m in
                                if let i = m.scenes.firstIndex(where: { $0.id == scene.id }) { m.scenes[i].rect = r }
                            }
                        }
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            session.updateMeta { $0.scenes.removeAll { $0.id == scene.id } }
                        }
                    }
                }
                .onDelete { idx in session.updateMeta { $0.scenes.remove(atOffsets: idx) } }
                .onMove { from, to in session.updateMeta { $0.scenes.move(fromOffsets: from, toOffset: to) } }
            }
            .navigationTitle("Scenes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { EditButton().disabled(session.meta.scenes.isEmpty) }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Menu {
                        Button("Export Scenes as PDF", systemImage: "arrow.up.doc", action: export).disabled(
                            session.meta.scenes.isEmpty)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    Button("Add Scene", systemImage: "plus") { session.addScene() }
                        .accessibilityIdentifier("add-scene")
                }
            }
            .alert("Rename Scene", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $name)
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    let id = renaming?.id
                    session.updateMeta { m in
                        if let i = m.scenes.firstIndex(where: { $0.id == id }) { m.scenes[i].name = name }
                    }
                }
            }
        }
        .frame(width: 340, height: 420)
    }
}
