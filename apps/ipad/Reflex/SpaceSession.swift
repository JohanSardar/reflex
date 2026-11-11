import OSLog
import ReflexInput
import ReflexLink
import ReflexRender
import SwiftUI

private let log = Logger(subsystem: "si.eilmer.reflex", category: "space")

/// One open Space: its Ink canvas, its scene from the kernel, and the bridge
/// between the two. Every finished Ink change becomes a user intent in the
/// kernel, and undo and redo become the kernel's per-person undo.
@MainActor @Observable
final class SpaceSession {
    let id: String
    let ink: InkCanvasController
    private(set) var scene = SceneDocument(space: nil, elements: [])
    @ObservationIgnored private let link: LinkSync
    /// Kernel history entries made by each canvas action, so one canvas undo undoes all of them.
    @ObservationIgnored private var done: [Int] = []
    @ObservationIgnored private var undone: [Int] = []
    @ObservationIgnored private var seen = -1

    init(id: String, link: LinkSync) {
        self.id = id
        self.link = link
        ink = InkCanvasController(space: id)
        ink.onEdit = { [weak self] edit in self?.commit(edit) }
        refresh()
    }

    /// Reads the scene again when the Space changed, here or on the Link.
    func refresh() {
        let r = link.revision[id] ?? 0
        guard r != seen, let json = link.scene(id) else { return }
        seen = r
        do {
            scene = try SceneDocument.decode(json)
        } catch {
            log.error("Could not read the scene of \(self.id, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private func commit(_ edit: InkEdit) {
        switch edit {
        case .action(let intents):
            var entries = 0
            for intent in intents {
                if let r = link.intent(id, Self.json(intent)), r["entry"] is String { entries += 1 }
            }
            if entries > 0 {
                done.append(entries)
                undone = []
            }
        case .undo:
            guard let n = done.popLast() else { return }
            for _ in 0 ..< n { link.undo(id) }
            undone.append(n)
        case .redo:
            guard let n = undone.popLast() else { return }
            for _ in 0 ..< n { link.redo(id) }
            done.append(n)
        }
        refresh()
    }

    private static func stroke(_ s: PortableStroke) -> [String: Any] {
        let width = s.points.first.map { max(1, min(40, $0.width)) } ?? 3
        return ["id": s.id, "stroke": ["points": s.spacePoints], "tool": "pen", "color": s.namedColor, "width": width]
    }

    static func json(_ intent: InkIntent) -> [String: Any] {
        switch intent {
        case .add(let s):
            return stroke(s).merging(["intent": "add_stroke"]) { a, _ in a }
        case .erase(let ids):
            return ["intent": "erase", "ids": ids]
        case .cut(let target, let fragments):
            return ["intent": "erase_precise", "id": target, "fragments": fragments.map(stroke)]
        case .move(let ids, let dx, let dy):
            return ["intent": "move", "ids": ids, "by": [dx, dy]]
        }
    }
}
