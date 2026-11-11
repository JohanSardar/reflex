import OSLog
import ReflexInput
import ReflexLink
import ReflexRender
import SwiftUI
import UniformTypeIdentifiers

private let log = Logger(subsystem: "si.eilmer.reflex", category: "canvas")

/// The app: the open Space (its Elements, the person's Ink on top, the toolbar
/// and the Send button), the Space picker, pairing, and Agent approval.
struct CanvasScreen: View {
    @State private var link = LinkSync(deviceName: UIDevice.current.name)
    @State private var open: SpaceSession?
    @State private var showStrokeIDs = false
    @State private var pairing = false
    @State private var showHistory = false
    @State private var sharing = false
    @State private var voice = VoiceCapture()
    /// Spaces changed since the person last looked at them (SPEC §4, Attention).
    @State private var lastSeen: [String: Int] = [:]
    @Environment(\.scenePhase) private var scenePhase
    @Binding var incomingCode: String?

    var body: some View {
        ZStack {
            Color(red: 0.99, green: 0.99, blue: 0.97).ignoresSafeArea()
            if let open {
                ElementsLayer(
                    scene: open.scene, offset: open.ink.contentOffset, zoom: open.ink.zoomScale, spaceSize: InkCanvasController.spaceSize,
                    localInk: open.localInk, remoteInk: open.remoteInk, dragging: open.dragging
                )
                .environment(\.assetImages, AssetImages { [link] hash in AssetImageCache.shared.image(hash, link: link) })
                .environment(\.embedHost, open.embeds)
                .ignoresSafeArea()
                InkCanvas(controller: open.ink).ignoresSafeArea().id(open.id)
                    .onDrop(of: [.item], delegate: CanvasDrop(session: open))
                RegionButtons(session: open).ignoresSafeArea()
                EmbedAllowButtons(session: open).ignoresSafeArea()
                // Other people here: their cursors and what they picked.
                HereOverlay(people: here(open.id), scene: open.scene, offset: open.ink.contentOffset, zoom: open.ink.zoomScale)
                    .ignoresSafeArea()
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
                if let open {
                    InkToolbar(ink: open.ink, showStrokeIDs: $showStrokeIDs)
                    ImportMenu(session: open)
                    shareButton(open)
                }
                connectButton
            }
            .padding(.top, 8)
        }
        .overlay(alignment: .topTrailing) {
            if let open {
                HStack(spacing: 8) {
                    HereChips(people: here(open.id))
                    if open.role == "viewer" { badge("View only", "eye") }
                    if open.role == nil { badge("Removed", "person.crop.circle.badge.xmark") }
                }
                .padding(.top, 68).padding(.trailing, 16)
            }
        }
        .overlay(alignment: .topLeading) {
            if let open { AgentsBar(session: open, link: link, showHistory: $showHistory).padding(.top, 68).padding(.leading, 16) }
        }
        .overlay(alignment: .trailing) {
            if let open, let shown = open.panel {
                PanelView(session: open, panel: shown.panel).padding(.vertical, 72).padding(.trailing, 16)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                    .id(shown.element)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if let open {
                HStack(spacing: 14) {
                    MicButton(voice: voice, onFail: { open.say($0) }) { said, words in
                        open.send(trigger: "voice", said: said, words: words)
                    }
                    SendButton { open.send(trigger: "button") }
                }
                .padding(24)
            }
        }
        .overlay(alignment: .bottom) {
            if voice.state != .idle, !voice.partial.isEmpty {
                Text(voice.partial)
                    .font(.title3)
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .glassEffect()
                    .padding(.bottom, 110).padding(.horizontal, 120)
                    .accessibilityIdentifier("voice-partial")
            }
        }
        .overlay(alignment: .bottom) {
            if let notice = open?.notice {
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
        .sheet(isPresented: $sharing) { if let open { ShareSheet(link: link, space: open.id) } }
        .sheet(isPresented: $showHistory) { if let open { HistorySheet(session: open, link: link) } }
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
        // Which Space is on screen, so an Agent's request_attention knows the person is already looking at it.
        .onChange(of: open?.id, initial: true) { _, _ in reportPresence() }
        .onChange(of: scenePhase) { _, _ in reportPresence() }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .debugInk)) { note in
            guard let url = note.object as? URL, let open,
                  let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
            if url.path == "/voice", let name = q.first(where: { $0.name == "file" })?.value {
                let file = URL.documentsDirectory.appending(path: name)
                Task {
                    do {
                        let (said, words) = try await voice.debugTranscribe(file)
                        open.send(trigger: "voice", said: said, words: words)
                    } catch {
                        open.say(error.localizedDescription)
                    }
                }
                return
            }
            if url.path == "/write", let region = q.first(where: { $0.name == "region" })?.value {
                let text = q.first { $0.name == "text" }?.value ?? ""
                let pause = Double(q.first { $0.name == "pause" }?.value ?? "") ?? 0.05
                Task { await open.debugWrite(region: region, text: text, pause: pause) }
                return
            }
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

    /// Other devices showing this Space now.
    private func here(_ space: String) -> [HereEntry] {
        link.here.values.filter { $0.space == space }.sorted { $0.device < $1.device }
    }

    private func badge(_ text: String, _ icon: String) -> some View {
        Label(text, systemImage: icon)
            .font(.system(size: 13, weight: .semibold))
            .padding(.horizontal, 10).frame(height: 28)
            .glassEffect()
            .accessibilityIdentifier("role-badge")
    }

    private func shareButton(_ open: SpaceSession) -> some View {
        Button { sharing = true } label: {
            Image(systemName: open.share == nil ? "person.badge.plus" : "person.2.fill")
                .font(.system(size: 17, weight: .medium))
                .frame(width: 48, height: 48)
                .glassEffect()
        }
        .accessibilityIdentifier("share-button")
        .accessibilityLabel(open.share == nil ? "Share this Space" : "People in this Space")
    }

    private func reportPresence() {
        link.reportPresence(space: scenePhase == .active ? open?.id : nil, pen: false)
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
}

/// Decoded asset images, so a redraw doesn't decode them again.
@MainActor
final class AssetImageCache {
    static let shared = AssetImageCache()
    private let cache = NSCache<NSString, UIImage>()

    func image(_ hash: String, link: LinkSync) -> UIImage? {
        if let hit = cache.object(forKey: hash as NSString) { return hit }
        _ = link.assetRevision // redraw when an asset arrives from the Link
        guard let bytes = link.asset(hash), let image = UIImage(data: bytes) else { return nil }
        cache.setObject(image, forKey: hash as NSString)
        return image
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
