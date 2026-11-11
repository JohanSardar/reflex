import Foundation
import OSLog
import PencilKit

let inkLog = Logger(subsystem: "si.eilmer.reflex", category: "ink")

/// Keeps one Space's user Ink on disk: the native PencilKit archive, and next to
/// it the portable strokes with their Reflex IDs, in the same order.
///
/// This is local storage only. Syncing finished strokes through the kernel
/// comes with the round-trip ticket (T6); the whole drawing archive is never
/// what gets synced.
struct InkStore {
    struct Saved: Codable {
        var version = 1
        var strokes: [PortableStroke]
        /// Strokes erased or undone, kept for lineage.
        var retired: [StrokeRecord]
    }

    let directory: URL
    private var drawingURL: URL { directory.appending(path: "ink.pkdrawing") }
    private var strokesURL: URL { directory.appending(path: "ink.json") }

    init(space: String) {
        let base = URL.applicationSupportDirectory.appending(path: "Reflex/Spaces", directoryHint: .isDirectory)
        directory = base.appending(path: space, directoryHint: .isDirectory)
    }

    func load() -> (PKDrawing, StrokeLedger) {
        guard let data = try? Data(contentsOf: drawingURL) else {
            return (PKDrawing(), StrokeLedger())
        }
        do {
            let drawing = try PKDrawing(data: data)
            let saved = try? JSONDecoder().decode(Saved.self, from: Data(contentsOf: strokesURL))
            let portable = saved?.strokes ?? []
            if portable.count != drawing.strokes.count {
                inkLog.error("ink.json has \(portable.count) strokes but the archive has \(drawing.strokes.count)")
            }
            let records = Self.match(drawing.strokes, to: portable)
            let ledger = StrokeLedger(strokes: drawing.strokes, records: records, retired: saved?.retired ?? [])
            return (drawing, ledger)
        } catch {
            inkLog.error("Could not read the Ink archive: \(error.localizedDescription)")
            return (PKDrawing(), StrokeLedger())
        }
    }

    /// Pairs each archived stroke with its saved record by creation time, point
    /// count and visible ranges, never by position alone. A stroke with no saved
    /// record gets a new ID.
    static func match(_ strokes: [PKStroke], to portable: [PortableStroke]) -> [StrokeRecord] {
        var remaining = portable
        return strokes.map { stroke in
            let created = stroke.path.creationDate
            let visible = stroke.maskedPathRanges.map { [Double($0.lowerBound), Double($0.upperBound)] }
            let index = remaining.firstIndex {
                abs($0.createdAt.timeIntervalSince(created)) < 0.001
                    && $0.points.count == stroke.path.count && $0.visible == visible
            }
            guard let index else { return StrokeRecord(id: StrokeRecord.newID()) }
            let found = remaining.remove(at: index)
            return StrokeRecord(id: found.id, parent: found.parent)
        }
    }

    func save(_ drawing: PKDrawing, portable: [PortableStroke], retired: [StrokeRecord]) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            let saved = Saved(strokes: portable, retired: retired)
            // If the app dies between these two writes, load() still pairs the
            // strokes both files share; only the difference gets new IDs.
            try encoder.encode(saved).write(to: strokesURL, options: .atomic)
            try drawing.dataRepresentation().write(to: drawingURL, options: .atomic)
        } catch {
            inkLog.error("Could not save Ink: \(error.localizedDescription)")
        }
    }
}
