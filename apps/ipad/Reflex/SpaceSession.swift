import PencilKit
import ReflexInput
import ReflexLink
import SwiftUI

/// One open board: its ink, objects, selection, history and Send. Ink never enters
/// the Link until the person makes a Send.
@MainActor @Observable
final class BoardSession {
    struct Snapshot {
        var drawing: PKDrawing
        var objects: [BoardObject]
    }

    let id: String
    let ink: InkCanvasController
    let files: BoardFiles
    var notice: String?
    private(set) var objects: [BoardObject]
    var selection: Set<String> = [] { didSet { if selection != oldValue, editing.map({ !selection.contains($0) }) ?? false { editing = nil } } }
    /// Strokes picked up by the lasso, by Reflex ID.
    var selectedStrokes: Set<String> = []
    /// The object whose text is being typed.
    var editing: String?
    var editingCell: (row: Int, col: Int)?
    /// Select mode: drag across things to select them (from a tap on empty canvas, or the lasso).
    var selecting = false
    @ObservationIgnored private var lastInsertCenter: CGPoint?
    /// Guides shown while dragging, in Space points: vertical x's and horizontal y's.
    var guides: (x: [CGFloat], y: [CGFloat]) = ([], [])
    /// The shape the palette's Shape tool places.
    var shapeTool: ShapeKind = .roundedRect
    private(set) var canUndo = false { didSet { if canUndo != oldValue { ink.canvasView.boardUndo.refresh() } } }
    private(set) var canRedo = false { didSet { if canRedo != oldValue { ink.canvasView.boardUndo.refresh() } } }
    /// The last few undo steps, newest first, for the long-press history menu.
    private(set) var undoNames: [String] = []

    @ObservationIgnored private let link: LinkSync
    @ObservationIgnored let library: BoardLibrary
    @ObservationIgnored private var sending: Task<Void, Never>?
    @ObservationIgnored private var reserved = Set<String>()
    @ObservationIgnored private var undoStack: [(name: String, state: Snapshot)] = []
    @ObservationIgnored private var redoStack: [(name: String, state: Snapshot)] = []
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var gestureStart: [String: CGRect] = [:]
    @ObservationIgnored private var gestureStrokesMoved = CGPoint.zero
    @ObservationIgnored private var gestureEnds: [String: (CGPoint, CGPoint)] = [:]
    @ObservationIgnored private var lastPasteOffset: CGFloat = 0
    /// Ink changes made by the board itself (moving a selection), which record their own undo step.
    @ObservationIgnored private var quiet = false

    private func quietly(_ f: () -> Void) {
        quiet = true
        f()
        quiet = false
    }

    init(id: String, link: LinkSync, library: BoardLibrary, customItems: [PKToolPickerCustomItem]) {
        self.id = id
        self.link = link
        self.library = library
        files = library.files(id)
        ink = InkCanvasController(space: id, customItems: customItems)
        objects = files.loadObjects()
        reflowConnectors()
        loadHistory()
        ink.onFinishedChange = { [weak self] before in
            guard let self, !self.quiet else { return }
            self.push("Drawing", Snapshot(drawing: before, objects: self.objects))
        }
        let undo = ink.canvasView.boardUndo
        undo.undoAction = { [weak self] in self?.undo() }
        undo.redoAction = { [weak self] in self?.redo() }
        undo.canUndoCheck = { [weak self] in self?.canUndo ?? false }
        undo.canRedoCheck = { [weak self] in self?.canRedo ?? false }
        library.update(id) { $0.opened = Date() }
    }

    var meta: BoardMeta { library.boards[id] ?? BoardMeta(id: id, title: "Untitled", created: Date(), modified: Date()) }

    func updateMeta(_ change: (inout BoardMeta) -> Void) { library.update(id, change) }

    func say(_ text: String) {
        notice = text
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            if self?.notice == text { self?.notice = nil }
        }
    }

    // MARK: Opening and leaving

    /// Puts the view where the person left it, or on the content.
    func restoreViewport() {
        if let v = meta.viewport {
            ink.show(center: v.center, zoom: v.zoom, animated: false)
        } else if let r = contentBounds {
            ink.show(rect: r, animated: false, maxZoom: 1)
        } else {
            ink.show(center: CGPoint(x: 400, y: 400), zoom: 1, animated: false)
        }
    }

    var isEmpty: Bool { ink.drawing.strokes.isEmpty && objects.isEmpty }

    /// Saves everything. Returns true if the board was empty and new, and so discarded.
    @discardableResult
    func close() -> Bool {
        ink.flush()
        if isEmpty && !meta.hasContent {
            library.delete([id])
            return true
        }
        let r = ink.visibleRect
        updateMeta { $0.viewport = Viewport(center: CGPoint(x: r.midX, y: r.midY), zoom: ink.zoomScale) }
        saveNow()
        saveHistory()
        writeThumbnail()
        return false
    }

    func saveNow() {
        saveTask?.cancel()
        files.save(objects: objects)
        let text = objects.flatMap { o in [o.text] + (o.table?.cells.flatMap { $0 } ?? []) }.filter { !$0.isEmpty }.joined(separator: "\n")
        updateMeta {
            $0.text = text
            if !isEmpty { $0.hasContent = true }
        }
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            self?.saveNow()
        }
    }

    func writeThumbnail() {
        let rect = contentBounds ?? CGRect(x: 0, y: 0, width: 800, height: 600)
        let paper = meta.paper
        let image = BoardRenderer.image(of: rect.insetBy(dx: -40, dy: -40), drawing: ink.drawing, objects: objects, files: files, paper: paper, maxSide: 640, dark: false)
        guard let data = image?.pngData() else { return }
        let url = files.thumbnail
        let library = library, id = id
        BoardFiles.queue.async {
            try? data.write(to: url, options: .atomic)
            Task { @MainActor in library.thumbnailWritten(id) }
        }
    }

    /// Everything on the board, in Space points.
    var contentBounds: CGRect? {
        var r = ink.drawing.strokes.isEmpty ? CGRect.null : ink.drawing.bounds
        for o in objects { r = r.union(o.frame) }
        return r.isNull ? nil : r
    }

    // MARK: History (ink and objects together, kept on disk)

    private func push(_ name: String, _ state: Snapshot) {
        undoStack.append((name, state))
        if undoStack.count > 60 { undoStack.removeFirst(undoStack.count - 60) }
        redoStack.removeAll()
        refreshUndo()
        updateMeta { $0.modified = Date(); $0.hasContent = true }
        scheduleSave()
    }

    private var current: Snapshot { Snapshot(drawing: ink.drawing, objects: objects) }

    func undo() {
        ink.flush()
        guard let step = undoStack.popLast() else { return }
        redoStack.append((step.name, current))
        apply(step.state)
    }

    func redo() {
        guard let step = redoStack.popLast() else { return }
        undoStack.append((step.name, current))
        apply(step.state)
    }

    /// Undoes several steps at once, from the history menu.
    func undo(steps: Int) { for _ in 0 ..< steps { undo() } }

    private func apply(_ s: Snapshot) {
        if s.drawing.dataRepresentation() != ink.drawing.dataRepresentation() { ink.restore(s.drawing) }
        objects = s.objects
        let ids = Set(objects.map(\.id))
        selection = selection.filter(ids.contains)
        selectedStrokes = []
        refreshUndo()
        updateMeta { $0.modified = Date() }
        scheduleSave()
    }

    private func refreshUndo() {
        canUndo = !undoStack.isEmpty
        canRedo = !redoStack.isEmpty
        undoNames = undoStack.suffix(8).reversed().map(\.name)
    }

    private struct SavedStep: Codable {
        var name: String
        var drawing: Data
        var objects: [BoardObject]
    }

    private struct SavedHistory: Codable {
        var undo: [SavedStep]
        var redo: [SavedStep]
        /// The drawing the history leads up to; if the ink changed outside it, the history is dropped.
        var current: Data
    }

    func saveHistory() {
        let keep = 30
        let encode = { (steps: [(name: String, state: Snapshot)]) in
            steps.suffix(keep).map { SavedStep(name: $0.name, drawing: $0.state.drawing.dataRepresentation(), objects: $0.state.objects) }
        }
        let saved = SavedHistory(undo: encode(undoStack), redo: encode(redoStack), current: ink.drawing.dataRepresentation())
        let url = files.history
        BoardFiles.queue.async {
            if let data = try? BoardFiles.encoder.encode(saved) { try? data.write(to: url, options: .atomic) }
        }
    }

    private func loadHistory() {
        guard let data = try? Data(contentsOf: files.history),
              let saved = try? BoardFiles.decoder.decode(SavedHistory.self, from: data),
              saved.current == ink.drawing.dataRepresentation() else { return }
        let decode = { (steps: [SavedStep]) in
            steps.compactMap { s in (try? PKDrawing(data: s.drawing)).map { (name: s.name, state: Snapshot(drawing: $0, objects: s.objects)) } }
        }
        undoStack = decode(saved.undo)
        redoStack = decode(saved.redo)
        refreshUndo()
    }

    // MARK: Objects

    func object(_ id: String) -> BoardObject? { objects.first { $0.id == id } }

    var selectedObjects: [BoardObject] { objects.filter { selection.contains($0.id) } }

    /// Changes objects as one undo step.
    func change(_ ids: Set<String>, _ name: String = "Edit", record: Bool = true, _ f: (inout BoardObject) -> Void) {
        let before = current
        var changed = false
        for i in objects.indices where ids.contains(objects[i].id) {
            var o = objects[i]
            f(&o)
            if o != objects[i] {
                objects[i] = o
                changed = true
            }
        }
        guard changed else { return }
        if record { push(name, before) } else { scheduleSave() }
        reflowConnectors()
    }

    func changeSelection(_ name: String = "Edit", _ f: (inout BoardObject) -> Void) { change(selection, name, f) }

    @discardableResult
    func insert(_ o: BoardObject, select: Bool = true, edit: Bool = false) -> String {
        let before = current
        objects.append(o)
        lastInsertCenter = CGPoint(x: o.frame.midX, y: o.frame.midY)
        push("Insert", before)
        if select {
            selection = [o.id]
            selectedStrokes = []
        }
        if edit { editing = o.id }
        return o.id
    }

    /// Where a new object goes: the middle of the view, nudged so repeats don't stack exactly.
    func newFrame(_ base: CGSize, at point: CGPoint? = nil) -> CGRect {
        // Zoomed out, new things come in big enough to see and type into.
        let k = 1 / min(max(ink.zoomScale, 0.35), 1)
        let size = CGSize(width: base.width * k, height: base.height * k)
        let r = ink.visibleRect
        let c = point ?? freeSpot(for: size, near: CGPoint(x: r.midX, y: r.midY), in: r)
        return CGRect(x: c.x - size.width / 2, y: c.y - size.height / 2, width: size.width, height: size.height).integral
    }

    /// The centre of a free spot for a new object: the middle of the view if nothing is there,
    /// else the nearest clear place around it, else a step down and right from the last insert.
    private func freeSpot(for size: CGSize, near c: CGPoint, in view: CGRect) -> CGPoint {
        let gap: CGFloat = 24
        func clear(_ p: CGPoint) -> Bool {
            let f = CGRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height)
            guard view.insetBy(dx: 20, dy: 60).contains(f) else { return false }
            let padded = f.insetBy(dx: -gap / 2, dy: -gap / 2)
            return !objects.contains { !$0.isConnector && $0.frame.intersects(padded) }
        }
        if clear(c) { return c }
        let dx = size.width + gap, dy = size.height + gap
        for ring in 1 ... 3 {
            var spots: [CGPoint] = []
            for i in -ring ... ring {
                for j in -ring ... ring where max(abs(i), abs(j)) == ring {
                    spots.append(CGPoint(x: c.x + CGFloat(i) * dx, y: c.y + CGFloat(j) * dy))
                }
            }
            if let best = spots.filter(clear).min(by: { hypot($0.x - c.x, $0.y - c.y) < hypot($1.x - c.x, $1.y - c.y) }) { return best }
        }
        // Nothing fully clear (a big image, a crowded view): take the visible spot that covers least.
        func covered(_ p: CGPoint) -> CGFloat {
            let f = CGRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height)
            return objects.filter { !$0.isConnector }.reduce(0) { sum, o in
                let i = o.frame.intersection(f)
                return sum + (i.isNull ? 0 : i.width * i.height)
            }
        }
        let step = max(min(size.width, size.height) / 2, 60)
        var candidates: [CGPoint] = []
        var y = view.minY + 60 + size.height / 2
        while y <= view.maxY - 90 - size.height / 2 {
            var x = view.minX + 20 + size.width / 2
            while x <= view.maxX - 20 - size.width / 2 { candidates.append(CGPoint(x: x, y: y)); x += step }
            y += step
        }
        if let best = candidates.min(by: { (covered($0), hypot($0.x - c.x, $0.y - c.y)) < (covered($1), hypot($1.x - c.x, $1.y - c.y)) }),
           covered(best) < covered(c) {
            return best
        }
        if let last = lastInsertCenter, view.contains(last) {
            lastInsertCenter = CGPoint(x: last.x + gap, y: last.y + gap)
            return lastInsertCenter!
        }
        return c
    }

    func addSticky(at point: CGPoint? = nil) {
        let f = newFrame(CGSize(width: 220, height: 220), at: point)
        insert(BoardObject(kind: .sticky, frame: f, fill: Palette.sticky[0], fontSize: 22 * f.width / 220), edit: true)
    }

    func addText(at point: CGPoint? = nil) {
        let f = newFrame(CGSize(width: 260, height: 60), at: point)
        insert(BoardObject(kind: .text, frame: f, fontSize: (28 * f.width / 260).rounded(), align: .leading, shadow: false), edit: true)
    }

    func addShape(_ kind: ShapeKind, at point: CGPoint? = nil) {
        if kind.isLine {
            let f = newFrame(CGSize(width: 220, height: 140), at: point)
            var o = BoardObject(kind: .connector, frame: f, lineWidth: 3)
            o.from = ConnectorEnd(object: nil, point: CGPoint(x: f.minX, y: f.maxY))
            o.to = ConnectorEnd(object: nil, point: CGPoint(x: f.maxX, y: f.minY))
            o.endArrow = kind == .arrow
            o.connectorStyle = kind == .curve ? .curved : .straight
            o.shape = kind
            insert(o)
            return
        }
        let size = kind == .terminator ? CGSize(width: 240, height: 100) : kind == .parallelogram || kind == .blockArrow ? CGSize(width: 240, height: 150) : CGSize(width: 180, height: 180)
        insert(BoardObject(kind: .shape, frame: newFrame(size, at: point), fill: Palette.fills[0], stroke: nil, dash: .none, fontSize: 20, shape: kind, shadow: false))
    }

    func addSymbol(_ name: String, at point: CGPoint? = nil) {
        insert(BoardObject(kind: .symbol, frame: newFrame(CGSize(width: 160, height: 160), at: point), fill: "#0A84FF", symbol: name, shadow: false))
    }

    func addTable(at point: CGPoint? = nil) {
        insert(BoardObject(kind: .table, frame: newFrame(CGSize(width: 360, height: 160), at: point), fill: "#FFFFFF", stroke: "#AEAEB2", fontSize: 17, align: .leading,
                           table: TableData(cells: [["", ""], ["", ""]]), shadow: false))
    }

    func addImage(_ data: Data, at point: CGPoint? = nil) {
        guard let image = UIImage(data: data) else { return say("That image couldn't be read.") }
        let name = "img_" + UUID().uuidString.prefix(12).lowercased() + ".png"
        let png = image.pngData() ?? data
        do {
            try FileManager.default.createDirectory(at: files.media, withIntermediateDirectories: true)
            try png.write(to: files.mediaURL(name), options: .atomic)
        } catch { return say("Could not save the image: \(error.localizedDescription)") }
        let maxSide: CGFloat = 520
        let s = image.size
        let k = min(1, maxSide / max(s.width, s.height, 1))
        insert(BoardObject(kind: .image, frame: newFrame(CGSize(width: s.width * k, height: s.height * k), at: point), image: name, shadow: false))
    }

    func deleteSelection() {
        let before = current
        let ids = selection
        if !selectedStrokes.isEmpty { quietly { ink.removeStrokes(selectedStrokes) } }
        objects.removeAll { ids.contains($0.id) || ($0.isConnector && (ids.contains($0.from?.object ?? "-") || ids.contains($0.to?.object ?? "-"))) }
        selection = []
        selectedStrokes = []
        if objects.count != before.objects.count || before.drawing.strokes.count != ink.drawing.strokes.count { push("Delete", before) }
    }

    func duplicateSelection() {
        let before = current
        var map: [String: String] = [:]
        var copies: [BoardObject] = []
        for o in selectedObjects {
            var c = o
            c.id = BoardObject(kind: o.kind, frame: .zero).id
            c.frame = o.frame.offsetBy(dx: 30, dy: 30)
            c.locked = false
            c.from?.point.x += 30; c.from?.point.y += 30
            c.to?.point.x += 30; c.to?.point.y += 30
            map[o.id] = c.id
            copies.append(c)
        }
        // Copies of grouped things form a new group, and connectors between copies stick to the copies.
        var groups: [String: String] = [:]
        for i in copies.indices {
            if let g = copies[i].group { copies[i].group = groups[g] ?? { let n = "g_" + UUID().uuidString.prefix(8); groups[g] = n; return n }() }
            if let f = copies[i].from?.object { copies[i].from?.object = map[f] }
            if let t = copies[i].to?.object { copies[i].to?.object = map[t] }
        }
        objects.append(contentsOf: copies)
        var strokes: [String] = []
        if !selectedStrokes.isEmpty { quietly { strokes = ink.duplicateStrokes(selectedStrokes, offset: CGPoint(x: 30, y: 30)) } }
        selection = Set(copies.map(\.id))
        selectedStrokes = Set(strokes)
        push("Duplicate", before)
        reflowConnectors()
    }

    func bringToFront() { reorder(front: true) }
    func sendToBack() { reorder(front: false) }

    /// The ink is one layer in the order: Front puts objects over the drawing, Back puts them under it.
    private func reorder(front: Bool) {
        let before = current
        var picked = objects.filter { selection.contains($0.id) }
        for i in picked.indices { picked[i].aboveInk = front ? true : nil }
        objects.removeAll { selection.contains($0.id) }
        objects = front ? objects + picked : picked + objects
        push(front ? "Bring to Front" : "Send to Back", before)
    }

    var selectionAboveInk: Bool { !selectedObjects.isEmpty && selectedObjects.allSatisfy(\.isAboveInk) }

    /// Moves the selection over or under the drawing, keeping its order among objects.
    func setAboveInk(_ above: Bool) {
        changeSelection(above ? "Bring Above Drawing" : "Send Below Drawing") { $0.aboveInk = above ? true : nil }
    }

    func toggleLock() {
        let lock = !selectedObjects.allSatisfy(\.locked)
        changeSelection(lock ? "Lock" : "Unlock") { $0.locked = lock }
    }

    var selectionIsGroup: Bool {
        let groups = Set(selectedObjects.map(\.group))
        return groups.count == 1 && groups.first! != nil
    }

    func group() {
        guard selection.count > 1 else { return }
        let g = "g_" + UUID().uuidString.prefix(8).lowercased()
        changeSelection("Group") { $0.group = g }
    }

    func ungroup() { changeSelection("Ungroup") { $0.group = nil } }

    /// Taps select a whole group.
    func select(_ id: String, adding: Bool = false) {
        guard let o = object(id) else { return }
        let members = o.group.map { g in Set(objects.filter { $0.group == g }.map(\.id)) } ?? [id]
        if adding {
            if selection.isSuperset(of: members) { selection.subtract(members) } else { selection.formUnion(members) }
        } else {
            selection = members
            selectedStrokes = []
        }
    }

    func clearSelection() {
        selection = []
        selectedStrokes = []
        editing = nil
        editingCell = nil
    }

    func selectAll() {
        selection = Set(objects.map(\.id))
        selectedStrokes = Set(ink.strokes.map(\.id))
    }

    enum AlignEdge { case left, centerX, right, top, centerY, bottom }

    func align(_ edge: AlignEdge) {
        let frames = selectedObjects.filter { !$0.isConnector && !$0.locked }.map(\.frame)
        guard frames.count > 1 else { return }
        let u = frames.reduce(CGRect.null) { $0.union($1) }
        changeSelection("Align") { o in
            guard !o.isConnector, !o.locked else { return }
            switch edge {
            case .left: o.frame.origin.x = u.minX
            case .centerX: o.frame.origin.x = u.midX - o.frame.width / 2
            case .right: o.frame.origin.x = u.maxX - o.frame.width
            case .top: o.frame.origin.y = u.minY
            case .centerY: o.frame.origin.y = u.midY - o.frame.height / 2
            case .bottom: o.frame.origin.y = u.maxY - o.frame.height
            }
        }
    }

    func distribute(horizontally: Bool) {
        let list = selectedObjects.filter { !$0.isConnector && !$0.locked }.sorted { horizontally ? $0.frame.minX < $1.frame.minX : $0.frame.minY < $1.frame.minY }
        guard list.count > 2 else { return }
        let total = list.reduce(0) { $0 + (horizontally ? $1.frame.width : $1.frame.height) }
        let span = horizontally ? list.last!.frame.maxX - list.first!.frame.minX : list.last!.frame.maxY - list.first!.frame.minY
        let gap = (span - total) / CGFloat(list.count - 1)
        var pos = horizontally ? list.first!.frame.minX : list.first!.frame.minY
        var target: [String: CGFloat] = [:]
        for o in list {
            target[o.id] = pos
            pos += (horizontally ? o.frame.width : o.frame.height) + gap
        }
        change(Set(target.keys), "Distribute") { o in
            if horizontally { o.frame.origin.x = target[o.id]! } else { o.frame.origin.y = target[o.id]! }
        }
    }

    // MARK: Moving and resizing

    /// Bounds of the selection (objects and strokes), in Space points.
    var selectionBounds: CGRect? {
        var r = selectedObjects.reduce(CGRect.null) { $0.union($1.frame) }
        if !selectedStrokes.isEmpty { r = r.union(ink.bounds(ofStrokes: selectedStrokes)) }
        return r.isNull ? nil : r
    }

    func beginMove() {
        gestureStart = Dictionary(uniqueKeysWithValues: selectedObjects.map { ($0.id, $0.frame) })
        gestureEnds = Dictionary(uniqueKeysWithValues: selectedObjects.filter(\.isConnector).map { ($0.id, ($0.from?.point ?? .zero, $0.to?.point ?? .zero)) })
        gestureStrokesMoved = .zero
        undoStack.append(("Move", current))
        redoStack.removeAll()
        if !selectedStrokes.isEmpty { ink.beginLiveEdit() }
    }

    @ObservationIgnored private var wasSnapped = false
    @ObservationIgnored private lazy var snapHaptic = UIImpactFeedbackGenerator(style: .light)

    /// Moves the selection by a translation in Space points, with guides and snapping.
    func move(by t: CGSize, guidesOn: GuideSettings) {
        let movable = gestureStart.filter { id, _ in object(id).map { !$0.locked } ?? false }
        let startBounds = movable.values.reduce(CGRect.null) { $0.union($1) }
        var d = CGPoint(x: t.width, y: t.height)
        guides = ([], [])
        if !startBounds.isNull {
            let moved = startBounds.offsetBy(dx: d.x, dy: d.y)
            let (adjust, lines) = snap(moved, settings: guidesOn, excluding: Set(movable.keys))
            d.x += adjust.x
            d.y += adjust.y
            // A light tap when a guide catches the object, as in Freeform.
            let snapped = !lines.x.isEmpty || !lines.y.isEmpty
            if snapped && !wasSnapped { snapHaptic.impactOccurred(intensity: 0.6) }
            wasSnapped = snapped
            guides = lines
        }
        for i in objects.indices {
            guard let start = movable[objects[i].id] else { continue }
            if objects[i].isConnector, let ends = gestureEnds[objects[i].id] {
                if objects[i].from?.object == nil { objects[i].from?.point = CGPoint(x: ends.0.x + d.x, y: ends.0.y + d.y) }
                if objects[i].to?.object == nil { objects[i].to?.point = CGPoint(x: ends.1.x + d.x, y: ends.1.y + d.y) }
            } else {
                objects[i].frame.origin = CGPoint(x: start.minX + d.x, y: start.minY + d.y)
            }
        }
        if !selectedStrokes.isEmpty {
            let step = CGAffineTransform(translationX: d.x - gestureStrokesMoved.x, y: d.y - gestureStrokesMoved.y)
            ink.transformStrokes(selectedStrokes, by: step)
            gestureStrokesMoved = d
        }
        reflowConnectors()
    }

    func endMove() {
        guides = ([], [])
        if !selectedStrokes.isEmpty { quietly { ink.endLiveEdit() } }
        // A move that went nowhere isn't an undo step.
        if let last = undoStack.last, last.name == "Move", last.state.objects == objects, gestureStrokesMoved == .zero {
            undoStack.removeLast()
        }
        gestureStart = [:]
        refreshUndo()
        updateMeta { $0.modified = Date(); $0.hasContent = true }
        scheduleSave()
    }

    func beginResize() {
        undoStack.append(("Resize", current))
        redoStack.removeAll()
    }

    func resize(_ id: String, to frame: CGRect) {
        guard let i = objects.firstIndex(where: { $0.id == id }) else { return }
        var f = frame.standardized
        f.size.width = max(f.width, 24)
        f.size.height = max(f.height, 24)
        objects[i].frame = f
        reflowConnectors()
    }

    func endResize() {
        refreshUndo()
        updateMeta { $0.modified = Date() }
        scheduleSave()
    }

    /// Moves a connector's end, sticking it to an object under it.
    func moveEnd(_ id: String, start: Bool, to p: CGPoint, attach: Bool) {
        guard let i = objects.firstIndex(where: { $0.id == id }) else { return }
        let target = attach ? objects.last(where: { !$0.isConnector && $0.id != id && $0.frame.insetBy(dx: -8, dy: -8).contains(p) })?.id : nil
        let end = ConnectorEnd(object: target, point: p)
        if start { objects[i].from = end } else { objects[i].to = end }
        reflowConnectors()
    }

    /// Starts a connector from an object's handle; returns its ID.
    func beginConnector(from object: String, at p: CGPoint) -> String {
        undoStack.append(("Connector", current))
        redoStack.removeAll()
        var o = BoardObject(kind: .connector, frame: CGRect(origin: p, size: .zero), lineWidth: 3)
        o.from = ConnectorEnd(object: object, point: p)
        o.to = ConnectorEnd(object: nil, point: p)
        objects.append(o)
        return o.id
    }

    func endConnector(_ id: String) {
        // A connector dragged nowhere is dropped.
        if let o = object(id), let a = o.from?.point, let b = o.to?.point, hypot(a.x - b.x, a.y - b.y) < 20, o.to?.object == nil {
            objects.removeAll { $0.id == id }
            undoStack.removeLast()
        } else {
            selection = [id]
        }
        refreshUndo()
        scheduleSave()
    }

    /// Keeps connector frames and stuck ends up to date.
    private func reflowConnectors() {
        let frames = Dictionary(objects.map { ($0.id, $0.frame) }, uniquingKeysWith: { a, _ in a })
        let ovals = Set(objects.filter { $0.kind == .shape && $0.shape == .circle }.map(\.id))
        for i in objects.indices where objects[i].isConnector {
            var o = objects[i]
            if let f = o.from?.object, let r = frames[f] { o.from?.point = ConnectorGeometry.edgePoint(of: r, toward: o.to.map { pointFor($0, frames) } ?? CGPoint(x: r.midX, y: r.midY), oval: ovals.contains(f)) }
            if let t = o.to?.object, let r = frames[t] { o.to?.point = ConnectorGeometry.edgePoint(of: r, toward: o.from.map { pointFor($0, frames) } ?? CGPoint(x: r.midX, y: r.midY), oval: ovals.contains(t)) }
            if let a = o.from?.point, let b = o.to?.point {
                o.frame = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
            }
            if o != objects[i] { objects[i] = o }
        }
    }

    private func pointFor(_ end: ConnectorEnd, _ frames: [String: CGRect]) -> CGPoint {
        if let id = end.object, let r = frames[id] { return CGPoint(x: r.midX, y: r.midY) }
        return end.point
    }

    // MARK: Guides

    struct GuideSettings {
        var snapToGrid: Bool
        var center: Bool
        var edges: Bool
        var spacing: Bool
        var grid: CGFloat
    }

    private func snap(_ r: CGRect, settings: GuideSettings, excluding: Set<String>) -> (CGPoint, (x: [CGFloat], y: [CGFloat])) {
        let threshold = 6 / max(ink.zoomScale, 0.1)
        var dx: CGFloat?
        var dy: CGFloat?
        var gx: [CGFloat] = []
        var gy: [CGFloat] = []
        let others = objects.filter { !excluding.contains($0.id) && !$0.isConnector && $0.frame.intersects(ink.visibleRect.insetBy(dx: -200, dy: -200)) }
        func consider(_ value: CGFloat, _ targets: [CGFloat], _ current: inout CGFloat?, _ lines: inout [CGFloat], offset: CGFloat) {
            for t in targets where abs(t - value) < threshold {
                if current == nil || abs(t - value) < abs(current!) { current = t - value; lines = [t] }
            }
            _ = offset
        }
        var xs: [CGFloat] = []
        var ys: [CGFloat] = []
        for o in others {
            if settings.edges { xs += [o.frame.minX, o.frame.maxX]; ys += [o.frame.minY, o.frame.maxY] }
            if settings.center { xs.append(o.frame.midX); ys.append(o.frame.midY) }
        }
        if settings.center {
            let v = ink.visibleRect
            xs.append(v.midX)
            ys.append(v.midY)
        }
        for value in settings.edges ? [r.minX, r.maxX, r.midX] : [r.midX] { consider(value, xs, &dx, &gx, offset: 0) }
        for value in settings.edges ? [r.minY, r.maxY, r.midY] : [r.midY] { consider(value, ys, &dy, &gy, offset: 0) }
        // Equal spacing: the gap to the nearest neighbour matches the gap between two others.
        if settings.spacing, dx == nil {
            let row = others.filter { $0.frame.maxY > r.minY && $0.frame.minY < r.maxY }.sorted { $0.frame.minX < $1.frame.minX }
            if row.count >= 2 {
                let gaps = zip(row, row.dropFirst()).map { $1.frame.minX - $0.frame.maxX }.filter { $0 > 0 }
                if let left = row.last(where: { $0.frame.maxX <= r.minX + threshold }) {
                    for g in gaps where abs((r.minX - left.frame.maxX) - g) < threshold {
                        dx = (left.frame.maxX + g) - r.minX
                        gx = [left.frame.maxX, left.frame.maxX + g]
                    }
                }
            }
        }
        if settings.snapToGrid {
            if dx == nil { dx = (r.minX / settings.grid).rounded() * settings.grid - r.minX }
            if dy == nil { dy = (r.minY / settings.grid).rounded() * settings.grid - r.minY }
        }
        return (CGPoint(x: dx ?? 0, y: dy ?? 0), (gx, gy))
    }

    // MARK: Lasso

    func select(lasso path: CGPath, adding: Bool) {
        let picked = objects.filter { o in
            if o.isConnector, let a = o.from?.point, let b = o.to?.point { return path.contains(a) && path.contains(b) }
            return path.contains(CGPoint(x: o.frame.midX, y: o.frame.midY))
        }.map(\.id)
        var ids = Set(picked)
        // Whole groups.
        let groups = Set(objects.filter { ids.contains($0.id) }.compactMap(\.group))
        ids.formUnion(objects.filter { $0.group.map(groups.contains) ?? false }.map(\.id))
        let strokes = Set(ink.strokeIDs(ink.strokeIndexes(inside: path)))
        if adding {
            selection.formUnion(ids)
            selectedStrokes.formUnion(strokes)
        } else {
            selection = ids
            selectedStrokes = strokes
        }
    }

    func recolorSelectedStrokes(_ hex: String) {
        push("Color", current)
        quietly { ink.recolorStrokes(selectedStrokes, color: UIColor(hex: hex)) }
    }

    // MARK: Clipboard

    func copySelection() {
        let list = selectedObjects
        if let data = try? BoardFiles.encoder.encode(list) {
            var item: [String: Any] = ["si.eilmer.reflex.objects": data]
            let text = list.map(\.text).filter { !$0.isEmpty }.joined(separator: "\n")
            if !text.isEmpty { item["public.utf8-plain-text"] = text }
            if list.count == 1, let name = list[0].image, let img = UIImage(contentsOfFile: files.mediaURL(name).path(percentEncoded: false)) { item["public.png"] = img.pngData() as Any }
            UIPasteboard.general.items = [item]
        }
    }

    func cutSelection() {
        copySelection()
        deleteSelection()
    }

    var canPaste: Bool {
        let pb = UIPasteboard.general
        return pb.hasImages || pb.hasStrings || pb.contains(pasteboardTypes: ["si.eilmer.reflex.objects"])
    }

    func paste(at point: CGPoint? = nil) {
        let pb = UIPasteboard.general
        if let data = pb.data(forPasteboardType: "si.eilmer.reflex.objects"), let list = try? BoardFiles.decoder.decode([BoardObject].self, from: data), !list.isEmpty {
            lastPasteOffset += 30
            let u = list.reduce(CGRect.null) { $0.union($1.frame) }
            let target = point ?? CGPoint(x: ink.visibleRect.midX, y: ink.visibleRect.midY)
            let dx = target.x - u.midX + (point == nil ? lastPasteOffset : 0), dy = target.y - u.midY + (point == nil ? lastPasteOffset : 0)
            let before = current
            var copies: [BoardObject] = []
            for var o in list {
                o.id = BoardObject(kind: o.kind, frame: .zero).id
                o.frame = o.frame.offsetBy(dx: dx, dy: dy)
                o.from = o.from.map { ConnectorEnd(object: nil, point: CGPoint(x: $0.point.x + dx, y: $0.point.y + dy)) }
                o.to = o.to.map { ConnectorEnd(object: nil, point: CGPoint(x: $0.point.x + dx, y: $0.point.y + dy)) }
                // An image copied from another board needs its file here.
                if let name = o.image, !FileManager.default.fileExists(atPath: files.mediaURL(name).path(percentEncoded: false)) { o.image = nil }
                copies.append(o)
            }
            objects.append(contentsOf: copies)
            selection = Set(copies.map(\.id))
            push("Paste", before)
            return
        }
        if let image = pb.image, let data = image.pngData() {
            addImage(data, at: point)
            return
        }
        if let text = pb.string, !text.isEmpty {
            var o = BoardObject(kind: .text, frame: newFrame(CGSize(width: 320, height: 60), at: point), fontSize: 24, align: .leading, shadow: false)
            o.text = text
            let lines = CGFloat(max(1, text.split(separator: "\n").count))
            o.frame.size.height = max(60, lines * 34 + 20)
            insert(o)
        }
    }

    /// Text typed into an object; empty text boxes are removed when editing ends.
    func endEditing() {
        guard let id = editing else { return }
        editing = nil
        editingCell = nil
        if let o = object(id), o.kind == .text, o.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let before = current
            objects.removeAll { $0.id == id }
            selection.remove(id)
            undoStack.append(("Delete", before))
            refreshUndo()
        }
        scheduleSave()
    }

    /// Typing: one undo step per editing session.
    func setText(_ id: String, _ text: String) {
        guard let i = objects.firstIndex(where: { $0.id == id }), objects[i].text != text else { return }
        if undoStack.last?.name != "Typing \(id)" { push("Typing \(id)", current) }
        objects[i].text = text
        if objects[i].kind == .text { autosizeText(i) }
        scheduleSave()
    }

    func setCell(_ id: String, row: Int, col: Int, _ text: String) {
        guard let i = objects.firstIndex(where: { $0.id == id }), var t = objects[i].table, row < t.rows, col < t.cols, t.cells[row][col] != text else { return }
        if undoStack.last?.name != "Typing \(id)" { push("Typing \(id)", current) }
        t.cells[row][col] = text
        objects[i].table = t
        scheduleSave()
    }

    private func autosizeText(_ i: Int) {
        let o = objects[i]
        let font = UIFont.systemFont(ofSize: o.fontSize, weight: o.bold ? .bold : .regular)
        let box = (o.text.isEmpty ? "M" : o.text).boundingRect(with: CGSize(width: o.frame.width - 16, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], attributes: [.font: font], context: nil)
        objects[i].frame.size.height = max(ceil(box.height) + 20, o.fontSize + 20)
    }

    func resizeTable(_ id: String, rows: Int, cols: Int) {
        change([id], "Table") { o in
            guard var t = o.table else { return }
            let rows = max(1, min(rows, 30)), cols = max(1, min(cols, 12))
            let rowH = o.frame.height / CGFloat(max(t.rows, 1)), colW = o.frame.width / CGFloat(max(t.cols, 1))
            while t.cells.count < rows { t.cells.append(Array(repeating: "", count: t.cols)) }
            t.cells = Array(t.cells.prefix(rows))
            t.cells = t.cells.map { r in Array((r + Array(repeating: "", count: max(0, cols - r.count))).prefix(cols)) }
            o.frame.size = CGSize(width: colW * CGFloat(cols), height: rowH * CGFloat(rows))
            o.table = t
        }
    }

    // MARK: Scenes

    func addScene() {
        let n = meta.scenes.count + 1
        let rect = ink.visibleRect
        updateMeta { $0.scenes.append(BoardScene(name: "Scene \(n)", rect: rect)) }
        say("Added Scene \(n)")
    }

    func show(_ scene: BoardScene) {
        ink.show(rect: scene.rect, animated: true, margin: 0, maxZoom: 4)
    }

    // MARK: Send

    func send(trigger: String, said: String? = nil, words: [[String: Any]] = []) {
        // The screen is captured as the person sees it, without selection handles.
        clearSelection()
        let destination = link.destinationKey
        let ids = ink.pendingStrokes().filter { !reserved.contains($0) }
        if trigger == "voice", said?.isEmpty ?? true, ids.isEmpty {
            say("Didn't hear anything, so nothing was sent.")
            return
        }
        let z = ink.zoomScale, o = ink.contentOffset, size = ink.canvasView.bounds.size
        let view = CGRect(x: o.x / z, y: o.y / z, width: size.width / z, height: size.height / z)
        let ints = { (r: CGRect) in [r.minX, r.minY, r.width, r.height].map { Int($0.rounded()) } }
        let portable = ink.portableStrokes(ids)
        let pk = ink.pkStrokes(ids)
        let encode = { (s: PortableStroke) -> [String: Any] in
            ["id": s.id, "points": s.spacePoints, "bounds": s.bounds, "color": s.namedColor, "width": s.points.first?.width ?? 3, "at": Int64(s.createdAt.timeIntervalSince1970 * 1000)]
        }
        var raw: [String: Any] = ["send": "s_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(), "trigger": trigger, "viewport": ints(view),
            "strokes": portable.map(encode), "context": ink.portableStrokes(ink.strokes.map(\.id)).map(encode)]
        if let said, !said.isEmpty { raw["said"] = said }
        if !words.isEmpty { raw["words"] = words }
        let marked = ink.strokes.filter { ids.contains($0.id) }.map(\.bounds).reduce(CGRect.null) { $0.union($1) }
        let rect = marked.isNull ? view : marked.insetBy(dx: -60, dy: -60).intersection(view)
        do {
            if let crop = Crop.capture(space: rect, zoom: z, offset: o) {
                let hash = try link.storeAsset(crop.png)
                raw["crops"] = [["asset": hash, "bounds": ints(crop.bounds), "strokes": ids]]
            }
        } catch { say("Could not save the Send image: \(error.localizedDescription)"); return }
        reserved.formUnion(ids)
        let previous = sending
        preparingSends += 1
        sending = Task {
            defer { preparingSends -= 1 }
            await previous?.value
            let hints = await Handwriting.hints(pk)
            if !hints.isEmpty { raw["hints"] = hints }
            do {
                _ = try link.enqueueSend(id, raw: raw, destination: destination)
                ink.claim(ids)
                if case .connected = link.state { say("Sent") }
                else { say("Saved. It goes out when your Mac is back.") }
                lastSendOK = Date()
            } catch { say("Could not send: \(error.localizedDescription)") }
            reserved.subtract(ids)
        }
    }

    /// When the last Send was saved, for the button's checkmark.
    var lastSendOK: Date?
    /// Sends being put together (handwriting hints, crop) before they're saved.
    var preparingSends = 0
}

/// What the screen shows in one rectangle of the Space, as a PNG.
enum Crop {
    @MainActor
    static func capture(space rect: CGRect, zoom: CGFloat, offset: CGPoint) -> (png: Data, bounds: CGRect)? {
        guard !rect.isNull, rect.width >= 1, rect.height >= 1,
              let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first
        else { return nil }
        let onScreen = CGRect(x: rect.minX * zoom - offset.x, y: rect.minY * zoom - offset.y, width: rect.width * zoom, height: rect.height * zoom)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(size: onScreen.size, format: format).image { _ in
            window.drawHierarchy(in: CGRect(origin: CGPoint(x: -onScreen.minX, y: -onScreen.minY), size: window.bounds.size), afterScreenUpdates: false)
        }
        return image.pngData().map { ($0, rect) }
    }
}
