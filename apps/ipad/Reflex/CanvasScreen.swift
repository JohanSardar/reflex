import OSLog
import ReflexInput
import ReflexLink
import ReflexRender
import SwiftUI

private let log = Logger(subsystem: "si.eilmer.reflex", category: "canvas")

/// The app: the open Space (its Elements, the person's Ink on top, the toolbar
/// and the Send button), the Space picker, pairing, and Agent approval.
struct CanvasScreen: View {
    @State private var link = LinkSync(deviceName: UIDevice.current.name)
    @State private var open: SpaceSession?
    @State private var showStrokeIDs = false
    @State private var notice: String?
    @State private var pairing = false
    /// Spaces changed since the person last looked at them (SPEC §4, Attention).
    @State private var lastSeen: [String: Int] = [:]
    @Binding var incomingCode: String?

    var body: some View {
        ZStack {
            Color(red: 0.99, green: 0.99, blue: 0.97).ignoresSafeArea()
            if let open {
                ElementsLayer(scene: open.scene, offset: open.ink.contentOffset, zoom: open.ink.zoomScale, spaceSize: InkCanvasController.spaceSize)
                    .ignoresSafeArea()
                InkCanvas(controller: open.ink).ignoresSafeArea().id(open.id)
                if showStrokeIDs {
                    StrokeIDOverlay(strokes: open.ink.strokes, offset: open.ink.contentOffset, zoom: open.ink.zoomScale)
                        .ignoresSafeArea()
                }
            } else {
                emptyState
            }
        }
        .overlay(alignment: .top) {
            HStack(spacing: 10) {
                spaceMenu
                if let open { InkToolbar(ink: open.ink, showStrokeIDs: $showStrokeIDs) }
                connectButton
            }
            .padding(.top, 8)
        }
        .overlay(alignment: .bottomTrailing) {
            if open != nil { SendButton(action: send).padding(24) }
        }
        .overlay(alignment: .bottom) {
            if let notice {
                Text(notice)
                    .font(.callout)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .glassEffect()
                    .padding(.bottom, 32)
                    .transition(.opacity)
                    .accessibilityIdentifier("send-notice")
            }
        }
        .sheet(isPresented: $pairing) { PairSheet(link: link, code: incomingCode ?? "") }
        .alert(
            "Allow \(link.agentRequests.first?.name ?? "this Agent") to use your Spaces?",
            isPresented: Binding(get: { !link.agentRequests.isEmpty }, set: { _ in })
        ) {
            if let a = link.agentRequests.first {
                Button("Don't Allow", role: .cancel) { link.decide(a.id, allow: false) }
                Button("Allow") { link.decide(a.id, allow: true) }
            }
        } message: {
            Text("It will be able to read and draw on your Spaces, and receive what you send.")
        }
        .onChange(of: link.revision) { _, _ in
            open?.refresh()
            if let open { lastSeen[open.id] = link.revision[open.id] ?? 0 }
        }
        .onChange(of: incomingCode) { _, code in if code != nil { pairing = true } }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .debugInk)) { note in
            guard let url = note.object as? URL, let open,
                  let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
            let v = { (k: String) in CGFloat(Double(q.first { $0.name == k }?.value ?? "") ?? 0) }
            let points = (0 ... 72).map { i in
                let a = Double(i) / 72 * 2 * .pi
                return CGPoint(x: v("cx") + v("rx") * cos(a), y: v("cy") + v("ry") * sin(a))
            }
            open.ink.debugDraw(screen: points)
        }
        #endif
        .preferredColorScheme(.light)
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "scribble.variable").font(.system(size: 44)).foregroundStyle(.secondary)
            switch link.state {
            case .unpaired:
                Text("Connect this iPad to your Reflex Link").font(.title3)
                Text("Run `reflex link` on your computer, then tap Connect.").foregroundStyle(.secondary)
                Button("Connect") { pairing = true }.buttonStyle(.glassProminent).accessibilityIdentifier("connect-empty")
            default:
                Text(link.spaces.isEmpty ? "No Spaces yet" : "Pick a Space").font(.title3)
                Text(link.spaces.isEmpty ? "When an Agent opens a Space, it shows up in the Spaces menu." : "Open one from the Spaces menu.").foregroundStyle(.secondary)
            }
        }
    }

    private func unread(_ id: String) -> Bool { (link.revision[id] ?? 0) > (lastSeen[id] ?? 0) && open?.id != id }

    private var spaceMenu: some View {
        Menu {
            if link.spaces.isEmpty { Text("No Spaces yet") }
            ForEach(link.spaces, id: \.self) { id in
                Button {
                    open = SpaceSession(id: id, link: link)
                    lastSeen[id] = link.revision[id] ?? 0
                } label: {
                    Label(id, systemImage: open?.id == id ? "checkmark" : unread(id) ? "circle.fill" : "square.on.square")
                }
                .accessibilityIdentifier("space-\(id)")
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "square.stack")
                Text(open?.id ?? "Spaces").lineLimit(1)
                if link.spaces.contains(where: unread) { Circle().fill(.blue).frame(width: 8, height: 8) }
            }
            .font(.system(size: 16, weight: .medium))
            .padding(.horizontal, 14).frame(height: 48)
            .glassEffect()
        }
        .accessibilityIdentifier("spaces-menu")
    }

    private var connectButton: some View {
        Button { pairing = true } label: {
            HStack(spacing: 6) {
                Circle().fill(statusColor).frame(width: 9, height: 9)
                Text(statusText).lineLimit(1)
            }
            .font(.system(size: 15, weight: .medium))
            .padding(.horizontal, 14).frame(height: 48)
            .glassEffect()
        }
        .accessibilityIdentifier("connect-button")
        .accessibilityLabel("Link: \(statusText)")
    }

    private var statusText: String {
        switch link.state {
        case .unpaired: "Connect"
        case .connecting: "Connecting…"
        case .connected(let name): name.split(separator: ".").first.map(String.init) ?? name
        case .offline: "Offline"
        }
    }

    private var statusColor: Color {
        switch link.state {
        case .connected: .green
        case .connecting: .orange
        case .offline: .red
        case .unpaired: .gray
        }
    }

    /// Captures the Send: the strokes since the last one (claimed by the kernel), the viewport, and a crop
    /// of what the screen showed around them, stored as an asset first so it is durable before the Send refers to it.
    private func send() {
        guard let open else { return }
        let ink = open.ink
        let strokes = ink.takeUnsent()
        let zoom = ink.zoomScale, offset = ink.contentOffset
        let screen = ink.canvasView.bounds.size
        let viewport = CGRect(x: offset.x / zoom, y: offset.y / zoom, width: screen.width / zoom, height: screen.height / zoom)
        var raw: [String: Any] = [
            "send": "s_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12),
            "trigger": "button",
            "viewport": [viewport.minX, viewport.minY, viewport.width, viewport.height].map { Int($0.rounded()) },
        ]
        let marked = ink.strokes.filter { strokes.contains($0.id) }.map(\.bounds).reduce(CGRect.null) { $0.union($1) }
        if !marked.isNull, let crop = Crop.capture(space: marked.insetBy(dx: -60, dy: -60).intersection(viewport), zoom: zoom, offset: offset) {
            do {
                let hash = try link.storeAsset(crop.png)
                let b = crop.bounds
                raw["crops"] = [["asset": hash, "bounds": [b.minX, b.minY, b.width, b.height].map { Int($0.rounded()) }, "strokes": strokes]]
            } catch {
                log.error("Could not store the crop: \(error.localizedDescription, privacy: .public)")
            }
        }
        do {
            let frozen = try link.freezeSend(open.id, raw: raw)
            let n = (frozen["strokes"] as? [Any])?.count ?? 0
            log.info("Send \(frozen["send"] as? String ?? "", privacy: .public) frozen with \(n) strokes")
            if case .connected = link.state { say("Sent: \(n) stroke\(n == 1 ? "" : "s")") } else { say("Saved: it goes out when the Link is back") }
        } catch {
            say("Could not send: \(error.localizedDescription)")
        }
    }

    private func say(_ text: String) {
        withAnimation { notice = text }
        Task {
            try? await Task.sleep(for: .seconds(3))
            withAnimation { if notice == text { notice = nil } }
        }
    }
}

/// What the screen shows in one rectangle of the Space, as a PNG.
enum Crop {
    @MainActor
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
