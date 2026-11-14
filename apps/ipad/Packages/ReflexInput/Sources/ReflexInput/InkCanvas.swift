import Observation
import PencilKit
import SwiftUI
import UIKit

/// The tools on the Reflex toolbar.
public enum InkTool: String, CaseIterable, Sendable {
    case pen
    /// Removes whole strokes it touches.
    case strokeEraser
    /// Removes only the Ink under it, leaving fragments with their own IDs.
    case preciseEraser
    /// Selects strokes to move, delete or duplicate.
    case lasso

    public var isEraser: Bool { self == .strokeEraser || self == .preciseEraser }
}

/// A stroke on screen with its Reflex ID, for the stroke-ID overlay.
public struct InkStrokeInfo: Identifiable, Sendable {
    public var id: String
    public var parent: String?
    /// Rendered bounds in Space points.
    public var bounds: CGRect
}

/// Owns the PencilKit canvas for one Space: tools, the Goodnotes-style eraser
/// and undo, stroke identity and saving.
@MainActor @Observable
public final class InkCanvasController: NSObject {
    public let canvasView: PKCanvasView = PKCanvasView()

    public var tool: InkTool = .pen { didSet { applyTool() } }
    public var penColor: UIColor = .black { didSet { applyTool() } }
    public private(set) var canUndo = false
    public private(set) var canRedo = false
    /// Where the canvas is scrolled to and its zoom, so Elements drawn under the
    /// Ink can follow it.
    public private(set) var contentOffset: CGPoint = .zero
    public private(set) var zoomScale: CGFloat = 1
    public private(set) var strokes: [InkStrokeInfo] = []
    /// Strokes added since the last Send, by ID.
    public private(set) var unsent: [String] = []

    /// Size of the scrollable Space, in points.
    public static let spaceSize = CGSize(width: 6000, height: 6000)
    /// Scroll room before the Space's origin, in points.
    static let margin = CGSize(width: 40, height: 140)

    @ObservationIgnored private var usingTool = false
    @ObservationIgnored private let store: InkStore
    @ObservationIgnored private var ledger: StrokeLedger
    @ObservationIgnored private var portableCache: [String: PortableStroke] = [:]
    @ObservationIgnored private var lastEraser: InkTool = .strokeEraser
    @ObservationIgnored private var toolBeforeEraser: InkTool = .pen
    @ObservationIgnored private var undoObservers: [NSObjectProtocol] = []
    @ObservationIgnored private var undoGestures: [UITapGestureRecognizer] = []
    public init(space: String) {
        store = InkStore(space: space)
        let (drawing, ledger) = store.load()
        self.ledger = ledger
        unsent = store.loadUnsent(fallback: ledger.records.map(\.id))
        super.init()

        canvasView.drawing = drawing
        canvasView.delegate = self
        #if targetEnvironment(simulator)
        // The Simulator has no Pencil, and PencilKit treats its touches as
        // Pencil-only by default. On a device, the system's "Only Draw with
        // Apple Pencil" setting decides.
        canvasView.drawingPolicy = .anyInput
        #else
        canvasView.drawingPolicy = .default
        #endif
        canvasView.isOpaque = false
        canvasView.backgroundColor = .clear
        canvasView.contentSize = Self.spaceSize
        canvasView.minimumZoomScale = 0.25
        canvasView.maximumZoomScale = 4
        canvasView.contentInsetAdjustmentBehavior = .never
        // Room above and left of the Space's origin, so what Agents place at (0, 0) isn't under the toolbar.
        canvasView.contentInset = UIEdgeInsets(top: Self.margin.height, left: Self.margin.width, bottom: 0, right: 0)
        canvasView.contentOffset = CGPoint(x: -Self.margin.width, y: -Self.margin.height)
        contentOffset = canvasView.contentOffset
        canvasView.showsVerticalScrollIndicator = false
        canvasView.showsHorizontalScrollIndicator = false
        canvasView.accessibilityIdentifier = "ink-canvas"
        canvasView.accessibilityLabel = "Ink canvas"

        addUndoGestures()
        let pencil = UIPencilInteraction(delegate: self)
        canvasView.addInteraction(pencil)
        observeUndo()
        applyTool()
        publishStrokes()
    }

    // MARK: Tools

    private func applyTool() {
        switch tool {
        case .pen:
            canvasView.tool = PKInkingTool(.pen, color: penColor, width: 3)
        case .strokeEraser:
            canvasView.tool = PKEraserTool(.vector)
        case .preciseEraser:
            canvasView.tool = PKEraserTool(.bitmap, width: 16)
        case .lasso:
            canvasView.tool = PKLassoTool()
        }
        if tool.isEraser { lastEraser = tool }
    }

    /// Pencil double-tap or squeeze: to the last eraser, and back again.
    func toggleEraser() {
        if tool.isEraser {
            tool = toolBeforeEraser
        } else {
            toolBeforeEraser = tool
            tool = lastEraser
        }
    }

    // MARK: Undo

    private var undoManager: UndoManager? { canvasView.undoManager }

    public func undo() {
        guard undoManager?.canUndo == true else { return }
        undoManager?.undo()
        refreshUndo()
    }

    public func redo() {
        guard undoManager?.canRedo == true else { return }
        undoManager?.redo()
        refreshUndo()
    }

    private func addUndoGestures() {
        let threeFinger = UITapGestureRecognizer(target: self, action: #selector(threeFingerTap))
        threeFinger.numberOfTouchesRequired = 3
        let twoFinger = UITapGestureRecognizer(target: self, action: #selector(twoFingerTap))
        twoFinger.numberOfTouchesRequired = 2
        twoFinger.require(toFail: threeFinger)
        for gesture in [twoFinger, threeFinger] {
            gesture.allowedTouchTypes = [UITouch.TouchType.direct.rawValue as NSNumber]
            canvasView.addGestureRecognizer(gesture)
        }
        undoGestures = [twoFinger, threeFinger]
    }

    @objc private func twoFingerTap() { undo() }
    @objc private func threeFingerTap() { redo() }

    private func observeUndo() {
        let names: [Notification.Name] = [
            .NSUndoManagerDidCloseUndoGroup, .NSUndoManagerDidUndoChange,
            .NSUndoManagerDidRedoChange, .NSUndoManagerWillCloseUndoGroup,
        ]
        undoObservers = names.map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refreshUndo() }
            }
        }
    }

    private func refreshUndo() {
        canUndo = undoManager?.canUndo ?? false
        canRedo = undoManager?.canRedo ?? false
    }

    #if DEBUG
    /// Draws one pen stroke through Space points, as the person would, with the pen
    /// going down and up around it.
    public func debugDraw(space points: [CGPoint]) {
        guard points.count >= 2 else { return }
        let strokePoints = points.enumerated().map { i, p in
            PKStrokePoint(
                location: p, timeOffset: Double(i) * 0.008, size: CGSize(width: 2.4, height: 2.4),
                opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2
            )
        }
        let stroke = PKStroke(ink: PKInk(.pen, color: penColor), path: PKStrokePath(controlPoints: strokePoints, creationDate: Date()))
        var drawing = canvasView.drawing
        drawing.strokes.append(stroke)
        canvasView.drawing = drawing
    }

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
        let stroke = PKStroke(ink: PKInk(.pen, color: penColor), path: PKStrokePath(controlPoints: points, creationDate: Date()))
        var drawing = canvasView.drawing
        drawing.strokes.append(stroke)
        canvasView.drawing = drawing
    }
    #endif

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
    public func flush() { drawingChanged() }

    /// Used before moving pages to another local folder during re-pairing.
    public static func finishSaving() { InkStore.finishSaving() }

    // MARK: Identity and saving

    private func drawingChanged() {
        let drawing = canvasView.drawing
        let change = ledger.reconcile(drawing.strokes)
        refreshUndo()
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
        publishStrokes()
        save(drawing)
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
        if !usingTool { drawingChanged() }
    }

    public func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) { usingTool = true }

    public func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        usingTool = false
        drawingChanged()
    }

    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        contentOffset = scrollView.contentOffset
    }

    public func scrollViewDidZoom(_ scrollView: UIScrollView) {
        zoomScale = scrollView.zoomScale
        contentOffset = scrollView.contentOffset
    }
}

extension InkCanvasController: UIPencilInteractionDelegate {
    public func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        switch UIPencilInteraction.preferredTapAction {
        case .switchEraser, .switchPrevious: toggleEraser()
        default: break
        }
    }

    public func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard squeeze.phase == .ended else { return }
        switch UIPencilInteraction.preferredSqueezeAction {
        case .ignore: break
        // Reflex has no contextual palette yet, so squeeze switches to the eraser.
        default: toggleEraser()
        }
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
