import OSLog
import PencilKit
import ReflexInput
import ReflexLink
import SwiftUI

private let log = Logger(subsystem: "si.eilmer.reflex", category: "canvas")

/// The local ink page, tools, voice and Send, page picker, pairing and Agent approval.
struct CanvasScreen: View {
    @State private var link = LinkSync(deviceName: UIDevice.current.name)
    @State private var open: SpaceSession?
    @State private var showStrokeIDs = false
    @State private var pairing = false
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
                if let open {
                    InkToolbar(ink: open.ink, showStrokeIDs: $showStrokeIDs)
                }
                connectButton
            }
            .padding(.top, 8)
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
                    : "Approving Agents stays with this iPad. If you didn't pair it, run `reflex link status` on your computer to see it.")
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
            Text("It will receive what you send.")
        }
        .onChange(of: link.person?.id) { _, _ in
            if let id = link.spaces.first { open = SpaceSession(id: id, link: link) }
        }
        .onChange(of: incomingCode) { _, code in if code != nil { pairing = true } }
        .task {
            link.start()
            link.beforeChangingPerson = { open?.ink.flush(); InkCanvasController.finishSaving() }
            if open == nil, let id = link.spaces.first { open = SpaceSession(id: id, link: link) }
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { open?.ink.flush() } }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .debugInk)) { note in
            guard let url = note.object as? URL, let open,
                  let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
            if url.path == "/line", let raw = q.first(where: { $0.name == "points" })?.value {
                let points = raw.split(separator: ";").compactMap { pair -> CGPoint? in
                    let xy = pair.split(separator: ",").compactMap { Double($0) }
                    return xy.count == 2 ? CGPoint(x: xy[0], y: xy[1]) : nil
                }
                open.ink.debugDraw(screen: points)
            }
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
                Text("Run `reflex setup` on your computer, then tap Connect and scan the code it shows.").foregroundStyle(.secondary)
                Button("Connect") { pairing = true }.buttonStyle(.glassProminent).accessibilityIdentifier("connect-empty")
            case .linkChanged:
                Text("This Mac's Link changed").font(.title3)
                Text("Run `reflex pair` on your computer, then scan its code again.").foregroundStyle(.secondary)
                Button("Scan again") { pairing = true }.buttonStyle(.glassProminent).accessibilityIdentifier("connect-empty")
            default:
                Text(link.spaces.isEmpty ? "No Spaces yet" : "Pick a Space").font(.title3)
                Text("Create or open a page from the pages menu.").foregroundStyle(.secondary)
            }
        }
    }

    private func unread(_ id: String) -> Bool { (link.revision[id] ?? 0) > (lastSeen[id] ?? 0) && open?.id != id }

    private var spaceMenu: some View {
        Menu {
            Button("New page", systemImage: "plus") { open = SpaceSession(id: link.createPage(), link: link) }
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
