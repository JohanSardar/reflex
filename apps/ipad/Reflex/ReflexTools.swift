import PencilKit
import SwiftUI

/// Reflex's own tools in Apple's palette: sticky note, text box and shape. Picking one and
/// tapping the board places it there.
enum ReflexTools {
    @MainActor
    static func items(shapePicked: @escaping @MainActor (ShapeKind) -> Void) -> [PKToolPickerCustomItem] {
        [
            item("reflex.sticky", "Sticky Note", symbol: "note.text", color: UIColor(hex: Palette.sticky[0])),
            item("reflex.text", "Text", symbol: "character.textbox", color: .label),
            item("reflex.shape", "Shape", symbol: "square.on.circle", color: UIColor(hex: Palette.fills[0])) { _ in
                let host = UIHostingController(rootView: ShapeGrid(pick: { shapePicked($0) }, more: {}))
                host.preferredContentSize = CGSize(width: 310, height: 420)
                return host
            },
        ]
    }

    @MainActor
    private static func item(_ id: String, _ name: String, symbol: String, color: UIColor, settings: ((PKToolPickerCustomItem) -> UIViewController)? = nil) -> PKToolPickerCustomItem {
        var config = PKToolPickerCustomItem.Configuration(identifier: id, name: name)
        config.allowsColorSelection = false
        config.defaultColor = color
        config.imageProvider = { _ in toolImage(symbol: symbol, color: color) }
        if let settings { config.viewControllerProvider = settings }
        return PKToolPickerCustomItem(configuration: config)
    }

    /// A tool-shaped picture for the palette: the symbol on a tall rounded body.
    private static func toolImage(symbol: String, color: UIColor) -> UIImage {
        let size = CGSize(width: 40, height: 84)
        return UIGraphicsImageRenderer(size: size).image { _ in
            let body = UIBezierPath(roundedRect: CGRect(x: 4, y: 8, width: 32, height: 90), cornerRadius: 10)
            UIColor.systemBackground.setFill()
            body.fill()
            UIColor.separator.setStroke()
            body.lineWidth = 1
            body.stroke()
            let config = UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)
            if let img = UIImage(systemName: symbol, withConfiguration: config)?.withTintColor(color == .label ? .label : color, renderingMode: .alwaysOriginal) {
                img.draw(in: CGRect(x: 20 - img.size.width / 2, y: 30 - img.size.height / 2, width: img.size.width, height: img.size.height))
            }
        }
    }
}
