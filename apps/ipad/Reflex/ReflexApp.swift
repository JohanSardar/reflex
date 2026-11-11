import SwiftUI

@main
struct ReflexApp: App {
    /// A pairing code opened as a link (reflex://pair?...), from the camera app or another app.
    @State private var code: String?

    var body: some Scene {
        WindowGroup {
            CanvasScreen(incomingCode: $code)
                .onOpenURL { url in
                    // A pairing code, or an invite to someone's shared Space.
                    if url.scheme == "reflex", url.host == "pair" || url.host == "invite" { code = url.absoluteString }
                    #if DEBUG
                    if url.scheme == "reflex", url.host == "debug" { NotificationCenter.default.post(name: .debugInk, object: url) }
                    #endif
                }
        }
    }
}

#if DEBUG
extension Notification.Name {
    /// reflex://debug/ellipse?cx=&cy=&rx=&ry= draws one closed stroke at those screen points, and
    /// reflex://debug/voice?file=<name in Documents> sends that recording as if spoken, and
    /// reflex://debug/write?region=<id>&text=<line> writes a line by hand in a Region (Simulator automation only).
    static let debugInk = Notification.Name("si.eilmer.reflex.debug-ink")
}
#endif
