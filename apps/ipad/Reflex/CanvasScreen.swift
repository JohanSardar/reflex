import OSLog
import PencilKit
import ReflexInput
import ReflexLink
import SwiftUI

private let log = Logger(subsystem: "si.eilmer.reflex", category: "canvas")

/// The app: the board browser, an open board, pairing and Agent approval.
struct CanvasScreen: View {
    @State private var link = LinkSync(deviceName: UIDevice.current.name)
    @State private var library: BoardLibrary?
    @State private var open: BoardSession?
    @State private var pairing = false
    @State private var voice = VoiceCapture()
    /// The Agent question on screen: the first one the Link lists as waiting. Kept in view state so the alert
    /// is shown again for each new question, also while a board is open.
    @State private var asking: AgentRequest?
    @State private var askingApprover: ApproverRequest?
    @AppStorage("pairingShown") private var pairingShown = false
    @Environment(\.scenePhase) private var scenePhase
    @Binding var incomingCode: String?

    var body: some View {
        ZStack {
            if let library {
                BrowserView(library: library, link: link, open: openBoard, onStatus: { pairing = true })
                    .opacity(open == nil ? 1 : 0)
                    .allowsHitTesting(open == nil)
                    .accessibilityHidden(open != nil)
                if let open {
                    BoardScreen(session: open, link: link, voice: voice, library: library, onBack: closeBoard, onStatus: { pairing = true })
                        .id(open.id)
                        .transition(.asymmetric(insertion: .scale(scale: 0.92).combined(with: .opacity), removal: .opacity))
                }
            }
        }
        .animation(.smooth(duration: 0.3), value: open?.id)
        // A board with a chosen paper colour sets the chrome and status bar to match it.
        .preferredColorScheme(open.flatMap { b in
            switch b.meta.paper.tint {
            case .automatic: nil
            case .dark: .dark
            default: .light
            }
        })
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
        .onChange(of: link.spaces) { _, _ in library?.reload() }
        .onChange(of: incomingCode) { _, code in if code != nil { pairing = true } }
        .task {
            link.start()
            link.beforeChangingPerson = { open?.ink.flush(); InkCanvasController.finishSaving() }
            if library == nil {
                let lib = BoardLibrary(link: link)
                library = lib
                lib.ensureThumbnails()
            }
            // The pairing sheet comes up by itself only the first time.
            if case .unpaired = link.state, !pairingShown {
                pairingShown = true
                pairing = true
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { open?.ink.flush(); open?.saveNow(); open?.saveHistory() }
        }
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
    }

    private func openBoard(_ id: String) {
        guard let library else { return }
        open?.close()
        open = BoardSession(id: id, link: link, library: library, customItems: ReflexTools.items { tool in
            open?.shapeTool = tool
        })
    }

    private func closeBoard() {
        guard let o = open else { return }
        o.ink.setPickerVisible(false)
        let discarded = o.close()
        open = nil
        if discarded { library?.reload() }
    }
}
