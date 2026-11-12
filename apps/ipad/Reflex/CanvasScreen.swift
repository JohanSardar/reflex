import OSLog
import PencilKit
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
    /// The Agent question on screen: the first one the Link lists as waiting. Kept in view state so the alert
    /// is shown again for each new question, also while a Space is open.
    @State private var asking: AgentRequest?
    @State private var askingApprover: ApproverRequest?
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
                .environment(\.modelHost, open.models)
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
        .overlay(alignment: .top) {
            // The Mac's Link was reset: this iPad stopped dialing it, and says what to do.
            if case .linkChanged = link.state {
                HStack(spacing: 12) {
                    Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(.orange)
                    Text("This Mac's Link changed. Scan its code again.").font(.callout)
                    Button("Scan") { pairing = true }.buttonStyle(.glassProminent).accessibilityIdentifier("scan-again")
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                .glassEffect()
                .padding(.top, 72)
                .accessibilityIdentifier("link-changed")
            } else if let why = link.approvalElsewhere {
                // An Agent waits, but this iPad's Allow wouldn't count: say where to answer.
                Text(why)
                    .font(.callout)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .glassEffect()
                    .padding(.top, 72).padding(.horizontal, 120)
                    .accessibilityIdentifier("approve-elsewhere")
            }
        }
        .sheet(isPresented: $pairing) { PairSheet(link: link, code: incomingCode ?? "") }
        .sheet(isPresented: $sharing) { if let open { ShareSheet(link: link, space: open.id) } }
        .sheet(isPresented: $showHistory) { if let open { HistorySheet(session: open, link: link) } }
        // On its own view, so it and the Agent question never compete for one view's alert.
        .background {
            Color.clear.alert(
                link.localOnlyNotice?.count == 1 ? "1 Space from \(link.localOnlyNotice?.owner ?? "an earlier pairing") stays on this iPad" : "\(link.localOnlyNotice?.count ?? 0) Spaces from \(link.localOnlyNotice?.owner ?? "an earlier pairing") stay on this iPad",
                isPresented: Binding(get: { link.localOnlyNotice != nil && asking == nil }, set: { if !$0 { link.dismissLocalOnlyNotice() } })
            ) {
                Button("Keep on this iPad", role: .cancel) { link.dismissLocalOnlyNotice() }
                Button("Delete them", role: .destructive) {
                    if let o = open, link.localOnly[o.id] != nil { open = nil }
                    link.deleteLocalOnly()
                }
            } message: {
                Text("They were made with an earlier Link, so they aren't sent to this one. You can still open them here.")
            }
        }
        // A device of this person's paired with the Link: said once, so one nobody meant to pair shows.
        .background {
            Color.clear.alert(
                "\(link.newDevice?.name ?? "A device") paired with your Link",
                isPresented: Binding(get: { link.newDevice != nil && asking == nil }, set: { if !$0 { link.newDevice = nil } })
            ) {
                Button("OK", role: .cancel) { link.newDevice = nil }
            } message: {
                Text(link.newDevice?.approves == true
                    ? "It was paired with a code shown in the Link's terminal: it can sync your Spaces and approve Agents."
                    : "It can sync your Spaces, but approving Agents stays with this iPad. If you didn't pair it, run `reflex link status` on your computer to see it.")
            }
        }
        // Another iPad of the person's wants to approve Agents: only an approving iPad can let it.
        .onChange(of: link.approverRequests, initial: true) { _, list in
            if askingApprover.map({ a in !list.contains { $0.id == a.id } }) ?? true { askingApprover = list.first }
        }
        .background {
            Color.clear.alert(
                "Let \(askingApprover?.name ?? "this iPad") approve Agents?",
                isPresented: Binding(get: { askingApprover != nil && asking == nil && link.newDevice == nil }, set: { if !$0 { askingApprover = nil } }),
                presenting: askingApprover
            ) { r in
                Button("Don't Allow", role: .cancel) { link.decideApprover(r.device, allow: false) }
                Button("Allow") { link.decideApprover(r.device, allow: true) }
            } message: { _ in
                Text("It paired with your Link. If you allow it, its Allow lets Agents use your Spaces, like this iPad's. Only allow an iPad you paired yourself.")
            }
        }
        .onChange(of: link.agentRequests, initial: true) { _, list in
            if asking.map({ a in !list.contains { $0.id == a.id } }) ?? true { asking = list.first }
        }
        .alert(
            "Allow \(asking?.name ?? "this Agent") to use your Spaces?",
            isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
            presenting: asking
        ) { a in
            Button("Don't Allow", role: .cancel) { link.decide(a.id, allow: false) }
            Button("Allow") { link.decide(a.id, allow: true) }
        } message: { _ in
            Text("It will be able to read and draw on your Spaces, and receive what you send.")
        }
        .onChange(of: link.revision) { _, _ in
            open?.refresh()
            if let open { lastSeen[open.id] = link.revision[open.id] ?? 0 }
        }
        // A new role (made a viewer, removed) applies to the canvas at once, not at the next change.
        .onChange(of: open.map { link.role($0.id) } ?? "") { _, _ in open?.refresh() }
        .onChange(of: link.assetRevision) { _, _ in open?.models.retry() }
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
            let num = { (k: String) in Double(q.first { $0.name == k }?.value ?? "").map { CGFloat($0) } }
            if url.path == "/write", q.first(where: { $0.name == "region" }) == nil, let x = num("x"), let y = num("y") {
                let text = q.first { $0.name == "text" }?.value ?? ""
                let pause = Double(q.first { $0.name == "pause" }?.value ?? "") ?? 0.05
                Task { await open.debugWrite(screen: CGPoint(x: x, y: y), text: text, size: num("size") ?? 24, pause: pause) }
                return
            }
            if url.path == "/line", let raw = q.first(where: { $0.name == "points" })?.value {
                let corners = raw.split(separator: ";").compactMap { pair -> CGPoint? in
                    let xy = pair.split(separator: ",").compactMap { Double($0) }
                    return xy.count == 2 ? CGPoint(x: xy[0], y: xy[1]) : nil
                }
                open.debugLine(screen: corners)
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
                Text("Run `reflex setup` on your computer, then tap Connect and scan the code it shows.").foregroundStyle(.secondary)
                Button("Connect") { pairing = true }.buttonStyle(.glassProminent).accessibilityIdentifier("connect-empty")
            case .linkChanged:
                Text("This Mac's Link changed").font(.title3)
                Text("Run `reflex pair` on your computer, then scan its code again.").foregroundStyle(.secondary)
                Button("Scan again") { pairing = true }.buttonStyle(.glassProminent).accessibilityIdentifier("connect-empty")
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
                    Label(link.localOnly[id] == nil ? id : "\(link.title(id)) (this iPad only)", systemImage: open?.id == id ? "checkmark" : unread(id) ? "circle.fill" : "square.on.square")
                }
                .accessibilityIdentifier("space-\(id)")
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "square.stack")
                Text(open.map { link.title($0.id) } ?? "Spaces").lineLimit(1)
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
        case .linkChanged: "Scan again"
        }
    }

    private var statusColor: Color {
        switch link.state {
        case .connected: .green
        case .connecting: .orange
        case .offline: .red
        case .linkChanged: .orange
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
    /// `models` are pictures of 3D Embeds (Space frames), drawn where they are: a view snapshot
    /// leaves their Metal content out. `ink` is drawn again over them.
    static func capture(space rect: CGRect, zoom: CGFloat, offset: CGPoint, models: [(CGRect, UIImage)] = [], ink: PKDrawing? = nil) -> (png: Data, bounds: CGRect)? {
        guard !rect.isNull, rect.width >= 1, rect.height >= 1,
              let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first
        else { return nil }
        let onScreen = CGRect(x: rect.minX * zoom - offset.x, y: rect.minY * zoom - offset.y, width: rect.width * zoom, height: rect.height * zoom)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(size: onScreen.size, format: format).image { _ in
            window.drawHierarchy(in: CGRect(origin: CGPoint(x: -onScreen.minX, y: -onScreen.minY), size: window.bounds.size), afterScreenUpdates: false)
            let shown = models.filter { $0.0.intersects(rect) }
            guard !shown.isEmpty else { return }
            let toCrop = { (r: CGRect) in CGRect(x: (r.minX - rect.minX) * zoom, y: (r.minY - rect.minY) * zoom, width: r.width * zoom, height: r.height * zoom) }
            for (frame, image) in shown { image.draw(in: toCrop(frame)) }
            if let ink {
                let img = ink.image(from: rect, scale: 2)
                img.draw(in: toCrop(rect))
            }
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
