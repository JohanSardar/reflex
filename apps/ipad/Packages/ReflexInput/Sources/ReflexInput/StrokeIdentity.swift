import Foundation
import PencilKit

/// Reflex's identity for one stroke on the user's Ink layer.
///
/// The iPadOS 26 SDK has no stable stroke IDs (they arrive with the WWDC26
/// PencilKit APIs in iPadOS 27), so Reflex keeps its own and never identifies a
/// stroke by its index in the drawing. A fragment left by a precise erase gets a
/// new ID whose `parent` is the stroke it was cut from.
public struct StrokeRecord: Codable, Hashable, Sendable {
    public var id: String
    public var parent: String?

    public init(id: String, parent: String? = nil) {
        self.id = id
        self.parent = parent
    }

    static func newID() -> String {
        let hex = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        return "ink_" + hex.prefix(12)
    }
}

/// Keys that PencilKit keeps stable for a stroke, from most to least specific.
struct StrokeKeys: Hashable {
    /// Same for a stroke and every fragment cut from it: its path's creation
    /// date and random seed.
    let origin: String
    /// `origin` plus the visible part of the path. Changes when an erase cuts it.
    let shape: String
    /// `shape` plus transform and ink. Changes when the stroke is moved or recolored.
    let full: String
    /// The parametric ranges of the path still visible.
    let visible: [ClosedRange<CGFloat>]

    init(_ stroke: PKStroke) {
        visible = stroke.maskedPathRanges
        let date = stroke.path.creationDate.timeIntervalSinceReferenceDate.bitPattern
        origin = "\(date):\(stroke.randomSeed)"

        var shape = "\(origin)|\(stroke.path.count)"
        if let first = stroke.path.first {
            shape += "|\(first.location.x.bitPattern):\(first.location.y.bitPattern)"
        }
        for range in visible {
            shape += "|\(range.lowerBound.bitPattern)-\(range.upperBound.bitPattern)"
        }
        if let mask = stroke.mask {
            let b = mask.bounds
            shape += "|m\(b.minX.bitPattern):\(b.minY.bitPattern):\(b.width.bitPattern):\(b.height.bitPattern)"
        }
        self.shape = shape

        let t = stroke.transform
        let transform = [t.a, t.b, t.c, t.d, t.tx, t.ty].map { String($0.bitPattern) }.joined(separator: ":")
        full = "\(shape)|\(transform)|\(stroke.ink.inkType.rawValue)|\(stroke.ink.color.reflexHex)"
    }
}

/// What changed on the Ink layer in one PencilKit drawing update.
public struct InkChange: Sendable, Equatable {
    public var added: [StrokeRecord] = []
    public var removed: [String] = []
    /// IDs that came back, by undo or redo.
    public var restored: [String] = []
    /// IDs whose stroke moved or changed ink, by lasso.
    public var moved: [String] = []

    public var isEmpty: Bool { added.isEmpty && removed.isEmpty && restored.isEmpty && moved.isEmpty }
}

/// Matches each new PencilKit drawing against the last one and hands every
/// stroke its Reflex ID.
///
/// Rules, in order:
/// 1. An unchanged stroke keeps its ID.
/// 2. A stroke that matches one removed earlier (undo or redo) gets that ID back.
/// 3. A stroke that kept its geometry but changed transform or ink (lasso move,
///    recolor) keeps its ID.
/// 4. A stroke that shares its origin with a stroke that just disappeared is a
///    fragment of it: a new ID, with that stroke as its parent. When several
///    pieces of one stroke disappear at once, the parent is the piece whose
///    visible path covers the fragment.
/// 5. Anything else is a new stroke.
struct StrokeLedger {
    private(set) var records: [StrokeRecord] = []
    private var keys: [StrokeKeys] = []
    /// Strokes no longer in the drawing, kept so undo and redo can restore their IDs.
    private var retiredByFull: [String: StrokeRecord] = [:]
    private var retiredByShape: [String: StrokeRecord] = [:]
    /// Lineage of every stroke ever removed, so a fragment's parent can be looked up.
    private(set) var retired: [String: StrokeRecord] = [:]

    init() {}

    /// Starts from a saved drawing and one record per stroke, in the same order.
    init(strokes: [PKStroke], records saved: [StrokeRecord], retired: [StrokeRecord]) {
        keys = strokes.map(StrokeKeys.init)
        records = saved
        for record in retired { self.retired[record.id] = record }
    }

    mutating func reconcile(_ strokes: [PKStroke]) -> InkChange {
        let nextKeys = strokes.map(StrokeKeys.init)
        var result = [StrokeRecord?](repeating: nil, count: strokes.count)
        var used = Set<String>()
        var unusedPrevious = Set(records.indices)
        var change = InkChange()

        func take(_ index: Int, _ record: StrokeRecord) {
            result[index] = record
            used.insert(record.id)
        }

        // 1. Unchanged strokes.
        var previousByFull: [String: [Int]] = [:]
        for (i, key) in keys.enumerated() { previousByFull[key.full, default: []].append(i) }
        for (i, key) in nextKeys.enumerated() {
            guard var candidates = previousByFull[key.full], !candidates.isEmpty else { continue }
            let p = candidates.removeFirst()
            previousByFull[key.full] = candidates
            unusedPrevious.remove(p)
            take(i, records[p])
        }

        // 2. Restored by undo or redo.
        for (i, key) in nextKeys.enumerated() where result[i] == nil {
            if let record = retiredByFull[key.full], !used.contains(record.id) {
                take(i, record)
                change.restored.append(record.id)
            }
        }

        // 3. Moved or recolored.
        for (i, key) in nextKeys.enumerated() where result[i] == nil {
            if let p = unusedPrevious.sorted().first(where: { keys[$0].shape == key.shape }) {
                unusedPrevious.remove(p)
                take(i, records[p])
                change.moved.append(records[p].id)
            } else if let record = retiredByShape[key.shape], !used.contains(record.id) {
                take(i, record)
                change.restored.append(record.id)
            }
        }

        // 4 and 5. Fragments of a stroke that just disappeared, then new strokes.
        let disappeared = unusedPrevious.sorted()
        for (i, key) in nextKeys.enumerated() where result[i] == nil {
            let parent = parentIndex(of: key, among: disappeared).map { records[$0].id }
            let record = StrokeRecord(id: StrokeRecord.newID(), parent: parent)
            take(i, record)
            change.added.append(record)
        }

        for p in disappeared where !used.contains(records[p].id) {
            let record = records[p]
            retiredByFull[keys[p].full] = record
            retiredByShape[keys[p].shape] = record
            retired[record.id] = record
            change.removed.append(record.id)
        }
        for id in change.restored { retired[id] = nil }

        records = result.map { $0! }
        keys = nextKeys
        return change
    }
}

extension StrokeLedger {
    /// The stroke a fragment was cut from: among the strokes that just
    /// disappeared with the same origin, the one with the least visible path
    /// that still covers the fragment. Falls back to any with the same origin.
    fileprivate func parentIndex(of fragment: StrokeKeys, among disappeared: [Int]) -> Int? {
        let sameOrigin = disappeared.filter { keys[$0].origin == fragment.origin }
        func covers(_ index: Int) -> Bool {
            fragment.visible.allSatisfy { piece in
                keys[index].visible.contains { $0.lowerBound <= piece.lowerBound && piece.upperBound <= $0.upperBound }
            }
        }
        func length(_ index: Int) -> CGFloat {
            keys[index].visible.reduce(0) { $0 + $1.upperBound - $1.lowerBound }
        }
        return sameOrigin.filter(covers).min { length($0) < length($1) } ?? sameOrigin.first
    }
}

extension UIColor {
    var reflexHex: String {
        var r: CGFloat = 0
        var g: CGFloat = 0
        var b: CGFloat = 0
        var a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        func byte(_ v: CGFloat) -> Int { Int((min(max(v, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x%02x", byte(r), byte(g), byte(b), byte(a))
    }
}
