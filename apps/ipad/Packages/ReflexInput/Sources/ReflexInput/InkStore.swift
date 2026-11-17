import Foundation
import OSLog
import PencilKit

let inkLog = Logger(subsystem: "si.eilmer.reflex", category: "ink")

/// Native PencilKit archive and local stroke identity. Nothing here has a network path.
struct InkStore {
    struct Saved: Codable, Sendable {
        var version = 1
        var strokes: [PortableStroke]
        /// Strokes erased or undone, kept for lineage.
        var retired: [StrokeRecord]
        var unsent: [String]?
    }

    let directory: URL
    private var drawingURL: URL { directory.appending(path: "ink.pkdrawing") }
    private var strokesURL: URL { directory.appending(path: "ink.json") }

    init(space: String) {
        let local = space.hasPrefix("local-only:")
        let base = URL.applicationSupportDirectory.appending(
            path: local ? "Reflex/LocalOnly" : "Reflex/Spaces", directoryHint: .isDirectory)
        directory = base.appending(
            path: local ? String(space.dropFirst("local-only:".count)) : space, directoryHint: .isDirectory)
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

    /// Writes on a serial background queue, so saves land in order and drawing
    /// never waits on the disk.
    func loadUnsent(fallback: [String]) -> [String] {
        (try? JSONDecoder().decode(Saved.self, from: Data(contentsOf: strokesURL)))?.unsent ?? fallback
    }

    func save(_ drawing: PKDrawing, portable: [PortableStroke], retired: [StrokeRecord], unsent: [String]) {
        let saved = Saved(strokes: portable, retired: retired, unsent: unsent)
        let directory = directory
        let strokesURL = strokesURL
        let drawingURL = drawingURL
        Self.queue.async {
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                // If the app dies between these two writes, load() still pairs the
                // strokes both files share; only the difference gets new IDs.
                try drawing.dataRepresentation().write(to: drawingURL, options: .atomic)
                try JSONEncoder().encode(saved).write(to: strokesURL, options: .atomic)
            } catch {
                inkLog.error("Could not save Ink: \(error.localizedDescription)")
            }
        }
    }

    static func finishSaving() { queue.sync {} }

    private static let queue = DispatchQueue(label: "si.eilmer.reflex.ink-store", qos: .utility)
}
