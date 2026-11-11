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
    public let canvasView = PKCanvasView()

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
        undoManager?.undo()
        refreshUndo()
    }

    public func redo() {
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

    // MARK: Send

    /// Hands over the strokes added since the last Send and starts a new batch.
    /// Freezing a real Send in the kernel comes with the round-trip ticket.
    public func takeUnsent() -> [String] {
        let live = Set(ledger.records.map(\.id))
        let taken = unsent.filter(live.contains)
        unsent = []
        return taken
    }

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
        for id in change.added.map(\.id) + change.restored where !unsent.contains(id) {
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
        store.save(drawing, portable: portable, retired: Array(ledger.retired.values))
    }

    private func publishStrokes() {
        strokes = zip(ledger.records, canvasView.drawing.strokes).map { record, stroke in
            InkStrokeInfo(id: record.id, parent: record.parent, bounds: stroke.renderBounds)
        }
    }
}

extension InkCanvasController: PKCanvasViewDelegate {
    public func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
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
