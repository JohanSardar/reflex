import PencilKit
import UIKit
import Vision

/// Apple's on-device handwriting recognition, as a hint for the Link
/// (ARCHITECTURE §8.2). Strokes drawn close together in space and time are
/// grouped; each group is rendered and read by Vision. A group that reads as
/// text becomes one hint with its strokes, text and confidence.
/// It is only a hint: the raw strokes always go with the Send, and the Link
/// decides what each Mark is.
enum Handwriting {
    struct Group {
        var ids: [String]
        var strokes: [PKStroke]
        var bounds: CGRect
        var end: Date
    }

    /// Groups strokes the way handwriting falls: each stroke joins the group it
    /// overlaps (bounds grown by about one letter) if it was drawn within 3 s of it.
    static func groups(_ strokes: [(id: String, stroke: PKStroke)]) -> [Group] {
        var out: [Group] = []
        for (id, s) in strokes.sorted(by: { $0.stroke.path.creationDate < $1.stroke.path.creationDate }) {
            let b = s.renderBounds
            let start = s.path.creationDate
            let end = start.addingTimeInterval(s.path.last?.timeOffset ?? 0)
            let reach = max(14, min(b.height, 60) * 0.6)
            if let i = out.lastIndex(where: { g in
                start.timeIntervalSince(g.end) < 3 && g.bounds.insetBy(dx: -reach, dy: -reach / 2).intersects(b)
            }) {
                out[i].ids.append(id)
                out[i].strokes.append(s)
                out[i].bounds = out[i].bounds.union(b)
                out[i].end = max(out[i].end, end)
            } else {
                out.append(Group(ids: [id], strokes: [s], bounds: b, end: end))
            }
        }
        return out
    }

    /// One hint per group that Vision reads as text (`raw-send.schema.json`, `hints`).
    static func hints(_ strokes: [(id: String, stroke: PKStroke)]) async -> [[String: Any]] {
        var out: [[String: Any]] = []
        for g in groups(strokes) {
            guard let image = render(g) else { continue }
            guard let read = await recognize(image) else { continue }
            // A lone stroke that reads as one character is a circle, a line or an arrow far more often than a letter.
            if g.ids.count == 1 && read.text.count < 2 { continue }
            out.append(["strokes": g.ids, "text": read.text, "confidence": (read.confidence * 100).rounded() / 100])
        }
        return out
    }

    // MARK: Lines, for a Region's working

    /// Splits handwriting into lines, as working in a Region is written: a stroke
    /// joins the line its vertical middle sits in, or that it overlaps by half its
    /// height (a minus sign or the bars of = join the digits beside them). Taller
    /// strokes form the lines first, and very tall ones (over 120 points, such as
    /// brackets around several lines) join last, as the kernel does. Lines come top to bottom.
    static func lines(_ strokes: [(id: String, stroke: PKStroke)]) -> [Group] {
        var out: [Group] = []
        let tall = { (s: PKStroke) in s.renderBounds.height > 120 }
        let order = strokes.sorted { a, b in
            let (ta, tb) = (tall(a.stroke), tall(b.stroke))
            if ta != tb { return !ta }
            return a.stroke.renderBounds.height > b.stroke.renderBounds.height
        }
        for (id, s) in order {
            let b = s.renderBounds
            let end = s.path.creationDate.addingTimeInterval(s.path.last?.timeOffset ?? 0)
            let best = out.indices.filter { i in
                let l = out[i].bounds
                let h = max(l.height, 1)
                let overlap = min(b.maxY, l.maxY) - max(b.minY, l.minY)
                return (b.midY >= l.minY - 0.15 * h && b.midY <= l.minY + 1.15 * h) || overlap >= 0.5 * max(1, min(b.height, h))
            }.min { abs(out[$0].bounds.midY - b.midY) < abs(out[$1].bounds.midY - b.midY) }
            if let i = best {
                out[i].ids.append(id)
                out[i].strokes.append(s)
                out[i].bounds = out[i].bounds.union(b)
                out[i].end = max(out[i].end, end)
            } else {
                out.append(Group(ids: [id], strokes: [s], bounds: b, end: end))
            }
        }
        return out.sorted { $0.bounds.minY < $1.bounds.minY }
    }

    /// Recognized lines already read, by the line's strokes, so a Region's lines are read again only when they change.
    @MainActor private static var lineCache: [String: (text: String, confidence: Double)] = [:]

    /// One hint per line of handwriting that Vision reads, top to bottom: the line's
    /// strokes, its text and a confidence. This is the recognizer's own line grouping,
    /// for a Region's Send and its watch snapshots.
    @MainActor
    static func lineHints(_ strokes: [(id: String, stroke: PKStroke)]) async -> [[String: Any]] {
        var out: [[String: Any]] = []
        for line in lines(strokes) {
            let key = line.ids.sorted().joined(separator: ",")
            var read = lineCache[key]
            if read == nil, let image = render(line) {
                read = await recognize(image, correct: false)
                if let read { lineCache[key] = read }
            }
            guard let read else { continue }
            out.append(["strokes": line.ids, "text": read.text, "confidence": (read.confidence * 100).rounded() / 100])
        }
        if lineCache.count > 2000 { lineCache = [:] }
        return out
    }

    /// The group drawn in black on white, as Vision reads best.
    private static func render(_ g: Group) -> CGImage? {
        let rect = g.bounds.insetBy(dx: -16, dy: -16)
        guard rect.width >= 4, rect.height >= 4 else { return nil }
        let black = g.strokes.map { s in
            var s = s
            s.ink = PKInk(s.ink.inkType, color: .black)
            return s
        }
        let scale = min(3, max(1, 400 / max(rect.width, rect.height)))
        let ink = PKDrawing(strokes: black).image(from: rect, scale: scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: rect.size, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: rect.size))
            ink.draw(in: CGRect(origin: .zero, size: rect.size))
        }
        return image.cgImage
    }

    /// `correct: false` for working such as equations, which language correction turns into words.
    private static func recognize(_ image: CGImage, correct: Bool = true) async -> (text: String, confidence: Double)? {
        await withCheckedContinuation { done in
            DispatchQueue.global(qos: .userInitiated).async {
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = correct
                let handler = VNImageRequestHandler(cgImage: image)
                do {
                    try handler.perform([request])
                } catch {
                    done.resume(returning: nil)
                    return
                }
                // Lines top to bottom, then left to right.
                let lines = (request.results ?? []).sorted {
                    abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.1 ? $0.boundingBox.midY > $1.boundingBox.midY : $0.boundingBox.minX < $1.boundingBox.minX
                }
                let best = lines.compactMap { $0.topCandidates(1).first }
                guard !best.isEmpty else {
                    done.resume(returning: nil)
                    return
                }
                let text = best.map(\.string).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
                let confidence = best.map { Double($0.confidence) }.reduce(0, +) / Double(best.count)
                done.resume(returning: text.isEmpty ? nil : (text, confidence))
            }
        }
    }
}
