import SwiftUI

@main
struct ReflexApp: App {
    /// A pairing code opened as a link (reflex://pair?...), from the camera app or another app.
    @State private var code: String?
    @Environment(\.scenePhase) private var phase

    /// Keeps the screen on while Reflex is in front: in Debug builds, or when launched with
    /// `-ReflexKeepAwake`, so a device run isn't cut short by Auto-Lock.
    private static let keepAwake: Bool = {
        #if DEBUG
        true
        #else
        ProcessInfo.processInfo.arguments.contains("-ReflexKeepAwake")
        #endif
    }()

    var body: some Scene {
        WindowGroup {
            CanvasScreen(incomingCode: $code)
                .onOpenURL { url in
                    // A pairing code from the Link.
                    if url.scheme == "reflex", url.host == "pair" { code = url.absoluteString }
                    #if DEBUG
                    if url.scheme == "reflex", url.host == "debug" { NotificationCenter.default.post(name: .debugInk, object: url) }
                    #endif
                }
                .onChange(of: phase, initial: true) { _, now in
                    if Self.keepAwake { UIApplication.shared.isIdleTimerDisabled = now == .active }
                }
        }
    }
}

#if DEBUG
extension Notification.Name {
    /// reflex://debug/line?points=x,y;x,y;… draws a stroke (Simulator automation only).
    static let debugInk = Notification.Name("si.eilmer.reflex.debug-ink")
}
#endif
