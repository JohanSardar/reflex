import PencilKit
import ReflexInput
import ReflexLink
import SwiftUI

/// A local page. Ink never enters the Link until the person makes a Send.
@MainActor @Observable
final class SpaceSession {
    let id: String
    let ink: InkCanvasController
    var notice: String?
    @ObservationIgnored private let link: LinkSync
    @ObservationIgnored private var sending: Task<Void, Never>?
    @ObservationIgnored private var reserved = Set<String>()

    init(id: String, link: LinkSync) {
        self.id = id
        self.link = link
        ink = InkCanvasController(space: id)
    }

    func say(_ text: String) {
        notice = text
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            if self?.notice == text { self?.notice = nil }
        }
    }

    func send(trigger: String, said: String? = nil, words: [[String: Any]] = []) {
        let destination = link.destinationKey
        let ids = ink.pendingStrokes().filter { !reserved.contains($0) }
        if trigger == "voice", said?.isEmpty ?? true, ids.isEmpty {
            say("Didn't hear anything, so nothing was sent.")
            return
        }
        let z = ink.zoomScale, o = ink.contentOffset, size = ink.canvasView.bounds.size
        let view = CGRect(x: o.x / z, y: o.y / z, width: size.width / z, height: size.height / z)
        let ints = { (r: CGRect) in [r.minX, r.minY, r.width, r.height].map { Int($0.rounded()) } }
        let portable = ink.portableStrokes(ids)
        let pk = ink.pkStrokes(ids)
        let encode = { (s: PortableStroke) -> [String: Any] in
            ["id": s.id, "points": s.spacePoints, "bounds": s.bounds, "color": s.namedColor, "width": s.points.first?.width ?? 3, "at": Int64(s.createdAt.timeIntervalSince1970 * 1000)]
        }
        var raw: [String: Any] = ["send": "s_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(), "trigger": trigger, "viewport": ints(view),
            "strokes": portable.map(encode), "context": ink.portableStrokes(ink.strokes.map(\.id)).map(encode)]
        if let said, !said.isEmpty { raw["said"] = said }
        if !words.isEmpty { raw["words"] = words }
        let marked = ink.strokes.filter { ids.contains($0.id) }.map(\.bounds).reduce(CGRect.null) { $0.union($1) }
        let rect = marked.isNull ? view : marked.insetBy(dx: -60, dy: -60).intersection(view)
        do {
            if let crop = Crop.capture(space: rect, zoom: z, offset: o) {
                let hash = try link.storeAsset(crop.png)
                raw["crops"] = [["asset": hash, "bounds": ints(crop.bounds), "strokes": ids]]
            }
        } catch { say("Could not save the Send image: \(error.localizedDescription)"); return }
        reserved.formUnion(ids)
        let previous = sending
        sending = Task {
            await previous?.value
            let hints = await Handwriting.hints(pk)
            if !hints.isEmpty { raw["hints"] = hints }
            do {
                _ = try link.enqueueSend(id, raw: raw, destination: destination)
                ink.claim(ids)
                if case .connected = link.state { say("Sent: \(ids.count) strokes") }
                else { say("Saved: it goes out when the Link is back") }
            } catch { say("Could not send: \(error.localizedDescription)") }
            reserved.subtract(ids)
        }
    }
}

/// What the screen shows in one rectangle of the Space, as a PNG.
enum Crop {
    @MainActor
    /// `models` are pictures of 3D Embeds (Space frames), drawn where they are: a view snapshot
    /// leaves their Metal content out. `ink` is drawn again over them.
    static func capture(space rect: CGRect, zoom: CGFloat, offset: CGPoint) -> (png: Data, bounds: CGRect)? {
        guard !rect.isNull, rect.width >= 1, rect.height >= 1,
              let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first
        else { return nil }
        let onScreen = CGRect(x: rect.minX * zoom - offset.x, y: rect.minY * zoom - offset.y, width: rect.width * zoom, height: rect.height * zoom)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(size: onScreen.size, format: format).image { _ in
            window.drawHierarchy(in: CGRect(origin: CGPoint(x: -onScreen.minX, y: -onScreen.minY), size: window.bounds.size), afterScreenUpdates: false)

        }
        return image.pngData().map { ($0, rect) }
    }
}

