import Foundation
import Observation
import PencilKit
import ReflexInput
import ReflexLink
import SwiftUI

// MARK: Library

enum BoardSection: Hashable {
    case all, recents, favorites
    case folder(String)
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
        folders =
            (try? Data(contentsOf: Self.foldersURL)).flatMap {
                try? BoardFiles.decoder.decode([BoardFolder].self, from: $0)
            } ?? []
        reload()
        discardEmptyNewBoards()
    }

    /// A new board left empty (the app quit while it was open) goes to the Trash at launch, as it would on Back.
    private func discardEmptyNewBoards() {
        let empty = boards.values.filter { meta in
            guard !meta.hasContent else { return false }
            let f = files(meta.id)
            // Anything that can't be read for sure counts as content, so nothing is lost.
            if let data = try? Data(contentsOf: f.objects),
                (try? BoardFiles.decoder.decode([BoardObject].self, from: data))?.isEmpty != true
            {
                return false
            }
            if let data = try? Data(contentsOf: f.ink), (try? PKDrawing(data: data))?.strokes.isEmpty != true {
                return false
            }
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
            if let data = try? Data(contentsOf: f.meta),
                let meta = try? BoardFiles.decoder.decode(BoardMeta.self, from: data)
            {
                next[id] = meta
                continue
            }
            // A page from an earlier version: keep it as it is, with a readable title.
            let attrs = try? FileManager.default.attributesOfItem(atPath: f.folder.path(percentEncoded: false))
            let inkDate =
                (try? FileManager.default.attributesOfItem(atPath: f.ink.path(percentEncoded: false)))?[
                    .modificationDate] as? Date
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
        case .recents:
            all.filter { $0.lastUsed > Date.now.addingTimeInterval(-30 * 86400) }.sorted { $0.lastUsed > $1.lastUsed }
                .prefix(30).map { $0 }
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
        var meta = BoardMeta(
            id: id, title: nextUntitled(), created: Date(), modified: Date(), folder: folder, hasContent: false)
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
        update(id) {
            $0.title = t
            $0.modified = Date()
        }
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
        let from = files(id).folder
        let to = files(copy).folder
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
        for (id, meta) in boards
        where !FileManager.default.fileExists(atPath: files(id).thumbnailDark.path(percentEncoded: false)) {
            let f = files(id)
            let drawing = (try? Data(contentsOf: f.ink)).flatMap { try? PKDrawing(data: $0) } ?? PKDrawing()
            let objects = f.loadObjects()
            var r = drawing.strokes.isEmpty ? CGRect.null : drawing.bounds
            for o in objects { r = r.union(o.frame) }
            guard !r.isNull else { continue }
            guard
                let png = BoardRenderer.image(
                    of: r.insetBy(dx: -40, dy: -40), drawing: drawing, objects: objects, files: f, paper: meta.paper,
                    maxSide: 640, dark: false)?.pngData()
            else { continue }
            try? png.write(to: f.thumbnail, options: .atomic)
            if let dark = BoardRenderer.image(
                of: r.insetBy(dx: -40, dy: -40), drawing: drawing, objects: objects, files: f, paper: meta.paper,
                maxSide: 640, dark: true)?.pngData()
            {
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
        guard let i = folders.firstIndex(where: { $0.id == id }), parent != id,
            !(parent.map { descendants(of: id).contains($0) } ?? false)
        else { return }
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
