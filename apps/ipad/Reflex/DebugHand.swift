#if DEBUG
import CoreText
import UIKit

/// Simulated handwriting for the Simulator, which has no Pencil: the outline of
/// each glyph of a handwriting-like font, flattened into pen strokes in Space
/// points. Only for driving the app in Debug builds (`reflex://debug/write`).
enum DebugHand {
    /// One stroke per closed contour of each glyph, left to right; `origin` is the start of the baseline.
    static func strokes(_ text: String, at origin: CGPoint, size: CGFloat) -> [[CGPoint]] {
        let font = CTFontCreateWithName("Noteworthy-Bold" as CFString, size, nil)
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font]))
        var out: [[CGPoint]] = []
        for run in CTLineGetGlyphRuns(line) as? [CTRun] ?? [] {
            let n = CTRunGetGlyphCount(run)
            var glyphs = [CGGlyph](repeating: 0, count: n)
            var positions = [CGPoint](repeating: .zero, count: n)
            CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
            CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
            let attrs = CTRunGetAttributes(run) as NSDictionary
            let runFont = attrs[kCTFontAttributeName as String].map { $0 as! CTFont } ?? font
            for i in 0 ..< n {
                guard let path = CTFontCreatePathForGlyph(runFont, glyphs[i], nil) else { continue }
                let at = CGPoint(x: origin.x + positions[i].x, y: origin.y)
                // Glyph space has y up; the Space has y down.
                let map = { (p: CGPoint) in CGPoint(x: at.x + p.x, y: at.y - p.y) }
                var current: [CGPoint] = []
                var last = CGPoint.zero
                var start = CGPoint.zero
                path.applyWithBlock { el in
                    let e = el.pointee
                    switch e.type {
                    case .moveToPoint:
                        if current.count > 1 { out.append(current) }
                        last = e.points[0]
                        start = last
                        current = [map(last)]
                    case .addLineToPoint:
                        last = e.points[0]
                        current.append(map(last))
                    case .addQuadCurveToPoint:
                        let (c, p) = (e.points[0], e.points[1])
                        for k in 1 ... 6 {
                            let t = CGFloat(k) / 6, u = 1 - t
                            current.append(map(CGPoint(x: u * u * last.x + 2 * u * t * c.x + t * t * p.x, y: u * u * last.y + 2 * u * t * c.y + t * t * p.y)))
                        }
                        last = p
                    case .addCurveToPoint:
                        let (c1, c2, p) = (e.points[0], e.points[1], e.points[2])
                        for k in 1 ... 8 {
                            let t = CGFloat(k) / 8, u = 1 - t
                            let x = u * u * u * last.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p.x
                            let y = u * u * u * last.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p.y
                            current.append(map(CGPoint(x: x, y: y)))
                        }
                        last = p
                    case .closeSubpath:
                        current.append(map(start))
                        if current.count > 1 { out.append(current) }
                        current = []
                    @unknown default:
                        break
                    }
                }
                if current.count > 1 { out.append(current) }
            }
        }
        return out
    }
}
#endif
