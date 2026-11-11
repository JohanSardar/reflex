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

/// What a finger on an Element can do to it.
public enum ElementTouch: Sendable {
    case tap
    case longPress
    case drag
}

/// A finger gesture on an Element that is a surface of its own (a 3D Embed): one finger turns
/// it, two slide it, a pinch zooms, and a long press grabs what is under the finger. `start` is
/// where the gesture began, in Space points; `at` is where the finger is now, in Space points;
/// `by` is the movement since the last report, in screen points.
public enum SurfaceGesture: Sendable {
    public enum Phase: Sendable { case began, changed, ended, cancelled }
    case orbit(start: CGPoint, by: CGSize)
    case slide(start: CGPoint, by: CGSize)
    case zoom(start: CGPoint, scale: CGFloat)
    case hold(start: CGPoint, at: CGPoint, phase: Phase)
    /// Every finger lifted.
    case ended(start: CGPoint)
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

extension SurfaceGesture {
    /// The same gesture with its points (`start`, `at`) mapped, say from content to Space coordinates.
    func mapped(_ f: (CGPoint) -> CGPoint) -> SurfaceGesture {
        switch self {
        case .orbit(let s, let by): .orbit(start: f(s), by: by)
        case .slide(let s, let by): .slide(start: f(s), by: by)
        case .zoom(let s, let k): .zoom(start: f(s), scale: k)
        case .hold(let s, let at, let ph): .hold(start: f(s), at: f(at), phase: ph)
        case .ended(let s): .ended(start: f(s))
        }
    }
}

/// The PencilKit canvas. A finger that lands on an Element that takes touch
/// (a tap or long-press Behavior, or a draggable Element) belongs to that
/// Element: drawing and scrolling are off until it lifts.
final class ReflexCanvasView: PKCanvasView {
    /// Whether the touch at this point (in the canvas's content coordinates) is the Element's, not the canvas's.
    var claims: ((CGPoint) -> Bool)?
    /// Whether a pen stroke starting at this point (content coordinates) is refused, as in a Region with `ink: false`.
    var refuses: ((CGPoint) -> Bool)?
    /// Where a touch or the hovering Pencil is now (content coordinates), or nil once it left.
    var moved: ((CGPoint?) -> Void)?
    /// Whether a finger at this point (content coordinates) is on a surface Element (a 3D Embed), which takes every finger gesture.
    var surface: ((CGPoint) -> Bool)?
    /// The finger gestures on a surface, with points in content coordinates.
    var onSurface: ((SurfaceGesture) -> Void)?
}

/// Watches every touch on the canvas without recognizing anything. When a
/// finger lands on an Element that takes touch, it turns the canvas's drawing
/// and scrolling off for that touch, so the Element's gestures get it.
///
/// A finger that lands on a surface (a 3D Embed) is read here, from the touches themselves:
/// one finger turns the view, two slide and pinch it, and a finger held still grabs what is
/// under it. Recognizers for these would compete with PencilKit's own, which on iOS 26 holds
/// back a pan's actions until the finger lifts.
final class TouchWatcher: UIGestureRecognizer {
    weak var canvas: ReflexCanvasView?
    private var held = false

    /// The surface gesture under way: its fingers, where it began (content coordinates) and the
    /// first finger's touch-down point and time on screen; the last center and spread of the
    /// fingers on screen; whether it has moved past a tap or a hold; and whether it is a hold.
    private var surfaceTouches: [UITouch] = []
    private var surfaceStart: CGPoint?
    private var surfaceDown: CGPoint = .zero
    private var surfaceLast: (center: CGPoint, spread: CGFloat) = (.zero, 0)
    private var surfaceMoved = false
    private var surfaceHolding = false
    private var holdTimer: Timer?
    static let holdDelay: TimeInterval = 0.35
    static let holdSlop: CGFloat = 12

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if let canvas, let t = touches.first { canvas.moved?(t.location(in: canvas)) }
        guard let canvas else { return }
        if surfaceStart != nil {
            // Another finger on a surface gesture: no hold now, and measure from the new center.
            surfaceTouches += touches.filter { $0.type == .direct }
            if !surfaceHolding { cancelHold() }
            surfaceLast = measure()
            return
        }
        guard let t = touches.first, !held else { return }
        if (event.allTouches?.count ?? 1) == 1, canvas.refuses?(t.location(in: canvas)) == true {
            held = true
            canvas.drawingGestureRecognizer.isEnabled = false
            return
        }
        if t.type == .direct, canvas.surface?(t.location(in: canvas)) == true {
            held = true
            canvas.drawingGestureRecognizer.isEnabled = false
            canvas.panGestureRecognizer.isEnabled = false
            canvas.pinchGestureRecognizer?.isEnabled = false
            surfaceTouches = touches.filter { $0.type == .direct }
            surfaceStart = t.location(in: canvas)
            surfaceDown = t.location(in: canvas.superview)
            surfaceMoved = false
            surfaceHolding = false
            surfaceLast = measure()
            if surfaceTouches.count == 1 {
                holdTimer = Timer.scheduledTimer(withTimeInterval: Self.holdDelay, repeats: false) { [weak self] _ in
                    MainActor.assumeIsolated { self?.beginHold() }
                }
            }
            return
        }
        if t.type == .direct, (event.allTouches?.count ?? 1) == 1, canvas.claims?(t.location(in: canvas)) == true {
            held = true
            canvas.drawingGestureRecognizer.isEnabled = false
            canvas.panGestureRecognizer.isEnabled = false
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if let canvas, let t = touches.first { canvas.moved?(t.location(in: canvas)) }
        guard let canvas, let start = surfaceStart, let first = surfaceTouches.first else { return }
        if surfaceHolding {
            canvas.onSurface?(.hold(start: start, at: first.location(in: canvas), phase: .changed))
            return
        }
        let now = measure()
        if !surfaceMoved {
            let p = first.location(in: canvas.superview)
            guard hypot(p.x - surfaceDown.x, p.y - surfaceDown.y) > Self.holdSlop || surfaceTouches.count > 1 else { return }
            surfaceMoved = true
            cancelHold()
            // A single finger turns from where it touched down, so no movement is lost.
            if surfaceTouches.count == 1 { surfaceLast.center = surfaceDown }
        }
        let by = CGSize(width: now.center.x - surfaceLast.center.x, height: now.center.y - surfaceLast.center.y)
        if surfaceTouches.count >= 2 {
            canvas.onSurface?(.slide(start: start, by: by))
            if surfaceLast.spread > 1, now.spread > 1 { canvas.onSurface?(.zoom(start: start, scale: now.spread / surfaceLast.spread)) }
        } else {
            canvas.onSurface?(.orbit(start: start, by: by))
        }
        surfaceLast = now
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { lift(touches, cancelled: false) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { lift(touches, cancelled: true) }

    private func lift(_ touches: Set<UITouch>, cancelled: Bool) {
        guard let canvas, let start = surfaceStart else { return release() }
        surfaceTouches.removeAll { touches.contains($0) }
        if !surfaceTouches.isEmpty {
            surfaceLast = measure()
            return
        }
        cancelHold()
        if surfaceHolding {
            let at = touches.first?.location(in: canvas) ?? start
            canvas.onSurface?(.hold(start: start, at: at, phase: cancelled ? .cancelled : .ended))
        }
        canvas.onSurface?(.ended(start: start))
        surfaceStart = nil
        surfaceHolding = false
        release()
    }

    private func beginHold() {
        holdTimer = nil
        guard let canvas, let start = surfaceStart, !surfaceMoved, surfaceTouches.count == 1, let t = surfaceTouches.first else { return }
        surfaceHolding = true
        canvas.onSurface?(.hold(start: start, at: t.location(in: canvas), phase: .began))
    }

    private func cancelHold() {
        holdTimer?.invalidate()
        holdTimer = nil
    }

    /// The center of the fingers on screen, and how far apart they are.
    private func measure() -> (center: CGPoint, spread: CGFloat) {
        let pts = surfaceTouches.map { $0.location(in: canvas?.superview) }
        guard !pts.isEmpty else { return (.zero, 0) }
        let c = CGPoint(x: pts.map(\.x).reduce(0, +) / CGFloat(pts.count), y: pts.map(\.y).reduce(0, +) / CGFloat(pts.count))
        let spread = pts.count < 2 ? 0 : pts.map { hypot($0.x - c.x, $0.y - c.y) }.reduce(0, +) / CGFloat(pts.count)
        return (c, spread)
    }

    private func release() {
        if held, let canvas {
            canvas.drawingGestureRecognizer.isEnabled = true
            canvas.panGestureRecognizer.isEnabled = true
            canvas.pinchGestureRecognizer?.isEnabled = true
        }
        held = false
        state = .failed
    }

    override func reset() {
        if surfaceStart != nil, let canvas, let start = surfaceStart {
            cancelHold()
            if surfaceHolding { canvas.onSurface?(.hold(start: start, at: start, phase: .cancelled)) }
            canvas.onSurface?(.ended(start: start))
            surfaceStart = nil
            surfaceHolding = false
            surfaceTouches = []
        }
        if held { release() }
        super.reset()
    }
}

/// Owns the PencilKit canvas for one Space: tools, the Goodnotes-style eraser
/// and undo, stroke identity and saving.
@MainActor @Observable
public final class InkCanvasController: NSObject {
    public let canvasView: PKCanvasView = ReflexCanvasView()

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
    /// Whether an Element at this Space point takes this kind of finger touch (a tap, a long-press or a drag).
    @ObservationIgnored public var claimsTouch: ((ElementTouch, CGPoint) -> Bool)?
    /// A finger tap or long-press on an Element that claims touch, at a Space point.
    @ObservationIgnored public var onTap: ((CGPoint) -> Void)?
    @ObservationIgnored public var onLongPress: ((CGPoint) -> Void)?
    /// A finger drag that started on an Element that claims touch: where it
    /// started, how far it went (Space points), and whether it ended.
    @ObservationIgnored public var onDrag: ((CGPoint, CGSize, Bool) -> Void)?
    /// The pen went down (true) or lifted (false): a live signal that the person is writing.
    @ObservationIgnored public var onPen: ((Bool) -> Void)?
    /// Whether a pen stroke may not start at this Space point (a Region with `ink: false`); `onRefused` is told when one is stopped.
    @ObservationIgnored public var refusesInk: ((CGPoint) -> Bool)?
    @ObservationIgnored public var onRefused: (() -> Void)?
    /// Nothing may be drawn or erased (the person is a viewer in this shared Space); `onRefused` is told when someone tries.
    @ObservationIgnored public var readOnly = false
    /// Where the pen or finger is, in Space points, as it moves (nil once it leaves), for other people's screens.
    @ObservationIgnored public var onCursor: ((CGPoint?) -> Void)?
    /// Whether a finger at this Space point is on a surface Element (a 3D Embed); its gestures go to `onSurface`, not the canvas.
    @ObservationIgnored public var surfaceAt: ((CGPoint) -> Bool)?
    @ObservationIgnored public var onSurface: ((SurfaceGesture) -> Void)?

    /// Size of the scrollable Space, in points.
    public static let spaceSize = CGSize(width: 6000, height: 6000)
    /// Scroll room before the Space's origin, in points.
    static let margin = CGSize(width: 40, height: 140)

    @ObservationIgnored private let store: InkStore
    @ObservationIgnored private var ledger: StrokeLedger
    @ObservationIgnored private var portableCache: [String: PortableStroke] = [:]
    @ObservationIgnored private var lastEraser: InkTool = .strokeEraser
    @ObservationIgnored private var toolBeforeEraser: InkTool = .pen
    @ObservationIgnored private var undoObservers: [NSObjectProtocol] = []
    @ObservationIgnored private var undoGestures: [UITapGestureRecognizer] = []
    /// Set while an undo or redo replays, so the drawing change it causes is reported as that.
    @ObservationIgnored private var replaying: InkEdit?
    /// Set while strokes the kernel refused are taken back off the canvas, so that isn't reported as an erase.
    @ObservationIgnored private var withdrawing = false

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
        // Room above and left of the Space's origin, so what Agents place at (0, 0) isn't under the toolbar.
        canvasView.contentInset = UIEdgeInsets(top: Self.margin.height, left: Self.margin.width, bottom: 0, right: 0)
        canvasView.contentOffset = CGPoint(x: -Self.margin.width, y: -Self.margin.height)
        contentOffset = canvasView.contentOffset
        canvasView.showsVerticalScrollIndicator = false
        canvasView.showsHorizontalScrollIndicator = false
        canvasView.accessibilityIdentifier = "ink-canvas"
        canvasView.accessibilityLabel = "Ink canvas"

        addUndoGestures()
        addElementGestures()
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

    /// Puts an action that isn't Ink (an import, a drag, a revert) on the same
    /// undo stack as the Ink, so undo and redo go back through them in order.
    public func recordAction(undo: @escaping @MainActor () -> Void, redo: @escaping @MainActor () -> Void) {
        undoManager?.registerUndo(withTarget: self) { me in
            MainActor.assumeIsolated {
                undo()
                me.recordAction(undo: redo, redo: undo)
            }
        }
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

    // MARK: Touching Elements

    private func addElementGestures() {
        guard let canvas = canvasView as? ReflexCanvasView else { return }
        canvas.claims = { [weak self] screen in
            guard let self else { return false }
            return MainActor.assumeIsolated {
                let p = self.spacePoint(screen)
                return [ElementTouch.tap, .longPress, .drag].contains { self.claimsTouch?($0, p) == true }
            }
        }
        canvas.moved = { [weak self] screen in
            guard let self else { return }
            MainActor.assumeIsolated { self.onCursor?(screen.map { self.spacePoint($0) }) }
        }
        let hover = UIHoverGestureRecognizer(target: self, action: #selector(hovered(_:)))
        canvas.addGestureRecognizer(hover)
        canvas.surface = { [weak self] screen in
            guard let self else { return false }
            return MainActor.assumeIsolated { self.surfaceAt?(self.spacePoint(screen)) == true }
        }
        canvas.onSurface = { [weak self] g in
            guard let self else { return }
            MainActor.assumeIsolated { self.onSurface?(g.mapped(self.spacePoint)) }
        }
        canvas.refuses = { [weak self] screen in
            guard let self else { return false }
            return MainActor.assumeIsolated {
                if self.readOnly {
                    self.onRefused?()
                    return true
                }
                guard !self.tool.isEraser, self.tool != .lasso, self.refusesInk?(self.spacePoint(screen)) == true else { return false }
                self.onRefused?()
                return true
            }
        }
        let watcher = TouchWatcher(target: nil, action: nil)
        watcher.canvas = canvas
        watcher.cancelsTouchesInView = false
        watcher.delaysTouchesEnded = false
        watcher.delegate = watcherDelegate
        canvas.addGestureRecognizer(watcher)
        let tap = UITapGestureRecognizer(target: self, action: #selector(elementTap(_:)))
        let long = UILongPressGestureRecognizer(target: self, action: #selector(elementLongPress(_:)))
        let pan = UIPanGestureRecognizer(target: self, action: #selector(elementPan(_:)))
        elementGestures = [ObjectIdentifier(tap): .tap, ObjectIdentifier(long): .longPress, ObjectIdentifier(pan): .drag]
        pan.maximumNumberOfTouches = 1
        for g in [tap, long, pan] as [UIGestureRecognizer] {
            g.allowedTouchTypes = [UITouch.TouchType.direct.rawValue as NSNumber]
            g.delegate = self
            canvas.addGestureRecognizer(g)
        }
    }

    private func spacePoint(_ screen: CGPoint) -> CGPoint {
        // `location(in: canvasView)` is in content coordinates, which already include the scroll offset.
        CGPoint(x: screen.x / canvasView.zoomScale, y: screen.y / canvasView.zoomScale)
    }

    /// The Pencil hovering over the canvas moves the cursor too.
    @objc private func hovered(_ g: UIHoverGestureRecognizer) {
        switch g.state {
        case .began, .changed: onCursor?(spacePoint(g.location(in: canvasView)))
        case .ended, .cancelled: onCursor?(nil)
        default: break
        }
    }

    @objc private func elementTap(_ g: UITapGestureRecognizer) {
        onTap?(spacePoint(g.location(in: canvasView)))
    }

    @objc private func elementLongPress(_ g: UILongPressGestureRecognizer) {
        if g.state == .began { onLongPress?(spacePoint(g.location(in: canvasView))) }
    }

    /// Where the finger that may drag an Element first touched, in Space points.
    @ObservationIgnored private var touchDown: CGPoint?
    @ObservationIgnored private var elementGestures: [ObjectIdentifier: ElementTouch] = [:]
    @ObservationIgnored private let watcherDelegate = Simultaneous()

    @objc private func elementPan(_ g: UIPanGestureRecognizer) {
        // Measured from where the finger first touched (`touchDown`), so the whole
        // movement counts, including the part before the pan was recognized.
        let here = spacePoint(g.location(in: canvasView))
        let start = touchDown ?? here
        let by = CGSize(width: here.x - start.x, height: here.y - start.y)
        switch g.state {
        case .began, .changed:
            onDrag?(start, by, false)
        case .ended:
            onDrag?(start, by, true)
            touchDown = nil
        case .cancelled, .failed:
            onDrag?(start, .zero, true)
            touchDown = nil
        default: break
        }
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

    // MARK: Refused Ink

    /// Takes strokes the Space refused (Ink in a Region with `ink: false`) back off
    /// the canvas. They never reached the kernel, so nothing is reported for them.
    public func withdraw(_ ids: [String]) {
        let drop = Set(ids)
        let keep = zip(ledger.records, canvasView.drawing.strokes).filter { !drop.contains($0.0.id) }.map(\.1)
        guard keep.count < canvasView.drawing.strokes.count else { return }
        withdrawing = true
        canvasView.drawing = PKDrawing(strokes: keep)
        withdrawing = false
    }

    #if DEBUG
    /// Draws one pen stroke through Space points, as the person would, with the pen
    /// going down and up around it.
    public func debugDraw(space points: [CGPoint]) {
        guard points.count >= 2 else { return }
        onPen?(true)
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
        onPen?(false)
    }

    /// Draws one pen stroke through `screen` points, as if the person drew it:
    /// the change goes through the same delegate path as a real stroke. For
    /// driving the Simulator, whose automation has no freeform path gesture.
    public func debugDraw(screen: [CGPoint]) {
        let zoom = canvasView.zoomScale, offset = canvasView.contentOffset
        // As a real touch would be: refused where the person may not draw, and the cursor follows it.
        guard let first = screen.first else { return }
        let start = CGPoint(x: (first.x + offset.x) / zoom, y: (first.y + offset.y) / zoom)
        if readOnly {
            onRefused?()
            return
        }
        onCursor?(start)
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
        if let last = points.last { onCursor?(last.location) }
    }
    #endif

    // MARK: Strokes, for recognition hints

    /// The native strokes with these IDs, in drawing order.
    public func pkStrokes(_ ids: [String]) -> [(id: String, stroke: PKStroke)] {
        let want = Set(ids)
        return zip(ledger.records, canvasView.drawing.strokes).filter { want.contains($0.0.id) }.map { ($0.0.id, $0.1) }
    }

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

    /// Hands over only the unsent strokes among `ids` (a Region's Send); the rest stay unsent.
    public func takeUnsent(among ids: Set<String>) -> [String] {
        let live = Set(ledger.records.map(\.id))
        let taken = unsent.filter { live.contains($0) && ids.contains($0) }
        unsent.removeAll { ids.contains($0) }
        return taken
    }

    // MARK: Identity and saving

    private func drawingChanged() {
        let drawing = canvasView.drawing
        let before = portableCache
        let change = ledger.reconcile(drawing.strokes)
        refreshUndo()
        guard !change.isEmpty else { return }
        if !withdrawing { report(change, drawing: drawing, before: before) }
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

    public func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
        onPen?(true)
    }

    public func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        onPen?(false)
    }

    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        contentOffset = scrollView.contentOffset
    }

    public func scrollViewDidZoom(_ scrollView: UIScrollView) {
        zoomScale = scrollView.zoomScale
        contentOffset = scrollView.contentOffset
    }
}

/// Lets the touch watcher see touches alongside every other recognizer.
final class Simultaneous: NSObject, UIGestureRecognizerDelegate {
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

extension InkCanvasController: UIGestureRecognizerDelegate {
    public nonisolated func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        false
    }

    /// The Element gestures take only a finger that starts on an Element that claims touch.
    public nonisolated func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        MainActor.assumeIsolated {
            guard touch.type == .direct, let kind = elementGestures[ObjectIdentifier(g)] else { return false }
            let p = spacePoint(touch.location(in: canvasView))
            let claimed = claimsTouch?(kind, p) == true
            if kind == .drag, claimed { touchDown = p }
            return claimed
        }
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
