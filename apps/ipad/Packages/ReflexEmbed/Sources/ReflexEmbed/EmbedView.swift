import SwiftUI
import UIKit
import WebKit

/// One Embed's sandboxed web view, kept alive by the `EmbedHost` across redraws.
public struct EmbedView: UIViewRepresentable {
    let host: EmbedHost
    let key: String
    let spec: EmbedHost.Spec
    /// Whether it takes touches: Embeds in a Panel do; on the canvas the Pencil draws over them.
    let interactive: Bool

    public init(host: EmbedHost, key: String, spec: EmbedHost.Spec, interactive: Bool) {
        self.host = host
        self.key = key
        self.spec = spec
        self.interactive = interactive
    }

    public func makeUIView(context: Context) -> UIView {
        let box = UIView()
        box.clipsToBounds = true
        attach(box)
        return box
    }

    public func updateUIView(_ box: UIView, context: Context) {
        attach(box)
    }

    private func attach(_ box: UIView) {
        let web = host.webView(key, spec: spec)
        web.isUserInteractionEnabled = interactive
        if web.superview !== box {
            web.removeFromSuperview()
            web.frame = box.bounds
            web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            box.addSubview(web)
        }
    }

    public static func dismantleUIView(_ box: UIView, coordinator: ()) {
        box.subviews.forEach { $0.removeFromSuperview() }
    }
}

/// What the sandbox stopped on one Embed, shown over it.
public struct EmbedNoteView: View {
    let note: EmbedHost.Note

    public init(note: EmbedHost.Note) { self.note = note }

    public var body: some View {
        Label(note.text, systemImage: note.stopped ? "stop.circle" : "hand.raised")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color(red: 0.54, green: 0.23, blue: 0))
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Color(red: 1, green: 0.96, blue: 0.9), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(red: 0.97, green: 0.42, blue: 0.08), lineWidth: 1))
            .padding(8)
            .accessibilityIdentifier("embed-note")
    }
}
