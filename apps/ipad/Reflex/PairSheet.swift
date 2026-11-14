import ReflexLink
import SwiftUI
import VisionKit

/// What the status capsule says about the Mac and the approved Agents.
@MainActor struct LinkStatus {
    let link: LinkSync

    var paired: Bool { if case .unpaired = link.state { false } else { true } }
    var approved: [AgentInfo] { link.agents.values.filter { $0.status == "approved" }.sorted { $0.name < $1.name } }
    var macName: String {
        let raw = link.pairedName ?? { if case .connected(let n) = link.state { n } else { "your Mac" } }()
        return raw.split(separator: ".").first.map(String.init) ?? raw
    }

    var color: Color {
        switch link.state {
        case .connected: .green
        case .connecting: .orange
        case .offline: .gray
        case .linkChanged: .orange
        case .unpaired: .gray
        }
    }

    var headline: String {
        switch link.state {
        case .unpaired: "Not paired"
        case .connecting: "Connecting to \(macName)…"
        case .connected: macName
        case .offline: "\(macName) is offline"
        case .linkChanged: "Scan the code again"
        }
    }
}

/// The small status capsule: the Mac's state, and which Agents are approved.
struct StatusCapsule: View {
    let link: LinkSync
    let compact: Bool
    let action: () -> Void

    var body: some View {
        let s = LinkStatus(link: link)
        Button(action: action) {
            HStack(spacing: 7) {
                Circle().fill(s.color.gradient).frame(width: 9, height: 9)
                    .overlay { if case .connecting = link.state { Circle().stroke(s.color.opacity(0.4), lineWidth: 4).scaleEffect(1.6) } }
                Text(shortHeadline(s)).lineLimit(1)
                if link.pendingSends > 0 {
                    Text("·").foregroundStyle(.secondary)
                    Text("\(link.pendingSends) waiting")
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                }
            }
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(.primary)
            .padding(.horizontal, 14).frame(height: 44)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Capsule())
        .accessibilityIdentifier("connect-button")
        .accessibilityLabel("Connection: \(s.headline)\(s.approved.isEmpty ? "" : ", agents \(s.approved.map(\.name).joined(separator: ", "))")\(link.pendingSends > 0 ? ", \(link.pendingSends) Sends waiting" : "")")
    }

    private func shortHeadline(_ s: LinkStatus) -> String {
        switch link.state {
        case .unpaired: "Pair with Mac"
        case .offline: compact ? "Offline" : "\(s.macName) offline"
        case .connecting: "Connecting…"
        case .linkChanged: "Scan again"
        case .connected: s.macName
        }
    }
}

/// Pairing and approvals: the Mac, the Agents, and pairing a new Mac by scanning the code
/// `reflex setup` shows (or typing it where there is no camera, such as the Simulator).
struct PairSheet: View {
    let link: LinkSync
    @State var code: String
    @State private var scanning = false
    @State private var busy = false
    @State private var error: String?
    @State private var typing = false
    @State private var renamingAgent: String?
    @State private var renameDraft = ""
    @AppStorage("agentNicknames") private var nicknamesData = Data()
    @Environment(\.dismiss) private var dismiss

    private var canScan: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    var body: some View {
        let s = LinkStatus(link: link)
        NavigationStack {
            Form {
                if s.paired {
                    Section("Mac") {
                        HStack(spacing: 14) {
                            Image(systemName: "laptopcomputer").font(.title2).foregroundStyle(s.color)
                                .frame(width: 44, height: 44).background(s.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.macName).font(.headline)
                                Text(stateDetail).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Circle().fill(s.color).frame(width: 10, height: 10)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("mac-row")
                        if link.pendingSends > 0 {
                            HStack {
                                Label(link.pendingSends == 1 ? "1 Send is waiting and goes out when \(s.macName) is back."
                                      : "\(link.pendingSends) Sends are waiting and go out when \(s.macName) is back.", systemImage: "tray.full")
                                    .foregroundStyle(.orange)
                                Spacer()
                                if case .connected = link.state {} else {
                                    Button("Retry Now") { link.retryNow() }.buttonStyle(.bordered)
                                }
                            }
                        }
                    }
                    Section {
                        if s.approved.isEmpty && link.agentRequests.isEmpty {
                            Text("No Agents yet. When an Agent on your Mac asks to receive your Sends, you'll be asked here to allow it.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(link.agentRequests) { a in
                            HStack {
                                agentIcon(displayName(a), color: a.color)
                                VStack(alignment: .leading) {
                                    Text(displayName(a)).font(.headline)
                                    Text("Wants to receive your Sends · \(agentDetail(a, among: link.agentRequests.map(displayName) + s.approved.map(displayName)))").font(.subheadline).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Don't Allow") { link.decide(a.id, allow: false) }.buttonStyle(.bordered)
                                Button("Allow") { link.decide(a.id, allow: true) }.buttonStyle(.borderedProminent)
                            }
                        }
                        ForEach(s.approved) { a in
                            HStack {
                                agentIcon(displayName(a), color: a.color)
                                VStack(alignment: .leading) {
                                    Text(displayName(a)).font(.headline)
                                    Text(agentDetail(a, among: s.approved)).font(.subheadline).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .swipeActions {
                                Button("Revoke", role: .destructive) { link.decide(a.id, allow: false) }
                                Button("Rename") { renameDraft = displayName(a); renamingAgent = a.id }.tint(.blue)
                            }
                            .contextMenu {
                                Button("Rename", systemImage: "pencil") { renameDraft = displayName(a); renamingAgent = a.id }
                                Button("Revoke", systemImage: "hand.raised", role: .destructive) { link.decide(a.id, allow: false) }
                            }
                        }
                    } header: {
                        Text("Agents")
                    } footer: {
                        if !s.approved.isEmpty { Text("Swipe an Agent to rename or revoke it. A revoked Agent stops receiving Sends.") }
                    }
                }
                Section {
                    if !s.paired {
                        VStack(alignment: .leading, spacing: 10) {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 40)).foregroundStyle(Color.accentColor)
                            Text("Pair with your Mac").font(.title3.bold())
                            Text("On your Mac, run `reflex setup`. It shows a QR code. Scan it here once, and your Sends go to the Agents you allow.")
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 6)
                    }
                    // No camera: no Scan row at all, and typing the code is the way in.
                    if canScan {
                        Button { scanning = true } label: {
                            Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .accessibilityIdentifier("scan-button")
                    }
                    DisclosureGroup(canScan ? "Enter the code instead" : "Enter the pairing code", isExpanded: $typing) {
                        TextField("reflex://pair?…", text: $code, axis: .vertical)
                            .font(.system(.body, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .lineLimit(2 ... 6)
                            .accessibilityIdentifier("pair-code")
                        Button {
                            Task { await pair(code) }
                        } label: {
                            if busy { ProgressView() } else { Text("Pair") }
                        }
                        .disabled(busy || code.isEmpty)
                        .accessibilityIdentifier("pair-button")
                    }
                    .accessibilityIdentifier("type-code")
                } header: {
                    Text(s.paired ? "Pair a Different Mac" : "")
                } footer: {
                    Text(LocalizedStringKey((s.paired ? "Run `reflex pair` on the Mac for a new code." : "Pairing never approves an Agent by itself: each one asks first.")))
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("pair-error") }
                }
            }
            .navigationTitle(s.paired ? "Connection" : "Connect to Your Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $scanning) {
                QRScanner { found in
                    scanning = false
                    code = found
                    Task { await pair(found) }
                }
                .ignoresSafeArea()
            }
            .onAppear {
                // A code typed earlier stays until pairing works.
                if code.isEmpty, link.destinationKey == nil { code = UserDefaults.standard.string(forKey: "pairCodeDraft") ?? "" }
                if !code.isEmpty || !canScan { typing = true }
            }
            .onChange(of: code) { _, c in UserDefaults.standard.set(c, forKey: "pairCodeDraft") }
            .onChange(of: link.destinationKey) { _, k in if k != nil { UserDefaults.standard.removeObject(forKey: "pairCodeDraft") } }
            .alert("Rename Agent", isPresented: Binding(get: { renamingAgent != nil }, set: { if !$0 { renamingAgent = nil } })) {
                TextField("Name", text: $renameDraft).accessibilityIdentifier("rename-field")
                Button("Cancel", role: .cancel) {}
                Button("Rename") { if let id = renamingAgent { setNickname(id, renameDraft) } }
            } message: { Text("The name is only shown on this iPad.") }
        }
        .presentationSizing(.form)
    }

    private var stateDetail: String {
        switch link.state {
        case .connected:
            let path = link.activeTransport.map { $0 == "p2p" ? "peer-to-peer Wi-Fi" : $0 == "relay" ? "the Relay" : "Wi-Fi" } ?? "Wi-Fi"
            return "Connected over \(path)"
        case .connecting: return "Connecting…"
        case .offline: return "Not reachable right now. Sends wait here until it's back."
        case .linkChanged: return "Its pairing was reset. Scan its code again."
        case .unpaired: return "Not paired"
        }
    }

    private var nicknames: [String: String] { (try? JSONDecoder().decode([String: String].self, from: nicknamesData)) ?? [:] }

    private func setNickname(_ id: String, _ name: String) {
        var n = nicknames
        let t = name.trimmingCharacters(in: .whitespaces)
        n[id] = t.isEmpty ? nil : t
        nicknamesData = (try? JSONEncoder().encode(n)) ?? Data()
    }

    private func displayName(_ a: AgentInfo) -> String { nicknames[a.id] ?? a.name }
    private func displayName(_ a: AgentRequest) -> String { nicknames[a.id] ?? a.name }

    /// What tells this Agent apart: its colour, when it asked, and a short ID when two share a name.
    private func agentDetail(_ a: AgentInfo, among all: [AgentInfo]) -> String {
        agentDetail(id: a.id, name: displayName(a), color: a.color, at: a.requestedAt,
                    status: "Allowed", names: all.map(displayName))
    }
    private func agentDetail(_ a: AgentRequest, among names: [String]) -> String {
        agentDetail(id: a.id, name: displayName(a), color: a.color, at: a.requestedAt, status: nil, names: names)
    }
    private func agentDetail(id: String, name: String, color: String, at: Int64?, status: String?, names: [String]) -> String {
        var parts: [String] = status.map { [$0] } ?? []
        parts.append(color.capitalized)
        if let at {
            parts.append("asked " + Date(timeIntervalSince1970: Double(at) / 1000).formatted(.relative(presentation: .named)))
        }
        if names.filter({ $0 == name }).count > 1 {
            parts.append("ID " + String(id.suffix(4)).uppercased())
        }
        return parts.joined(separator: " · ")
    }

    private func agentIcon(_ name: String, color: String) -> some View {
        Text(String(name.prefix(1)).uppercased())
            .font(.headline).foregroundStyle(.white)
            .frame(width: 36, height: 36)
            .background(agentColor(color).gradient, in: Circle())
    }

    private func agentColor(_ name: String) -> Color {
        switch name {
        case "red": .red
        case "orange": .orange
        case "yellow": .yellow
        case "green": .green
        case "teal": .teal
        case "blue": .blue
        case "pink": .pink
        default: .purple
        }
    }

    private func pair(_ text: String) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await link.pair(code: text)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The camera, looking for a reflex://pair code.
struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        var done = false
        init(found: @escaping (String) -> Void) { self.found = found }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in items {
                if case .barcode(let b) = item, let s = b.payloadStringValue, s.hasPrefix("reflex://pair") || s.hasPrefix("reflex://invite"), !done {
                    done = true
                    scanner.stopScanning()
                    found(s)
                }
            }
        }
    }
}
