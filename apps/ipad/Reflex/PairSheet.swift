import ReflexLink
import SwiftUI

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
        case .linkChanged: "Pair again with a new code"
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
        case .linkChanged: "Pair again"
        case .connected: s.macName
        }
    }
}

/// Pairing and approvals: the Mac, the Agents, and pairing a Mac by typing the 6-digit code an Agent gives
/// (its `connect` tool) or `reflex pair` shows.
struct PairSheet: View {
    let link: LinkSync
    @State var code: String
    @State private var busy = false
    @State private var error: String?
    @State private var renamingAgent: String?
    @State private var renameDraft = ""
    @AppStorage("agentNicknames") private var nicknamesData = Data()
    @Environment(\.dismiss) private var dismiss

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
                            Image("Logo").resizable().frame(width: 56, height: 56).clipShape(.rect(cornerRadius: 13, style: .continuous)).accessibilityHidden(true)
                            Text("Pair with your Mac").font(.title3.bold())
                            Text("Ask your agent on the Mac to connect your iPad. It gives you a 6-digit code: type it here.")
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 6)
                    }
                    HStack(spacing: 12) {
                        TextField("000 000", text: Binding(get: { spaced(code) }, set: { code = digitsOnly($0) }))
                            .font(.system(size: 34, weight: .semibold, design: .monospaced))
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("pair-code")
                            .onChange(of: code) { _, c in if c.count == 6, !busy { Task { await pair(c) } } }
                        Button {
                            Task { await pair(code) }
                        } label: {
                            if busy { ProgressView() } else { Text("Pair") }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy || code.count != 6)
                        .accessibilityIdentifier("pair-button")
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text(s.paired ? "Pair Again or Another Mac" : "Pairing Code")
                } footer: {
                    Text("Your iPad looks for the Mac on this Wi-Fi, and nearby. Typing the code also lets in the agent that gave it to you.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("pair-error") }
                }
            }
            .navigationTitle(s.paired ? "Connection" : "Connect to Your Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear {
                // A pasted or opened reflex://pair link pairs straight away; a stray value is cleared.
                if code.hasPrefix("reflex://") { let c = code; code = ""; Task { await pair(c) } }
                else { code = digitsOnly(code) }
            }
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
        case .linkChanged: return "Its pairing was reset. Ask your agent for a new code and type it below."
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
            code = ""
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func digitsOnly(_ s: String) -> String { String(s.filter { $0.isASCII && $0.isNumber }.prefix(6)) }
    private func spaced(_ d: String) -> String { d.count > 3 ? "\(d.prefix(3)) \(d.dropFirst(3))" : d }
}
