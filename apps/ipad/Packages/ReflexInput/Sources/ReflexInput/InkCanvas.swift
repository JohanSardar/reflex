import Observation
import PencilKit
import SwiftUI
import UIKit

/// A stroke on screen with its Reflex ID.
public struct InkStrokeInfo: Identifiable, Sendable {
    public var id: String
    public var parent: String?
    /// Rendered bounds in Space points.
    public var bounds: CGRect
}

/// The undo manager the canvas hands to the system (keyboard ⌘Z, three-finger
/// swipe, PencilKit). PencilKit's own registrations are switched off: the board
/// keeps one history for ink and objects, which outlives leaving the board.
public final class BoardUndoManager: UndoManager {
    public var undoAction: (() -> Void)?
    public var redoAction: (() -> Void)?
    public var canUndoCheck: (() -> Bool)?
    public var canRedoCheck: (() -> Bool)?

    override public init() {
        super.init()
        groupsByEvent = false
        disableUndoRegistration()
    }

    override public var canUndo: Bool { canUndoCheck?() ?? false }
    override public var canRedo: Bool { canRedoCheck?() ?? false }
    override public func undo() { undoAction?() }
    override public func redo() { redoAction?() }

    /// Tells listeners (the palette's undo and redo buttons) that canUndo or canRedo changed.
    public func refresh() {
        for name: Notification.Name in [.NSUndoManagerCheckpoint, .NSUndoManagerDidCloseUndoGroup, .NSUndoManagerDidUndoChange, .NSUndoManagerDidRedoChange] {
            NotificationCenter.default.post(name: name, object: self)
        }
    }
}

/// PKCanvasView with the board's own undo manager and a hook so objects under
/// the ink can take touches when the board isn't drawing.
public final class ReflexCanvasView: PKCanvasView {
    public let boardUndo = BoardUndoManager()
    override public var undoManager: UndoManager? { boardUndo }
    public var onLayout: (() -> Void)?
    /// PencilKit's own edit menu (Select All, Insert Space) would sit on top of Reflex's
    /// canvas menu and lasso, which cover ink and objects together.
    override public func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool { false }
    override public func layoutSubviews() {
        super.layoutSubviews()
        removeEditMenus(self)
        onLayout?()
    }

    private func removeEditMenus(_ view: UIView) {
        for i in view.interactions where i is UIEditMenuInteraction { view.removeInteraction(i) }
        for g in view.gestureRecognizers ?? [] where String(describing: type(of: g)).contains("EditMenu") || String(describing: type(of: g)).contains("InsertSpace") {
            g.isEnabled = false
        }
        for v in view.subviews { removeEditMenus(v) }
    }

}

/// Owns the PencilKit canvas for one board: Apple's tool picker, stroke
/// identity, saving and the viewport.
@MainActor @Observable
public final class InkCanvasController: NSObject {
    public let canvasView = ReflexCanvasView()
    public let toolPicker: PKToolPicker

    /// The viewport, for the objects and paper drawn around the ink.
    public private(set) var contentOffset: CGPoint = .zero
    public private(set) var zoomScale: CGFloat = 1
    public private(set) var viewSize: CGSize = .zero
    public private(set) var strokes: [InkStrokeInfo] = []
    /// Strokes added since the last Send, by ID.
    public private(set) var unsent: [String] = []
    /// Whether Apple's tool picker is on screen.
    public private(set) var pickerVisible = false
    /// The Reflex tool picked in the palette (shape, sticky, text), if one is.
    public private(set) var customTool: String?
    /// Whether the lasso is the picked tool (Reflex draws its own lasso, which selects objects too).
    public private(set) var lassoPicked = false
    /// Where the palette covers the screen, in window points.
    public private(set) var pickerObscured: CGRect = .null
    /// Whether one finger draws while the palette is open.
    public var fingerDraws = true { didSet { applyPolicy() } }

    /// A finished ink change, with the drawing as it was before it.
    @ObservationIgnored public var onFinishedChange: ((_ before: PKDrawing) -> Void)?
    /// A tap on the canvas outside any object, in Space points.
    @ObservationIgnored public var onTap: ((_ space: CGPoint) -> Void)?
    /// A long press on the canvas outside any object, in Space points.
    @ObservationIgnored public var onLongPress: ((_ space: CGPoint) -> Void)?

    /// Size of the scrollable Space, in points.
    public static let spaceSize = CGSize(width: 16000, height: 16000)
    /// Where a new board opens: the middle of the Space, so it scrolls every way.
    public static let newBoardCenter = CGPoint(x: 8000, y: 8000)

    @ObservationIgnored private var usingTool = false
    @ObservationIgnored private var restoring = false
    @ObservationIgnored private var paletteSynced = false
    @ObservationIgnored private var liveEdit = false
    @ObservationIgnored private var lastDrawing: PKDrawing
    @ObservationIgnored private let store: InkStore
    @ObservationIgnored private var ledger: StrokeLedger
    @ObservationIgnored private var portableCache: [String: PortableStroke] = [:]
    @ObservationIgnored private var undoGestures: [UIGestureRecognizer] = []
    @ObservationIgnored private var paletteWatch: Task<Void, Never>?

    public init(space: String, customItems: [PKToolPickerCustomItem] = []) {
        store = InkStore(space: space)
        let (drawing, ledger) = store.load()
        self.ledger = ledger
        lastDrawing = drawing
        unsent = store.loadUnsent(fallback: ledger.records.map(\.id))
        var items: [PKToolPickerItem] = [
            PKToolPickerInkingItem(type: .pen, color: .black),
            PKToolPickerInkingItem(type: .monoline, color: .systemBlue),
            PKToolPickerInkingItem(type: .marker, color: .systemYellow),
            PKToolPickerInkingItem(type: .pencil, color: .darkGray),
            PKToolPickerInkingItem(type: .fountainPen, color: .black),
            PKToolPickerInkingItem(type: .watercolor, color: .systemTeal),
            PKToolPickerInkingItem(type: .crayon, color: .systemOrange),
            PKToolPickerEraserItem(type: .vector),
            PKToolPickerEraserItem(type: .bitmap, width: 16),
            PKToolPickerLassoItem(),
            PKToolPickerRulerItem(),
        ]
        items.append(contentsOf: customItems)
        toolPicker = PKToolPicker(toolItems: items)
        super.init()

        toolPicker.stateAutosaveName = "reflex.tools"
        toolPicker.showsDrawingPolicyControls = true
        toolPicker.addObserver(canvasView)
        toolPicker.addObserver(self)

        canvasView.drawing = drawing
        canvasView.delegate = self
        canvasView.isOpaque = false
        canvasView.backgroundColor = .clear
        canvasView.contentSize = Self.spaceSize
        canvasView.minimumZoomScale = 0.1
        canvasView.maximumZoomScale = 4
        canvasView.contentInsetAdjustmentBehavior = .never
        // Room above and left of the Space's edge, so ink drawn at its very top-left (boards from
        // before the redesign) can scroll out from under the top bar. Strokes never move.
        canvasView.contentInset = Self.edgeInset
        canvasView.showsVerticalScrollIndicator = false
        canvasView.showsHorizontalScrollIndicator = false
        canvasView.decelerationRate = .normal
        canvasView.accessibilityIdentifier = "ink-canvas"
        canvasView.accessibilityLabel = "Board"

        canvasView.boardUndo.canUndoCheck = { false }
        canvasView.boardUndo.canRedoCheck = { false }

        canvasView.onLayout = { [weak self] in self?.layoutChanged() }
        addGestures()
        applyPolicy()
        publishStrokes()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
            self?.settled = true
            self?.applyPolicy()
        }
    }

    // MARK: Tool picker

    /// Shows or hides Apple's tool picker. It stays until hidden again.
    public func setPickerVisible(_ visible: Bool) {
        toolPicker.setVisible(visible, forFirstResponder: canvasView)
        if visible { canvasView.becomeFirstResponder() } else { canvasView.resignFirstResponder() }
        pickerVisible = visible
        applyPolicy()
        refreshObscured()
        // The palette's undo and redo read the board's history once it is on screen.
        if visible {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.pickerVisible else { return }
                // The palette reads canUndo when the drawing changes. Setting the same drawing once
                // (outside history and stroke tracking) shows the board's own undo state right away.
                if !self.paletteSynced {
                    self.paletteSynced = true
                    self.restoring = true
                    self.canvasView.drawing = self.canvasView.drawing
                    self.restoring = false
                }
                self.canvasView.boardUndo.refresh()
            }
        }
        // The person can drag the palette to another edge; follow it while it's open.
        paletteWatch?.cancel()
        if visible {
            paletteWatch = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(700))
                    guard let self, self.pickerVisible else { return }
                    self.refreshObscured()
                }
            }
        }
    }

    /// The palette animates in, so its frame is read again once it has settled. The floating
    /// palette of iPadOS 26 reports no obscured frame, so its view is found in the windows.
    private func refreshObscured() {
        for delay in [0.05, 0.45] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, let window = self.canvasView.window else { return }
                var r = self.toolPicker.isVisible ? self.toolPicker.frameObscured(in: window) : .null
                if self.toolPicker.isVisible, r.isNull { r = Self.paletteFrame(in: window) }
                if r != self.pickerObscured { self.pickerObscured = r }
            }
        }
    }

    private static func paletteFrame(in window: UIWindow) -> CGRect {
        func find(_ v: UIView) -> UIView? {
            if String(describing: type(of: v)) == "PKDrawingPaletteView" { return v }
            for s in v.subviews { if let f = find(s) { return f } }
            return nil
        }
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        for w in windows {
            if let v = find(w), !v.isHidden, v.alpha > 0.01 { return v.convert(v.bounds, to: nil) }
        }
        return .null
    }

    /// The last pen, pencil or marker picked, to go back to after placing an object.
    private weak var lastInkItem: PKToolPickerItem?

    /// Picks the last ink tool again after a Reflex tool has placed something, as Freeform does.
    public func pickInkTool() {
        if let pen = lastInkItem ?? toolPicker.toolItems.first(where: { $0 is PKToolPickerInkingItem }) {
            toolPicker.selectedToolItem = pen
        }
    }

    private func applyPolicy() {
        // The palette open means drawing (by finger too, if the person wants); closed, a finger
        // pans and selects and only the Pencil draws, as in Freeform.
        let drawsWithFinger = pickerVisible && fingerDraws
        #if targetEnvironment(simulator)
        canvasView.drawingPolicy = drawsWithFinger ? .anyInput : .pencilOnly
        #else
        canvasView.drawingPolicy = drawsWithFinger ? .anyInput : .pencilOnly
        #endif
        let item = toolPicker.selectedToolItem
        if item is PKToolPickerInkingItem { lastInkItem = item }
        customTool = (item as? PKToolPickerCustomItem)?.identifier
        lassoPicked = item is PKToolPickerLassoItem
        // Reflex's own tools and lasso take touches themselves; the canvas mustn't draw with them.
        canvasView.drawingGestureRecognizer.isEnabled = customTool == nil && !lassoPicked && settled
    }

    /// False for a moment after the board opens, so the tap that opened it isn't drawn as a dot.
    @ObservationIgnored private var settled = false

    /// The pen color in use, for debug strokes.
    private var currentInk: PKInk {
        (canvasView.tool as? PKInkingTool)?.ink ?? PKInk(.pen, color: .black)
    }

    // MARK: Undo hooks

    /// Swaps in a drawing from the board's history. Strokes that come back get their IDs back.
    public func restore(_ drawing: PKDrawing) {
        restoring = true
        canvasView.drawing = drawing
        restoring = false
        drawingChanged(record: false)
    }

    public var drawing: PKDrawing { canvasView.drawing }

    private func addGestures() {
        let threeFinger = UITapGestureRecognizer(target: self, action: #selector(threeFingerTap))
        threeFinger.numberOfTouchesRequired = 3
        let twoFinger = UITapGestureRecognizer(target: self, action: #selector(twoFingerTap))
        twoFinger.numberOfTouchesRequired = 2
        twoFinger.require(toFail: threeFinger)
        let tap = UITapGestureRecognizer(target: self, action: #selector(oneFingerTap(_:)))
        tap.require(toFail: twoFinger)
        let press = UILongPressGestureRecognizer(target: self, action: #selector(longPress(_:)))
        press.minimumPressDuration = 0.45
        for gesture in [twoFinger, threeFinger, tap, press] {
            gesture.allowedTouchTypes = [UITouch.TouchType.direct.rawValue as NSNumber]
            gesture.cancelsTouchesInView = false
            canvasView.addGestureRecognizer(gesture)
        }
        undoGestures = [twoFinger, threeFinger, tap, press]
    }

    @objc private func twoFingerTap() { canvasView.boardUndo.undo() }
    @objc private func threeFingerTap() { canvasView.boardUndo.redo() }
    @objc private func oneFingerTap(_ g: UITapGestureRecognizer) {
        // While the palette draws with a finger, a tap is a dot of ink, not a selection change.
        guard !(pickerVisible && fingerDraws && customTool == nil && !lassoPicked) else { return }
        guard tapsAllowed(at: g.location(in: canvasView.superview)) else { return }
        onTap?(space(g.location(in: canvasView.superview)))
    }
    @objc private func longPress(_ g: UILongPressGestureRecognizer) {
        guard g.state == .began, !(pickerVisible && fingerDraws) else { return }
        guard tapsAllowed(at: g.location(in: canvasView.superview)) else { return }
        onLongPress?(space(g.location(in: canvasView.superview)))
    }

    /// The tap that opened the board, or one on the top bar that slipped past a button
    /// (Back), must not open the canvas menu.
    private let openedAt = Date()
    private func tapsAllowed(at point: CGPoint) -> Bool {
        guard Date().timeIntervalSince(openedAt) > 0.7 else { return false }
        return point.y > 84
    }

    // MARK: Viewport

    /// A point on screen (the canvas's superview) in Space points.
    public func space(_ screen: CGPoint) -> CGPoint {
        CGPoint(x: (screen.x + canvasView.contentOffset.x) / canvasView.zoomScale,
                y: (screen.y + canvasView.contentOffset.y) / canvasView.zoomScale)
    }

    /// The Space rectangle on screen now.
    public var visibleRect: CGRect {
        let z = canvasView.zoomScale, o = canvasView.contentOffset, s = canvasView.bounds.size
        return CGRect(x: o.x / z, y: o.y / z, width: s.width / z, height: s.height / z)
    }

    /// Scrolls the view by screen points (keeps text being typed above the keyboard).
    public func scroll(by delta: CGPoint) {
        let o = canvasView.contentOffset
        let target = clamp(CGPoint(x: o.x + delta.x, y: o.y + delta.y), zoom: canvasView.zoomScale, size: canvasView.bounds.size)
        UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
            self.canvasView.contentOffset = target
        } completion: { _ in self.syncViewport() }
    }

    /// Centers the view on a Space point at a zoom.
    public func show(center: CGPoint, zoom: CGFloat, animated: Bool) {
        let size = canvasView.bounds.size == .zero ? UIScreen.main.bounds.size : canvasView.bounds.size
        let z = min(max(zoom, canvasView.minimumZoomScale), canvasView.maximumZoomScale)
        let offset = CGPoint(x: center.x * z - size.width / 2, y: center.y * z - size.height / 2)
        let apply = {
            self.canvasView.zoomScale = z
            self.canvasView.contentOffset = self.clamp(offset, zoom: z, size: size)
        }
        if animated {
            UIView.animate(withDuration: 0.35, delay: 0, options: [.curveEaseInOut, .allowUserInteraction], animations: apply) { _ in
                self.syncViewport()
            }
        } else {
            apply()
        }
        syncViewport()
    }

    /// Fits a Space rectangle in the view, with a margin.
    public func show(rect: CGRect, animated: Bool, margin: CGFloat = 60, maxZoom: CGFloat = 2) {
        guard !rect.isNull, rect.width > 0 || rect.height > 0 else { return }
        let size = canvasView.bounds.size == .zero ? UIScreen.main.bounds.size : canvasView.bounds.size
        let z = min((size.width - margin * 2) / max(rect.width, 1), (size.height - margin * 2 - 120) / max(rect.height, 1), maxZoom)
        show(center: CGPoint(x: rect.midX, y: rect.midY), zoom: z, animated: animated)
    }

    /// Zooms around the middle of the view.
    public func setZoom(_ zoom: CGFloat, animated: Bool) {
        let r = visibleRect
        show(center: CGPoint(x: r.midX, y: r.midY), zoom: zoom, animated: animated)
    }

    static let edgeInset = UIEdgeInsets(top: 110, left: 40, bottom: 0, right: 0)

    private func clamp(_ offset: CGPoint, zoom: CGFloat, size: CGSize) -> CGPoint {
        CGPoint(x: min(max(offset.x, -Self.edgeInset.left), Self.spaceSize.width * zoom - size.width),
                y: min(max(offset.y, -Self.edgeInset.top), Self.spaceSize.height * zoom - size.height))
    }

    private func syncViewport() {
        contentOffset = canvasView.contentOffset
        zoomScale = canvasView.zoomScale
        viewSize = canvasView.bounds.size
    }

    /// Called when the canvas's size changes (rotation, Split View).
    public func layoutChanged() {
        if canvasView.bounds.size != viewSize { syncViewport() }
    }

    #if DEBUG
    /// Draws one pen stroke through `screen` points, as if the person drew it:
    /// the change goes through the same delegate path as a real stroke. For
    /// driving the Simulator, whose automation has no freeform path gesture.
    public func debugDraw(screen: [CGPoint]) {
        let zoom = canvasView.zoomScale, offset = canvasView.contentOffset
        let points = screen.enumerated().map { i, p in
            PKStrokePoint(
                location: CGPoint(x: (p.x + offset.x) / zoom, y: (p.y + offset.y) / zoom),
                timeOffset: Double(i) * 0.012, size: CGSize(width: 3, height: 3),
                opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2
            )
        }
        let stroke = PKStroke(ink: currentInk, path: PKStrokePath(controlPoints: points, creationDate: Date()))
        var drawing = canvasView.drawing
        drawing.strokes.append(stroke)
        canvasView.drawing = drawing
    }
    #endif

    // MARK: Moving strokes with a Reflex selection

    /// Indexes of strokes mostly inside a closed Space path.
    public func strokeIndexes(inside path: CGPath) -> [Int] {
        canvasView.drawing.strokes.enumerated().compactMap { i, stroke in
            let pts = stroke.path.interpolatedPoints(by: .distance(8)).map { $0.location.applying(stroke.transform) }
            guard !pts.isEmpty else { return nil }
            let inside = pts.filter { path.contains($0) }.count
            return Double(inside) / Double(pts.count) >= 0.6 ? i : nil
        }
    }

    /// The Reflex IDs of strokes at these indexes.
    public func strokeIDs(_ indexes: [Int]) -> [String] {
        indexes.compactMap { $0 < ledger.records.count ? ledger.records[$0].id : nil }
    }

    /// Indexes for these IDs, in drawing order.
    public func strokeIndexes(_ ids: Set<String>) -> [Int] {
        ledger.records.enumerated().compactMap { ids.contains($0.element.id) ? $0.offset : nil }
    }

    /// Bounds of these strokes, in Space points.
    public func bounds(ofStrokes ids: Set<String>) -> CGRect {
        let idx = Set(strokeIndexes(ids))
        return canvasView.drawing.strokes.enumerated().reduce(CGRect.null) { r, e in
            idx.contains(e.offset) ? r.union(e.element.renderBounds) : r
        }
    }

    /// Starts a move or edit of strokes that finishes with `endLiveEdit`: one history step.
    public func beginLiveEdit() {
        flush()
        liveEdit = true
    }

    /// Applies a transform to the strokes with these IDs, live.
    public func transformStrokes(_ ids: Set<String>, by t: CGAffineTransform) {
        let idx = Set(strokeIndexes(ids))
        var drawing = canvasView.drawing
        for i in idx { drawing.strokes[i].transform = drawing.strokes[i].transform.concatenating(t) }
        canvasView.drawing = drawing
    }

    public func endLiveEdit() {
        liveEdit = false
        drawingChanged()
    }

    /// Removes strokes by ID (Delete on a selection).
    public func removeStrokes(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }
        let idx = Set(strokeIndexes(ids))
        var drawing = canvasView.drawing
        drawing.strokes = drawing.strokes.enumerated().filter { !idx.contains($0.offset) }.map(\.element)
        canvasView.drawing = drawing
        if usingTool || liveEdit { return }
        drawingChanged()
    }

    /// Copies strokes by ID, moved by an offset; returns the copies' IDs.
    @discardableResult
    public func duplicateStrokes(_ ids: Set<String>, offset: CGPoint) -> [String] {
        let idx = strokeIndexes(ids)
        guard !idx.isEmpty else { return [] }
        var drawing = canvasView.drawing
        let copies = idx.map { i -> PKStroke in
            var s = drawing.strokes[i]
            // A new creation date makes it a new stroke, not a restore of the original.
            s.path = PKStrokePath(controlPoints: Array(s.path), creationDate: Date())
            s.transform = s.transform.concatenating(CGAffineTransform(translationX: offset.x, y: offset.y))
            return s
        }
        drawing.strokes.append(contentsOf: copies)
        canvasView.drawing = drawing
        drawingChanged()
        return Array(ledger.records.suffix(copies.count).map(\.id))
    }

    /// Recolors strokes by ID.
    public func recolorStrokes(_ ids: Set<String>, color: UIColor) {
        let idx = Set(strokeIndexes(ids))
        guard !idx.isEmpty else { return }
        var drawing = canvasView.drawing
        for i in idx { drawing.strokes[i].ink = PKInk(drawing.strokes[i].ink.inkType, color: color) }
        canvasView.drawing = drawing
        drawingChanged()
    }

    // MARK: Strokes, for recognition hints

    /// The native strokes with these IDs, in drawing order.
    public func pkStrokes(_ ids: [String]) -> [(id: String, stroke: PKStroke)] {
        let want = Set(ids)
        return zip(ledger.records, canvasView.drawing.strokes).filter { want.contains($0.0.id) }.map { ($0.0.id, $0.1) }
    }

    // MARK: Send

    /// A Send snapshots these IDs; claiming happens only after its outbox write succeeds.
    public func pendingStrokes() -> [String] {
        flush()
        let live = Set(ledger.records.map(\.id))
        return unsent.filter(live.contains)
    }

    public func claim(_ ids: [String]) {
        let claimed = Set(ids)
        unsent.removeAll { claimed.contains($0) }
        save(canvasView.drawing)
    }

    public func portableStrokes(_ ids: [String]) -> [PortableStroke] {
        let wanted = Set(ids)
        return zip(ledger.records, canvasView.drawing.strokes).filter { wanted.contains($0.0.id) }
            .map { PortableStroke(record: $0.0, stroke: $0.1) }
    }

    /// Process finished edits only; PencilKit owns the live drawing path.
    public func flush() { if !liveEdit { drawingChanged() } }

    /// Used before moving pages to another local folder during re-pairing.
    public static func finishSaving() { InkStore.finishSaving() }

    // MARK: Identity and saving

    private func drawingChanged(record: Bool = true) {
        let drawing = canvasView.drawing
        let change = ledger.reconcile(drawing.strokes)
        guard !change.isEmpty else { return }
        inkLog.debug("""
            Ink change: +\(change.added.map(\.id), privacy: .public) \
            -\(change.removed, privacy: .public) \
            restored \(change.restored, privacy: .public) moved \(change.moved, privacy: .public)
            """)
        let removed = Set(change.removed)
        unsent.removeAll(where: removed.contains)
        for id in change.added.map(\.id) + change.restored + change.moved where !unsent.contains(id) {
            unsent.append(id)
        }
        let before = lastDrawing
        lastDrawing = drawing
        publishStrokes()
        save(drawing)
        if record { onFinishedChange?(before) }
    }

    private func save(_ drawing: PKDrawing) {
        var portable: [PortableStroke] = []
        var cache: [String: PortableStroke] = [:]
        for (record, stroke) in zip(ledger.records, drawing.strokes) {
            var item = portableCache[record.id]
            let t = stroke.transform
            let transform = [t.a, t.b, t.c, t.d, t.tx, t.ty].map(Double.init)
            if item == nil || item?.transform != transform || item?.color != stroke.ink.color.reflexHex {
                item = PortableStroke(record: record, stroke: stroke)
            }
            portable.append(item!)
            cache[record.id] = item!
        }
        portableCache = cache
        store.save(drawing, portable: portable, retired: Array(ledger.retired.values), unsent: unsent)
    }

    private func publishStrokes() {
        strokes = zip(ledger.records, canvasView.drawing.strokes).map { record, stroke in
            InkStrokeInfo(id: record.id, parent: record.parent, bounds: stroke.renderBounds)
        }
    }
}

extension InkCanvasController: PKCanvasViewDelegate {
    public func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        // PencilKit can call this repeatedly during a stroke. Reconcile on tool-up.
        if !usingTool && !restoring && !liveEdit { drawingChanged() }
    }

    public func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) { usingTool = true }

    public func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        usingTool = false
        drawingChanged()
    }

    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        syncViewport()
    }

    public func scrollViewDidZoom(_ scrollView: UIScrollView) {
        syncViewport()
    }
}

extension InkCanvasController: PKToolPickerObserver {
    public func toolPickerSelectedToolItemDidChange(_ toolPicker: PKToolPicker) { applyPolicy() }

    public func toolPickerVisibilityDidChange(_ toolPicker: PKToolPicker) {
        if pickerVisible != toolPicker.isVisible {
            pickerVisible = toolPicker.isVisible
            applyPolicy()
        }
        refreshObscured()
    }

    public func toolPickerFramesObscuredDidChange(_ toolPicker: PKToolPicker) {
        refreshObscured()
    }
}

/// The PencilKit canvas as a SwiftUI view.
public struct InkCanvas: UIViewRepresentable {
    let controller: InkCanvasController

    public init(controller: InkCanvasController) {
        self.controller = controller
    }

    public func makeUIView(context: Context) -> PKCanvasView { controller.canvasView }
    public func updateUIView(_ uiView: PKCanvasView, context: Context) {}
}
