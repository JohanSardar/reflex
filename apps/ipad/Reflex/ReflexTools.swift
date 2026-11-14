import PencilKit
import SwiftUI

/// Reflex's own tools in Apple's palette: sticky note, text box and shape. Picking one and
/// tapping the board places it there.
enum ReflexTools {
    @MainActor
    static func items(shapePicked: @escaping @MainActor (ShapeKind) -> Void) -> [PKToolPickerCustomItem] {
        [
            item("reflex.sticky", "Sticky Note", art: .sticky, color: UIColor(hex: Palette.sticky[0])),
            item("reflex.text", "Text", art: .text, color: .label),
            item("reflex.shape", "Shape", art: .shape, color: UIColor(hex: Palette.fills[0])) { _ in
                let host = UIHostingController(rootView: ShapeGrid(pick: { shapePicked($0) }, more: {}))
                host.preferredContentSize = CGSize(width: 310, height: 420)
                return host
            },
        ]
    }

    enum Art { case sticky, text, shape }

    @MainActor
    private static func item(_ id: String, _ name: String, art: Art, color: UIColor, settings: ((PKToolPickerCustomItem) -> UIViewController)? = nil) -> PKToolPickerCustomItem {
        var config = PKToolPickerCustomItem.Configuration(identifier: id, name: name)
        config.allowsColorSelection = false
        config.defaultColor = color
        // Light or dark body, like Apple's tools in a light or dark palette.
        config.imageProvider = { _ in toolImage(art, dark: UITraitCollection.current.userInterfaceStyle == .dark) }
        if let settings { config.viewControllerProvider = settings }
        return PKToolPickerCustomItem(configuration: config)
    }

    /// Tool art drawn like Apple's instruments: a shaded cylindrical body with the tool's head on top.
    static func toolImage(_ art: Art, dark: Bool) -> UIImage {
        let size = CGSize(width: 36, height: 88)
        return UIGraphicsImageRenderer(size: size).image { r in
            let ctx = r.cgContext
            let bodyRect = CGRect(x: 6, y: 34, width: 24, height: 60)
            // Body: a soft cylinder (light in the middle, darker at the edges).
            func cylinder(_ rect: CGRect, _ colors: [UIColor], radius: CGFloat) {
                ctx.saveGState()
                UIBezierPath(roundedRect: rect, cornerRadius: radius).addClip()
                let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors.map(\.cgColor) as CFArray, locations: nil)!
                ctx.drawLinearGradient(g, start: CGPoint(x: rect.minX, y: 0), end: CGPoint(x: rect.maxX, y: 0), options: [])
                ctx.restoreGState()
            }
            let bodyColors = dark
                ? [UIColor(white: 0.10, alpha: 1), UIColor(white: 0.26, alpha: 1), UIColor(white: 0.18, alpha: 1), UIColor(white: 0.08, alpha: 1)]
                : [UIColor(white: 0.80, alpha: 1), UIColor(white: 0.99, alpha: 1), UIColor(white: 0.93, alpha: 1), UIColor(white: 0.74, alpha: 1)]
            cylinder(bodyRect, bodyColors, radius: 4)
            switch art {
            case .sticky:
                // A pad of notes on a collar.
                cylinder(CGRect(x: 6, y: 28, width: 24, height: 8), [UIColor(white: 0.62, alpha: 1), UIColor(white: 0.85, alpha: 1), UIColor(white: 0.6, alpha: 1)], radius: 2)
                for (i, a) in [(2, 0.55), (1, 0.75), (0, 1.0)] {
                    let rect = CGRect(x: 7 + CGFloat(i), y: 8 + CGFloat(i) * 3, width: 22, height: 20)
                    let yellow = UIColor(red: 1, green: 0.85, blue: 0.33, alpha: 1)
                    ctx.setShadow(offset: CGSize(width: 0, height: 1), blur: 1.5, color: UIColor.black.withAlphaComponent(0.25).cgColor)
                    yellow.withAlphaComponent(a).setFill()
                    let note = UIBezierPath()
                    note.move(to: rect.origin)
                    note.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
                    note.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - 6))
                    note.addLine(to: CGPoint(x: rect.maxX - 6, y: rect.maxY))
                    note.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
                    note.close()
                    note.fill()
                    ctx.setShadow(offset: .zero, blur: 0)
                    if i == 0 {
                        // Folded corner and two lines of writing.
                        UIColor(red: 0.85, green: 0.68, blue: 0.18, alpha: 1).setFill()
                        let fold = UIBezierPath()
                        fold.move(to: CGPoint(x: rect.maxX, y: rect.maxY - 6))
                        fold.addLine(to: CGPoint(x: rect.maxX - 6, y: rect.maxY - 6))
                        fold.addLine(to: CGPoint(x: rect.maxX - 6, y: rect.maxY))
                        fold.close()
                        fold.fill()
                        UIColor.black.withAlphaComponent(0.28).setFill()
                        UIBezierPath(roundedRect: CGRect(x: rect.minX + 4, y: rect.minY + 6, width: 13, height: 1.6), cornerRadius: 0.8).fill()
                        UIBezierPath(roundedRect: CGRect(x: rect.minX + 4, y: rect.minY + 10, width: 9, height: 1.6), cornerRadius: 0.8).fill()
                    }
                }
            case .text:
                // A tapered nib with a type cursor, and an "A" on the band.
                let nib = UIBezierPath()
                nib.move(to: CGPoint(x: 6, y: 36))
                nib.addLine(to: CGPoint(x: 15, y: 10))
                nib.addLine(to: CGPoint(x: 21, y: 10))
                nib.addLine(to: CGPoint(x: 30, y: 36))
                nib.close()
                ctx.saveGState()
                nib.addClip()
                let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [UIColor(white: 0.25, alpha: 1).cgColor, UIColor(white: 0.55, alpha: 1).cgColor, UIColor(white: 0.18, alpha: 1).cgColor] as CFArray, locations: nil)!
                ctx.drawLinearGradient(g, start: CGPoint(x: 6, y: 0), end: CGPoint(x: 30, y: 0), options: [])
                ctx.restoreGState()
                UIColor.systemBlue.setFill()
                UIBezierPath(roundedRect: CGRect(x: 17, y: 2, width: 2, height: 11), cornerRadius: 1).fill()
                UIBezierPath(roundedRect: CGRect(x: 14.5, y: 1.5, width: 7, height: 1.6), cornerRadius: 0.8).fill()
                let a = NSAttributedString(string: "A", attributes: [.font: UIFont.systemFont(ofSize: 13, weight: .heavy), .foregroundColor: UIColor(white: dark ? 0.75 : 0.35, alpha: 1)])
                let sz = a.size()
                a.draw(at: CGPoint(x: 18 - sz.width / 2, y: 44))
            case .shape:
                // A stamp head: a square and a circle.
                cylinder(CGRect(x: 6, y: 28, width: 24, height: 8), [UIColor(white: 0.62, alpha: 1), UIColor(white: 0.85, alpha: 1), UIColor(white: 0.6, alpha: 1)], radius: 2)
                ctx.setShadow(offset: CGSize(width: 0, height: 1), blur: 1.5, color: UIColor.black.withAlphaComponent(0.25).cgColor)
                UIColor(red: 0.20, green: 0.56, blue: 0.98, alpha: 1).setFill()
                UIBezierPath(roundedRect: CGRect(x: 5, y: 12, width: 15, height: 15), cornerRadius: 3).fill()
                UIColor(red: 0.20, green: 0.78, blue: 0.47, alpha: 1).setFill()
                UIBezierPath(ovalIn: CGRect(x: 15, y: 6, width: 16, height: 16)).fill()
                ctx.setShadow(offset: .zero, blur: 0)
            }
        }
    }
}
