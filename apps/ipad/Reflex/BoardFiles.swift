import Foundation

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
        let url = objects
        let folder = folder
        guard let data = try? Self.encoder.encode(list) else { return }
        Self.queue.async {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    func save(meta value: BoardMeta) {
        let url = meta
        let folder = folder
        guard let data = try? Self.encoder.encode(value) else { return }
        Self.queue.async {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    func mediaURL(_ name: String) -> URL { media.appending(path: name) }
}
