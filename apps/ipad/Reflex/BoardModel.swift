import Foundation
import Observation
import PencilKit
import ReflexInput
import ReflexLink
import SwiftUI

// MARK: Paper

extension Paper {
    private static let newBoardsKey = "paperForNewBoards"
    /// The paper new boards start with, chosen with "Use for New Boards".
    static var forNewBoards: Paper {
        get { UserDefaults.standard.data(forKey: newBoardsKey).flatMap { try? JSONDecoder().decode(Paper.self, from: $0) } ?? Paper() }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: newBoardsKey) }
    }
}

struct Paper: Codable, Equatable, Hashable {
    enum Style: String, Codable, CaseIterable, Identifiable {
        case blank, dots, lines, squares
        var id: String { rawValue }
        var name: String { rawValue.capitalized }
        var symbol: String {
            switch self {
            case .blank: "square"
            case .dots: "circle.grid.3x3"
            case .lines: "line.3.horizontal"
            case .squares: "squareshape.split.3x3"
            }
        }
    }

    enum Spacing: String, Codable, CaseIterable, Identifiable {
        case small, medium, large
        var id: String { rawValue }
        var name: String { rawValue.capitalized }
        var points: CGFloat {
            switch self {
            case .small: 16
            case .medium: 28
            case .large: 48
            }
        }
    }

    enum Tint: String, Codable, CaseIterable, Identifiable {
        /// White in Light Mode, dark in Dark Mode.
        case automatic, white, cream, gray, green, blue, dark
        var id: String { rawValue }
        var name: String { self == .automatic ? "Match System" : rawValue.capitalized }

        func color(dark: Bool) -> Color {
            switch self {
            case .automatic: dark ? Color(red: 0.11, green: 0.11, blue: 0.12) : .white
            case .white: .white
            case .cream: Color(red: 0.99, green: 0.97, blue: 0.90)
            case .gray: Color(red: 0.93, green: 0.93, blue: 0.94)
            case .green: Color(red: 0.91, green: 0.96, blue: 0.91)
            case .blue: Color(red: 0.91, green: 0.95, blue: 0.99)
            case .dark: Color(red: 0.11, green: 0.11, blue: 0.12)
            }
        }

        func isDark(system dark: Bool) -> Bool {
            self == .dark || (self == .automatic && dark)
        }
    }

    var style: Style = .dots
    var spacing: Spacing = .medium
    var tint: Tint = .automatic
}

// MARK: Board metadata

struct Viewport: Codable, Equatable {
    var center: CGPoint
    var zoom: CGFloat
}

struct BoardScene: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString
    var name: String
    var rect: CGRect
}

struct BoardMeta: Codable, Equatable, Identifiable {
    var id: String
    var title: String
    var created: Date
    var modified: Date
    var opened: Date?
    var lastUsed: Date { max(opened ?? .distantPast, modified) }
    var favorite = false
    var folder: String?
    var paper = Paper()
    var viewport: Viewport?
    var scenes: [BoardScene] = []
    /// Typed text on the board, for search.
    var text = ""
    /// False until something is put on a new board. Empty new boards are discarded when left;
    /// boards from earlier versions are always kept.
    var hasContent = true
    var version = 1
}

struct BoardFolder: Codable, Equatable, Identifiable, Hashable {
    var id: String = "f_" + UUID().uuidString.prefix(8).lowercased()
    var name: String
    var parent: String?
    var created = Date()
}

// MARK: Objects

enum ShapeKind: String, Codable, CaseIterable, Identifiable {
    case roundedRect, line, arrow, curve, circle, triangle, pentagon, square, diamond, terminator, parallelogram, blockArrow
    // More shapes for the library.
    case hexagon, octagon, star, rightTriangle, speech, cloud, heart, plus, chevron, doubleArrow, trapezoid, cylinder
    var id: String { rawValue }

    static let basic: [ShapeKind] = [.roundedRect, .line, .arrow, .curve, .circle, .triangle, .pentagon, .square, .diamond, .terminator, .parallelogram, .blockArrow]
    static let more: [ShapeKind] = [.hexagon, .octagon, .star, .rightTriangle, .speech, .cloud, .heart, .plus, .chevron, .doubleArrow, .trapezoid, .cylinder]

    var name: String {
        switch self {
        case .roundedRect: "Rounded Rectangle"
        case .line: "Line"
        case .arrow: "Arrow"
        case .curve: "Curve"
        case .circle: "Circle"
        case .triangle: "Triangle"
        case .pentagon: "Pentagon"
        case .square: "Square"
        case .diamond: "Diamond"
        case .terminator: "Capsule"
        case .parallelogram: "Parallelogram"
        case .blockArrow: "Block Arrow"
        case .hexagon: "Hexagon"
        case .octagon: "Octagon"
        case .star: "Star"
        case .rightTriangle: "Right Triangle"
        case .speech: "Speech Bubble"
        case .cloud: "Cloud"
        case .heart: "Heart"
        case .plus: "Plus"
        case .chevron: "Chevron"
        case .doubleArrow: "Double Arrow"
        case .trapezoid: "Trapezoid"
        case .cylinder: "Cylinder"
        }
    }

    /// Lines are drawn as connectors with free ends.
    var isLine: Bool { self == .line || self == .arrow || self == .curve }
}

struct TableData: Codable, Equatable {
    var cells: [[String]]
    var rows: Int { cells.count }
    var cols: Int { cells.first?.count ?? 0 }
}

/// One end of a connector: stuck to an object, or free at a Space point.
struct ConnectorEnd: Codable, Equatable {
    var object: String?
    var point: CGPoint
}

enum ObjectKind: String, Codable {
    case sticky, text, shape, symbol, image, table, connector
}

enum TextAlign: String, Codable, CaseIterable {
    case leading, center, trailing
    var symbol: String {
        switch self {
        case .leading: "text.alignleft"
        case .center: "text.aligncenter"
        case .trailing: "text.alignright"
        }
    }
    var swiftUI: TextAlignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
    var frame: Alignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}

enum LineDash: String, Codable, CaseIterable {
    case none, solid, dashed, dotted
    var name: String { self == .none ? "No Line" : rawValue.capitalized }
}

enum ConnectorStyle: String, Codable, CaseIterable {
    case straight, elbow, curved
    var symbol: String {
        switch self {
        case .straight: "line.diagonal"
        case .elbow: "arrow.turn.down.right"
        case .curved: "point.topleft.down.to.point.bottomright.curvepath"
        }
    }
}

struct BoardObject: Codable, Equatable, Identifiable {
    var id: String = "o_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
    var kind: ObjectKind
    /// Frame in Space points. A connector's frame is its ends' bounds.
    var frame: CGRect
    var text = ""
    var fill: String?
    var stroke: String?
    var dash: LineDash = .solid
    var lineWidth: Double = 2
    var textColor: String?
    var fontSize: Double = 20
    var bold = false
    var italic = false
    var underline = false
    var align: TextAlign = .center
    var shape: ShapeKind?
    var symbol: String?
    var image: String?
    var table: TableData?
    var from: ConnectorEnd?
    var to: ConnectorEnd?
    var startArrow = false
    var endArrow = true
    var connectorStyle: ConnectorStyle = .straight
    var locked = false
    var group: String?
    var shadow = true
    var cornerRadius: Double = 0
    /// Drawn in front of the ink instead of under it. Optional so older boards decode.
    var aboveInk: Bool?

    var isAboveInk: Bool { aboveInk ?? false }
    /// A table left in its default white follows the paper (dark grey with light text on dark paper).
    var autoTableColors: Bool { kind == .table && fill?.uppercased() == "#FFFFFF" && textColor == nil }

    var isConnector: Bool { kind == .connector }
    var hasText: Bool { kind == .sticky || kind == .text || kind == .shape || kind == .table }
}

// MARK: Colors

enum Palette {
    static let sticky: [String] = ["#FBE38A", "#FFC48A", "#FFA8B6", "#D9B8FF", "#A8D5FF", "#B6EBB0", "#E6E6E6"]
    static let fills: [String] = ["#78BEF3", "#5AC8C8", "#7CD67C", "#FFD54A", "#FF9F45", "#FF6B6B", "#E57AD6", "#A78BFA", "#8E8E93", "#1C1C1E", "#FFFFFF", "#F2E6D0"]
    static let strokes: [String] = ["#1C1C1E", "#8E8E93", "#0A84FF", "#30B0C7", "#34C759", "#FFCC00", "#FF9500", "#FF3B30", "#AF52DE", "#FFFFFF"]
    static let text: [String] = ["#1C1C1E", "#8E8E93", "#0A84FF", "#34C759", "#FF9500", "#FF3B30", "#AF52DE", "#FFFFFF"]
}

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if s.count == 6 { s += "FF" }
        let v = UInt64(s, radix: 16) ?? 0
        self.init(.sRGB, red: Double((v >> 24) & 0xFF) / 255, green: Double((v >> 16) & 0xFF) / 255,
                  blue: Double((v >> 8) & 0xFF) / 255, opacity: Double(v & 0xFF) / 255)
    }
}

extension UIColor {
    convenience init(hex: String) {
        var s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if s.count == 6 { s += "FF" }
        let v = UInt64(s, radix: 16) ?? 0
        self.init(red: CGFloat((v >> 24) & 0xFF) / 255, green: CGFloat((v >> 16) & 0xFF) / 255,
                  blue: CGFloat((v >> 8) & 0xFF) / 255, alpha: CGFloat(v & 0xFF) / 255)
    }
}

// MARK: Files

/// The files of one board, next to its ink: board.json, objects.json, history and media.
struct BoardFiles {
    let folder: URL
    var meta: URL { folder.appending(path: "board.json") }
    var objects: URL { folder.appending(path: "objects.json") }
    var history: URL { folder.appending(path: "history.json") }
    var thumbnail: URL { folder.appending(path: "thumb.png") }
    /// The same board as it looks in Dark Mode (Match System paper turns dark, black ink white).
    var thumbnailDark: URL { folder.appending(path: "thumb-dark.png") }
    var media: URL { folder.appending(path: "media", directoryHint: .isDirectory) }
    var ink: URL { folder.appending(path: "ink.pkdrawing") }

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .millisecondsSince1970
        return e
    }()
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .millisecondsSince1970
        return d
    }()

    func loadObjects() -> [BoardObject] {
        (try? Data(contentsOf: objects)).flatMap { try? Self.decoder.decode([BoardObject].self, from: $0) } ?? []
    }

    static let queue = DispatchQueue(label: "si.eilmer.reflex.board-files", qos: .utility)

    func save(objects list: [BoardObject]) {
        let url = objects, folder = folder
        guard let data = try? Self.encoder.encode(list) else { return }
        Self.queue.async {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    func save(meta value: BoardMeta) {
        let url = meta, folder = folder
        guard let data = try? Self.encoder.encode(value) else { return }
        Self.queue.async {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    func mediaURL(_ name: String) -> URL { media.appending(path: name) }
}

// MARK: Library

enum BoardSection: Hashable {
    case all, recents, favorites, folder(String)
}

enum BoardSort: String, CaseIterable {
    case date, name
}

/// Every board on this iPad, with folders, for the browser. Boards are the Link's pages
/// (Spaces/<id>), so a Send from any of them goes through the existing outbox.
@MainActor @Observable
final class BoardLibrary {
    private(set) var boards: [String: BoardMeta] = [:]
    private(set) var folders: [BoardFolder] = []
    /// Bumps when a thumbnail is written, so cards reload it.
    private(set) var thumbnailRevision: [String: Int] = [:]
    let link: LinkSync

    private static let foldersURL = URL.applicationSupportDirectory.appending(path: "Reflex/folders.json")

    init(link: LinkSync) {
        self.link = link
        folders = (try? Data(contentsOf: Self.foldersURL)).flatMap { try? BoardFiles.decoder.decode([BoardFolder].self, from: $0) } ?? []
        reload()
        discardEmptyNewBoards()
    }

    /// A new board left empty (the app quit while it was open) goes to the Trash at launch, as it would on Back.
    private func discardEmptyNewBoards() {
        let empty = boards.values.filter { meta in
            guard !meta.hasContent else { return false }
            let f = files(meta.id)
            // Anything that can't be read for sure counts as content, so nothing is lost.
            if let data = try? Data(contentsOf: f.objects), (try? BoardFiles.decoder.decode([BoardObject].self, from: data))?.isEmpty != true { return false }
            if let data = try? Data(contentsOf: f.ink), (try? PKDrawing(data: data))?.strokes.isEmpty != true { return false }
            return true
        }
        if !empty.isEmpty { delete(empty.map(\.id)) }
    }

    func files(_ id: String) -> BoardFiles { BoardFiles(folder: link.folderURL(id)) }

    /// Reads every page's board.json, making one for pages from earlier versions in place.
    func reload() {
        var next: [String: BoardMeta] = [:]
        var untitled = 0
        for id in link.spaces {
            let f = files(id)
            if let data = try? Data(contentsOf: f.meta), let meta = try? BoardFiles.decoder.decode(BoardMeta.self, from: data) {
                next[id] = meta
                continue
            }
            // A page from an earlier version: keep it as it is, with a readable title.
            let attrs = try? FileManager.default.attributesOfItem(atPath: f.folder.path(percentEncoded: false))
            let inkDate = (try? FileManager.default.attributesOfItem(atPath: f.ink.path(percentEncoded: false)))?[.modificationDate] as? Date
            let created = attrs?[.creationDate] as? Date ?? Date()
            let raw = link.title(id)
            let title: String
            if raw.hasPrefix("page_") {
                untitled += 1
                title = untitled == 1 ? "Untitled" : "Untitled \(untitled)"
            } else {
                title = raw.prefix(1).uppercased() + raw.dropFirst()
            }
            let meta = BoardMeta(id: id, title: title, created: created, modified: inkDate ?? created, hasContent: true)
            f.save(meta: meta)
            next[id] = meta
        }
        boards = next
    }

    var all: [BoardMeta] { Array(boards.values) }

    func boards(in section: BoardSection) -> [BoardMeta] {
        switch section {
        case .all: all
        // Opened or edited in the last 30 days, newest first.
        case .recents: all.filter { $0.lastUsed > Date.now.addingTimeInterval(-30 * 86400) }.sorted { $0.lastUsed > $1.lastUsed }.prefix(30).map { $0 }
        case .favorites: all.filter(\.favorite)
        case .folder(let f):
            all.filter { $0.folder != nil && (self.descendants(of: f) + [f]).contains($0.folder!) }
        }
    }

    func descendants(of folder: String) -> [String] {
        let kids = folders.filter { $0.parent == folder }.map(\.id)
        return kids + kids.flatMap(descendants(of:))
    }

    func count(_ section: BoardSection) -> Int { boards(in: section).count }

    func folder(_ id: String?) -> BoardFolder? { folders.first { $0.id == id } }

    // MARK: Boards

    func nextUntitled() -> String {
        let titles = Set(all.map(\.title))
        if !titles.contains("Untitled") { return "Untitled" }
        var n = 2
        while titles.contains("Untitled \(n)") { n += 1 }
        return "Untitled \(n)"
    }

    /// A new, empty board. It is discarded when left empty.
    func create(in folder: String? = nil) -> String {
        let id = link.createPage()
        var meta = BoardMeta(id: id, title: nextUntitled(), created: Date(), modified: Date(), folder: folder, hasContent: false)
        meta.viewport = Viewport(center: InkCanvasControllerDefaults.newCenter, zoom: 1)
        meta.paper = Paper.forNewBoards
        boards[id] = meta
        files(id).save(meta: meta)
        return id
    }

    func update(_ id: String, _ change: (inout BoardMeta) -> Void) {
        guard var meta = boards[id] else { return }
        change(&meta)
        guard meta != boards[id] else { return }
        boards[id] = meta
        files(id).save(meta: meta)
    }

    func rename(_ id: String, _ title: String) {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        update(id) { $0.title = t; $0.modified = Date() }
    }

    func toggleFavorite(_ id: String) { update(id) { $0.favorite.toggle() } }

    func move(_ ids: [String], to folder: String?) {
        for id in ids { update(id) { $0.folder = folder } }
    }

    /// Moves boards to Reflex/Trash (kept on disk) and off the list.
    func delete(_ ids: [String]) {
        BoardFiles.queue.sync {}
        InkCanvasControllerDefaults.finishSaving()
        for id in ids {
            link.removePage(id)
            boards[id] = nil
        }
    }

    @discardableResult
    func duplicate(_ id: String) -> String? {
        guard let source = boards[id] else { return nil }
        BoardFiles.queue.sync {}
        InkCanvasControllerDefaults.finishSaving()
        let copy = link.createPage()
        let from = files(id).folder, to = files(copy).folder
        let fm = FileManager.default
        for item in (try? fm.contentsOfDirectory(at: from, includingPropertiesForKeys: nil)) ?? [] {
            let name = item.lastPathComponent
            // The copy starts its own history and Sends.
            guard name != "board.json", name != "history.json", name != "space.automerge" else { continue }
            try? fm.copyItem(at: item, to: to.appending(path: name))
        }
        var meta = source
        meta.id = copy
        meta.title = source.title + " copy"
        meta.created = Date()
        meta.modified = Date()
        meta.opened = nil
        meta.favorite = false
        meta.hasContent = true
        boards[copy] = meta
        files(copy).save(meta: meta)
        thumbnailRevision[copy, default: 0] += 1
        return copy
    }

    func thumbnailWritten(_ id: String) { thumbnailRevision[id, default: 0] += 1 }

    /// Draws thumbnails for boards that have none yet (boards from earlier versions).
    func ensureThumbnails() {
        for (id, meta) in boards where !FileManager.default.fileExists(atPath: files(id).thumbnailDark.path(percentEncoded: false)) {
            let f = files(id)
            let drawing = (try? Data(contentsOf: f.ink)).flatMap { try? PKDrawing(data: $0) } ?? PKDrawing()
            let objects = f.loadObjects()
            var r = drawing.strokes.isEmpty ? CGRect.null : drawing.bounds
            for o in objects { r = r.union(o.frame) }
            guard !r.isNull else { continue }
            guard let png = BoardRenderer.image(of: r.insetBy(dx: -40, dy: -40), drawing: drawing, objects: objects, files: f, paper: meta.paper, maxSide: 640, dark: false)?.pngData() else { continue }
            try? png.write(to: f.thumbnail, options: .atomic)
            if let dark = BoardRenderer.image(of: r.insetBy(dx: -40, dy: -40), drawing: drawing, objects: objects, files: f, paper: meta.paper, maxSide: 640, dark: true)?.pngData() {
                try? dark.write(to: f.thumbnailDark, options: .atomic)
            }
            thumbnailWritten(id)
        }
    }

    // MARK: Folders

    @discardableResult
    func createFolder(_ name: String, parent: String? = nil) -> BoardFolder {
        let f = BoardFolder(name: name.isEmpty ? "New Folder" : name, parent: parent)
        folders.append(f)
        saveFolders()
        return f
    }

    func renameFolder(_ id: String, _ name: String) {
        guard let i = folders.firstIndex(where: { $0.id == id }), !name.isEmpty else { return }
        folders[i].name = name
        saveFolders()
    }

    func moveFolder(_ id: String, to parent: String?) {
        guard let i = folders.firstIndex(where: { $0.id == id }), parent != id, !(parent.map { descendants(of: id).contains($0) } ?? false) else { return }
        folders[i].parent = parent
        saveFolders()
    }

    /// Deletes a folder and its subfolders; their boards move up to All Boards, never deleted.
    func deleteFolder(_ id: String) {
        let gone = Set(descendants(of: id) + [id])
        for b in all where b.folder.map(gone.contains) ?? false { update(b.id) { $0.folder = nil } }
        folders.removeAll { gone.contains($0.id) }
        saveFolders()
    }

    func children(of parent: String?) -> [BoardFolder] {
        folders.filter { $0.parent == parent }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func path(_ folder: String?) -> String {
        var names: [String] = []
        var f = self.folder(folder)
        while let cur = f {
            names.insert(cur.name, at: 0)
            f = self.folder(cur.parent)
        }
        return names.joined(separator: " › ")
    }

    private func saveFolders() {
        if let data = try? BoardFiles.encoder.encode(folders) { try? data.write(to: Self.foldersURL, options: .atomic) }
    }
}

enum InkCanvasControllerDefaults {
    static let newCenter = CGPoint(x: 8000, y: 8000)
    @MainActor static func finishSaving() { InkCanvasController.finishSaving() }
}
