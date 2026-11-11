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

/// One finished change to the person's Ink, as the kernel takes it
/// (`apply_user_intent`). Coordinates are Space points.
public enum InkIntent: Sendable {
    case add(PortableStroke)
    /// Whole strokes removed by the stroke eraser, or deleted with the lasso.
    case erase([String])
    /// A precise erase cut `target`; `fragments` are what is left of it, each with its own ID.
    case cut(target: String, fragments: [PortableStroke])
    /// A lasso move.
    case move([String], dx: Int, dy: Int)
}

/// What one drawing change did: new actions, or an undo or redo of one.
public enum InkEdit: Sendable {
    case action([InkIntent])
    case undo
    case redo
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

    /// Called for every finished change to the Ink, so it can be committed to the Space.
    @ObservationIgnored public var onEdit: ((InkEdit) -> Void)?

    /// Size of the scrollable Space, in points.
    public static let spaceSize = CGSize(width: 6000, height: 6000)

    @ObservationIgnored private let store: InkStore
    @ObservationIgnored private var ledger: StrokeLedger
    @ObservationIgnored private var portableCache: [String: PortableStroke] = [:]
    @ObservationIgnored private var lastEraser: InkTool = .strokeEraser
    @ObservationIgnored private var toolBeforeEraser: InkTool = .pen
    @ObservationIgnored private var undoObservers: [NSObjectProtocol] = []
    @ObservationIgnored private var undoGestures: [UITapGestureRecognizer] = []
    /// Set while an undo or redo replays, so the drawing change it causes is reported as that.
    @ObservationIgnored private var replaying: InkEdit?

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
        guard undoManager?.canUndo == true else { return }
        replaying = .undo
        undoManager?.undo()
        replaying = nil
        refreshUndo()
    }

    public func redo() {
        guard undoManager?.canRedo == true else { return }
        replaying = .redo
        undoManager?.redo()
        replaying = nil
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

    // MARK: Send

    /// Hands over the strokes added since the last Send and starts a new batch.
    /// The kernel claims the same strokes when the Send is frozen; these say
    /// which part of the screen to crop.
    public func takeUnsent() -> [String] {
        let live = Set(ledger.records.map(\.id))
        let taken = unsent.filter(live.contains)
        unsent = []
        return taken
    }

    // MARK: Identity and saving

    private func drawingChanged() {
        let drawing = canvasView.drawing
        let before = portableCache
        let change = ledger.reconcile(drawing.strokes)
        refreshUndo()
        guard !change.isEmpty else { return }
        report(change, drawing: drawing, before: before)
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

    /// Turns one drawing change into the intents the kernel takes.
    private func report(_ change: InkChange, drawing: PKDrawing, before: [String: PortableStroke]) {
        guard let onEdit else { return }
        if let replaying {
            onEdit(replaying)
            return
        }
        var stroke: [String: (StrokeRecord, PKStroke)] = [:]
        for (record, s) in zip(ledger.records, drawing.strokes) { stroke[record.id] = (record, s) }
        let removed = Set(change.removed)
        var intents: [InkIntent] = []
        var fragments: [String: [PortableStroke]] = [:]
        for record in change.added {
            guard let (r, s) = stroke[record.id] else { continue }
            if let parent = r.parent, removed.contains(parent) {
                fragments[parent, default: []].append(PortableStroke(record: r, stroke: s))
            } else {
                intents.append(.add(PortableStroke(record: r, stroke: s)))
            }
        }
        for target in change.removed where fragments[target] != nil {
            intents.append(.cut(target: target, fragments: fragments[target]!))
        }
        let erased = change.removed.filter { fragments[$0] == nil }
        if !erased.isEmpty { intents.append(.erase(erased)) }
        // A lasso move shifts every selected stroke by the same amount; group them by it.
        var moves: [[Int]: [String]] = [:]
        for id in change.moved {
            guard let old = before[id]?.bounds, let (_, s) = stroke[id] else { continue }
            let b = s.renderBounds
            let delta = [Int((b.minX - old[0]).rounded()), Int((b.minY - old[1]).rounded())]
            if delta != [0, 0] { moves[delta, default: []].append(id) }
        }
        for (delta, ids) in moves { intents.append(.move(ids, dx: delta[0], dy: delta[1])) }
        if !intents.isEmpty { onEdit(.action(intents)) }
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
