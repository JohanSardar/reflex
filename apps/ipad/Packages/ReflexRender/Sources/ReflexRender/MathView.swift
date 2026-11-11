import SwiftMath
import SwiftUI
import UIKit

extension EnvironmentValues {
    /// The canvas zoom the Elements are drawn at, so vector content can render at that resolution.
    @Entry public var canvasZoom: CGFloat = 1
}

/// A `math` Element: its LaTeX typeset natively (SwiftMath: CoreText with an
/// OpenType math font). The view is drawn at the screen's scale times the
/// canvas zoom, so it stays crisp however far the person zooms in. LaTeX that
/// doesn't parse shows as its source, in italics.
struct MathElementView: UIViewRepresentable {
    let latex: String
    let fontSize: CGFloat
    let color: UIColor
    @Environment(\.canvasZoom) private var zoom
    @Environment(\.displayScale) private var displayScale

    func makeUIView(context: Context) -> MathCanvasView { MathCanvasView() }

    func updateUIView(_ view: MathCanvasView, context: Context) {
        view.update(latex: latex, fontSize: fontSize, color: color)
        // Backing pixels for the zoomed size, capped so one huge formula can't take a lot of memory.
        let wanted = displayScale * max(1, zoom)
        let area = max(1, view.bounds.width * view.bounds.height)
        view.renderScale = min(wanted, max(displayScale, (24_000_000 / area).squareRoot()))
    }
}

final class MathCanvasView: UIView {
    private let label = MTMathUILabel()
    private let fallback = UILabel()
    private var key = ""

    var renderScale: CGFloat = 2 {
        didSet {
            guard renderScale != oldValue else { return }
            for v in [self, label, fallback] as [UIView] {
                v.contentScaleFactor = renderScale
                v.layer.contentsScale = renderScale
            }
            label.setNeedsDisplay()
            fallback.setNeedsDisplay()
        }
    }

    init() {
        super.init(frame: .zero)
        isOpaque = false
        backgroundColor = .clear
        isUserInteractionEnabled = false
        label.labelMode = .display
        label.textAlignment = .left
        label.displayErrorInline = false
        fallback.numberOfLines = 0
        addSubview(label)
        addSubview(fallback)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func update(latex: String, fontSize: CGFloat, color: UIColor) {
        let k = "\(latex)|\(fontSize)|\(color)"
        guard k != key else { return }
        key = k
        label.latex = latex
        label.fontSize = fontSize
        label.textColor = color
        let parsed = label.error == nil && label.mathList != nil
        label.isHidden = !parsed
        fallback.isHidden = parsed
        fallback.text = latex
        fallback.textColor = color
        fallback.font = UIFont(descriptor: UIFont.systemFont(ofSize: fontSize).fontDescriptor.withDesign(.serif)?.withSymbolicTraits(.traitItalic) ?? UIFont.systemFont(ofSize: fontSize).fontDescriptor, size: fontSize)
        accessibilityLabel = latex
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = bounds
        fallback.frame = bounds
        label.setNeedsLayout()
    }
}
