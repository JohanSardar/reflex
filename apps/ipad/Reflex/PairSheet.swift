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
                Text(compact ? shortHeadline(s) : s.headline).lineLimit(1)
                if !compact, s.paired, !s.approved.isEmpty {
                    Text("·").foregroundStyle(.secondary)
                    Text(s.approved.prefix(2).map(\.name).joined(separator: ", ") + (s.approved.count > 2 ? " +\(s.approved.count - 2)" : ""))
                        .foregroundStyle(.secondary).lineLimit(1)
                }
                if link.pendingSends > 0 {
                    Text("\(link.pendingSends) waiting")
                        .font(.system(size: 12, weight: .semibold))
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(.orange.opacity(0.18), in: Capsule())
                        .foregroundStyle(.orange)
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
        case .unpaired: "Pair"
        case .offline: "Offline"
        case .connecting: "Connecting"
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
                            Label("\(link.pendingSends) \(link.pendingSends == 1 ? "Send is" : "Sends are") saved here and go out when \(s.macName) is back.", systemImage: "tray.full")
                                .foregroundStyle(.orange)
                        }
                    }
                    Section {
                        if s.approved.isEmpty && link.agentRequests.isEmpty {
                            Text("No Agents yet. When an Agent on your Mac asks to receive your Sends, you'll be asked here to allow it.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(link.agentRequests) { a in
                            HStack {
                                agentIcon(a.name, color: a.color)
                                VStack(alignment: .leading) {
                                    Text(a.name).font(.headline)
                                    Text("Wants to receive your Sends").font(.subheadline).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Don't Allow") { link.decide(a.id, allow: false) }.buttonStyle(.bordered)
                                Button("Allow") { link.decide(a.id, allow: true) }.buttonStyle(.borderedProminent)
                            }
                        }
                        ForEach(s.approved) { a in
                            HStack {
                                agentIcon(a.name, color: a.color)
                                VStack(alignment: .leading) {
                                    Text(a.name).font(.headline)
                                    Text("Allowed").font(.subheadline).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .swipeActions {
                                Button("Revoke", role: .destructive) { link.decide(a.id, allow: false) }
                            }
                            .contextMenu {
                                Button("Revoke", systemImage: "hand.raised", role: .destructive) { link.decide(a.id, allow: false) }
                            }
                        }
                    } header: {
                        Text("Agents")
                    } footer: {
                        if !s.approved.isEmpty { Text("Swipe an Agent to revoke it. A revoked Agent stops receiving Sends.") }
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
                    Button { scanning = true } label: {
                        Label(canScan ? "Scan QR Code" : "Scan QR Code (needs a camera)", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .disabled(!canScan)
                    .accessibilityIdentifier("scan-button")
                    DisclosureGroup("Enter the code instead", isExpanded: $typing) {
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
                    Text(s.paired ? "Run `reflex pair` on the Mac for a new code." : "Pairing never approves an Agent by itself: each one asks first.")
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
            .onAppear { if !code.isEmpty { typing = true } }
        }
        .presentationDetents([.medium, .large])
    }

    private var stateDetail: String {
        switch link.state {
        case .connected:
            let path = link.activeTransport.map { $0 == "p2p" ? "peer-to-peer Wi-Fi" : $0 == "relay" ? "the Relay" : "Wi-Fi" } ?? "Wi-Fi"
            return "Connected over \(path)"
        case .connecting: return "Connecting…"
        case .offline: return "Not reachable right now. Sends wait here until it's back."
        case .linkChanged: return "Its Link was reset. Scan its code again."
        case .unpaired: return "Not paired"
        }
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
