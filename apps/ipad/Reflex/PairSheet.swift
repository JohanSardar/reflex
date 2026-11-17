import ReflexLink
import SwiftUI

/// What the connection button says about the Mac and the approved Agents.
@MainActor struct LinkStatus {
    let link: LinkSync

    var paired: Bool { if case .unpaired = link.state { false } else { true } }
    var approved: [AgentInfo] { link.agents.values.filter { $0.status == "approved" }.sorted { $0.name < $1.name } }
    var macName: String {
        let live: String? = if case .connected(let n) = link.state { n } else { nil }
        return Self.shown(live) ?? Self.shown(link.pairedName) ?? "Your Mac"
    }

    /// The Mac's name as set in its System Settings ("Johan's MacBook Pro"). A network host name
    /// ("wirelessprv-10-195-187-74.near.illinois.edu", "Johans-MBP.local"), sent by Links from before the computer
    /// name was used, means nothing to the person and is never shown.
    static func shown(_ name: String?) -> String? {
        guard let n = name?.trimmingCharacters(in: .whitespaces), !n.isEmpty else { return nil }
        if n.wholeMatch(of: /[\w-]+(\.[\w-]+)+/) != nil || n.contains(/\d+-\d+-\d+-\d+/) { return nil }
        return n
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

    /// One line under the Mac's name: how it's connected, or why it isn't.
    var detail: String {
        switch link.state {
        case .connected:
            let path =
                link.activeTransport.map { $0 == "p2p" ? "peer-to-peer Wi-Fi" : $0 == "relay" ? "the Relay" : "Wi-Fi" }
                ?? "Wi-Fi"
            return "Connected over \(path)"
        case .connecting: return "Connecting…"
        case .offline: return "Not reachable right now. Sends wait here until it's back."
        case .linkChanged: return "Its pairing was reset. Ask your agent for a new code and type it below."
        case .unpaired: return "Not paired"
        }
    }

    /// What VoiceOver says for the connection button.
    var spoken: String {
        var parts = [headline]
        if case .connected = link.state { parts.append("connected") }
        if !approved.isEmpty { parts.append("agents \(approved.map(\.name).joined(separator: ", "))") }
        if link.pendingSends > 0 { parts.append("\(link.pendingSends) Sends waiting") }
        return parts.joined(separator: ", ")
    }
}

/// The connection button at the top right: a round glass button with a laptop and a status dot, like the other
/// top-bar buttons. Tapping it shows the Mac, its state and the Agents, with the full Connection sheet one tap on.
/// Before pairing it opens the pairing sheet straight away.
struct StatusCapsule: View {
    let link: LinkSync
    let action: () -> Void
    @State private var showing = false
    @State private var openSheet = false

    var body: some View {
        let s = LinkStatus(link: link)
        Button {
            if s.paired { showing = true } else { action() }
        } label: {
            LaptopGlyph()
                .frame(width: 44, height: 44)
                .overlay(alignment: .topTrailing) {
                    ZStack {
                        if case .connecting = link.state {
                            Circle().stroke(s.color.opacity(0.35), lineWidth: 3).frame(width: 15, height: 15)
                        }
                        Circle().fill(s.color.gradient).frame(width: 9, height: 9)
                            .overlay { Circle().stroke(.background, lineWidth: 2) }
                    }
                    .padding(.top, 9).padding(.trailing, 9)
                }
                .overlay(alignment: .bottomTrailing) {
                    // Sends saved here that the Mac hasn't taken yet, as the old capsule's "2 waiting" said.
                    if link.pendingSends > 0 {
                        Text("\(link.pendingSends)")
                            .font(.system(size: 11, weight: .bold)).monospacedDigit().foregroundStyle(.white)
                            .padding(.horizontal, 4).frame(minWidth: 16, minHeight: 16)
                            .background(.orange, in: Capsule())
                            .offset(x: 4, y: 4)
                    }
                }
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityIdentifier("connect-button")
        .accessibilityLabel("Mac connection")
        .accessibilityValue(s.spoken)
        .accessibilityHint(s.paired ? "Shows the Mac and its Agents" : "Pairs with your Mac")
        .popover(isPresented: $showing, arrowEdge: .top) {
            ConnectionPopover(link: link) {
                openSheet = true
                showing = false
            }
        }
        .onChange(of: showing) { _, now in
            // The sheet comes up once the popover is gone: one presentation at a time.
            if !now, openSheet {
                openSheet = false
                action()
            }
        }
    }
}

/// The button's laptop, drawn as an outline like the other top-bar icons (SF Symbols' laptop fills its screen).
private struct LaptopGlyph: View {
    var body: some View {
        VStack(spacing: 2.8) {
            RoundedRectangle(cornerRadius: 2.2, style: .continuous)
                .strokeBorder(lineWidth: 1.9)
                .frame(width: 17, height: 12)
            Capsule().frame(width: 22, height: 1.9)
        }
        .padding(.top, 1)
        .accessibilityHidden(true)
    }
}

/// What tapping the connection button shows: the Mac by its name, whether it's connected, and the Agents.
private struct ConnectionPopover: View {
    let link: LinkSync
    let manage: () -> Void
    @AppStorage("agentNicknames") private var nicknamesData = Data()

    var body: some View {
        let s = LinkStatus(link: link)
        let nicknames = (try? JSONDecoder().decode([String: String].self, from: nicknamesData)) ?? [:]
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "laptopcomputer").font(.title3).foregroundStyle(s.color)
                    .frame(width: 40, height: 40)
                    .background(s.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.macName).font(.headline).lineLimit(1)
                    Text(s.detail).font(.subheadline).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("connection-mac")
            .padding(.bottom, 10)
            if link.pendingSends > 0 {
                Label(
                    link.pendingSends == 1 ? "1 Send waiting" : "\(link.pendingSends) Sends waiting",
                    systemImage: "tray.full"
                )
                .font(.subheadline).foregroundStyle(.orange)
                .padding(.bottom, 10)
            }
            Text("Agents").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                .padding(.top, 4).padding(.bottom, 6)
            if s.approved.isEmpty && link.agentRequests.isEmpty {
                Text("No Agents yet.").font(.subheadline).foregroundStyle(.secondary).padding(.bottom, 6)
            }
            ForEach(link.agentRequests) { a in
                agentRow(nicknames[a.id] ?? a.name, color: a.color, note: "Asking")
            }
            ForEach(s.approved) { a in agentRow(nicknames[a.id] ?? a.name, color: a.color, note: nil) }
            Divider().padding(.vertical, 8)
            Button(action: manage) {
                HStack {
                    Text("Connection Settings")
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tint)
            .padding(.vertical, 4)
            .accessibilityHint("Rename or revoke Agents, or pair a Mac")
            .accessibilityIdentifier("connection-settings")
        }
        .padding(16)
        .frame(width: 320)
        .presentationCompactAdaptation(.popover)
    }

    private func agentRow(_ name: String, color: String, note: String?) -> some View {
        HStack(spacing: 10) {
            Text(String(name.prefix(1)).uppercased())
                .font(.subheadline.weight(.bold)).foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(agentColor(color).gradient, in: Circle())
            Text(name).lineLimit(1)
            Spacer(minLength: 0)
            if let note { Text(note).font(.caption.weight(.semibold)).foregroundStyle(.orange) }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

func agentColor(_ name: String) -> Color {
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
                                .frame(width: 44, height: 44).background(
                                    s.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.macName).font(.headline)
                                Text(s.detail).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Circle().fill(s.color).frame(width: 10, height: 10)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("mac-row")
                        if link.pendingSends > 0 {
                            HStack {
                                Label(
                                    link.pendingSends == 1
                                        ? "1 Send is waiting and goes out when \(s.macName) is back."
                                        : "\(link.pendingSends) Sends are waiting and go out when \(s.macName) is back.",
                                    systemImage: "tray.full"
                                )
                                .foregroundStyle(.orange)
                                Spacer()
                                if case .connected = link.state {
                                } else {
                                    Button("Retry Now") { link.retryNow() }.buttonStyle(.bordered)
                                }
                            }
                        }
                    }
                    Section {
                        if s.approved.isEmpty && link.agentRequests.isEmpty {
                            Text(
                                "No Agents yet. When an Agent on your Mac asks to receive your Sends, you'll be asked here to allow it."
                            )
                            .foregroundStyle(.secondary)
                        }
                        ForEach(link.agentRequests) { a in
                            HStack {
                                agentIcon(displayName(a), color: a.color)
                                VStack(alignment: .leading) {
                                    Text(displayName(a)).font(.headline)
                                    Text(
                                        "Wants to receive your Sends · \(agentDetail(a, among: link.agentRequests.map(displayName) + s.approved.map(displayName)))"
                                    ).font(.subheadline).foregroundStyle(.secondary)
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
                                    Text(agentDetail(a, among: s.approved)).font(.subheadline).foregroundStyle(
                                        .secondary)
                                }
                                Spacer()
                            }
                            .swipeActions {
                                Button("Revoke", role: .destructive) { link.decide(a.id, allow: false) }
                                Button("Rename") {
                                    renameDraft = displayName(a)
                                    renamingAgent = a.id
                                }.tint(.blue)
                            }
                            .contextMenu {
                                Button("Rename", systemImage: "pencil") {
                                    renameDraft = displayName(a)
                                    renamingAgent = a.id
                                }
                                Button("Revoke", systemImage: "hand.raised", role: .destructive) {
                                    link.decide(a.id, allow: false)
                                }
                            }
                        }
                    } header: {
                        Text("Agents")
                    } footer: {
                        if !s.approved.isEmpty {
                            Text("Swipe an Agent to rename or revoke it. A revoked Agent stops receiving Sends.")
                        }
                    }
                }
                Section {
                    if !s.paired {
                        VStack(alignment: .leading, spacing: 10) {
                            Image("Logo").resizable().frame(width: 56, height: 56).clipShape(
                                .rect(cornerRadius: 13, style: .continuous)
                            ).accessibilityHidden(true)
                            Text("Pair with your Mac").font(.title3.bold())
                            Text(
                                "Ask your agent on the Mac to connect your iPad. It gives you a 6-digit code: type it here."
                            )
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
                    Text(
                        "Your iPad looks for the Mac on this Wi-Fi and nearby, then through the relay, so the Mac can be anywhere. Typing the code also lets in the agent that gave it to you."
                    )
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
                if code.hasPrefix("reflex://") {
                    let c = code
                    code = ""
                    Task { await pair(c) }
                } else {
                    code = digitsOnly(code)
                }
            }
            .alert(
                "Rename Agent",
                isPresented: Binding(get: { renamingAgent != nil }, set: { if !$0 { renamingAgent = nil } })
            ) {
                TextField("Name", text: $renameDraft).accessibilityIdentifier("rename-field")
                Button("Cancel", role: .cancel) {}
                Button("Rename") { if let id = renamingAgent { setNickname(id, renameDraft) } }
            } message: {
                Text("The name is only shown on this iPad.")
            }
        }
        .presentationSizing(.form)
    }

    private var nicknames: [String: String] {
        (try? JSONDecoder().decode([String: String].self, from: nicknamesData)) ?? [:]
    }

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
        agentDetail(
            id: a.id, name: displayName(a), color: a.color, at: a.requestedAt,
            status: "Allowed", names: all.map(displayName))
    }
    private func agentDetail(_ a: AgentRequest, among names: [String]) -> String {
        agentDetail(id: a.id, name: displayName(a), color: a.color, at: a.requestedAt, status: nil, names: names)
    }
    private func agentDetail(id: String, name: String, color: String, at: Int64?, status: String?, names: [String])
        -> String
    {
        var parts: [String] = status.map { [$0] } ?? []
        parts.append(color.capitalized)
        if let at {
            parts.append(
                "asked " + Date(timeIntervalSince1970: Double(at) / 1000).formatted(.relative(presentation: .named)))
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
