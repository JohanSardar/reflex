import OSLog
import ReflexInput
import ReflexRender
import SwiftUI

private let log = Logger(subsystem: "si.eilmer.reflex", category: "canvas")

/// One Space: the Elements, the user's Ink on top, the toolbar and the Send button.
struct CanvasScreen: View {
    @State private var ink = InkCanvasController(space: "demo")
    @State private var scene = CanvasScreen.loadStandInScene()
    @State private var showStrokeIDs = false
    @State private var sendNotice: String?

    var body: some View {
        ZStack {
            Color(red: 0.99, green: 0.99, blue: 0.97).ignoresSafeArea()
            if let scene {
                ElementsLayer(
                    scene: scene, offset: ink.contentOffset, zoom: ink.zoomScale,
                    spaceSize: InkCanvasController.spaceSize
                )
                .ignoresSafeArea()
            }
            InkCanvas(controller: ink).ignoresSafeArea()
            if showStrokeIDs {
                StrokeIDOverlay(strokes: ink.strokes, offset: ink.contentOffset, zoom: ink.zoomScale)
                    .ignoresSafeArea()
            }
        }
        .overlay(alignment: .top) {
            InkToolbar(ink: ink, showStrokeIDs: $showStrokeIDs).padding(.top, 8)
        }
        .overlay(alignment: .bottomTrailing) {
            SendButton(action: send).padding(24)
        }
        .overlay(alignment: .bottom) {
            if let sendNotice {
                Text(sendNotice)
                    .font(.callout)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .glassEffect()
                    .padding(.bottom, 32)
                    .transition(.opacity)
                    .accessibilityIdentifier("send-notice")
            }
        }
        .preferredColorScheme(.light)
    }

    /// Captures what this Send carries. Freezing it in the kernel and delivering
    /// it to an Agent come with the round-trip ticket (T6).
    private func send() {
        let strokes = ink.takeUnsent()
        log.info("Send: strokes \(strokes, privacy: .public)")
        withAnimation { sendNotice = "Send ready: \(strokes.count) new stroke\(strokes.count == 1 ? "" : "s")" }
        Task {
            try? await Task.sleep(for: .seconds(3))
            withAnimation { sendNotice = nil }
        }
    }

    /// The stand-in scene until the kernel's `scene` is connected.
    static func loadStandInScene() -> SceneDocument? {
        guard let url = Bundle.main.url(forResource: "standin-scene", withExtension: "json") else {
            log.error("standin-scene.json is missing from the bundle")
            return nil
        }
        do {
            return try SceneDocument.load(from: url)
        } catch {
            log.error("Could not read the stand-in scene: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }
}

/// Each stroke's Reflex ID drawn at its bounds, to check identity by eye.
struct StrokeIDOverlay: View {
    let strokes: [InkStrokeInfo]
    let offset: CGPoint
    let zoom: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(strokes) { stroke in
                let origin = CGPoint(
                    x: stroke.bounds.minX * zoom - offset.x,
                    y: stroke.bounds.maxY * zoom - offset.y
                )
                Text(stroke.parent.map { "\(stroke.id) ← \($0)" } ?? stroke.id)
                    .font(.system(size: 11, design: .monospaced))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Color.yellow.opacity(0.85), in: RoundedRectangle(cornerRadius: 3))
                    .fixedSize()
                    .offset(x: origin.x, y: origin.y + 2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .allowsHitTesting(false)
    }
}
