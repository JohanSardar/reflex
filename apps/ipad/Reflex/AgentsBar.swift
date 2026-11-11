import ReflexLink
import ReflexRender
import SwiftUI

/// One chip per Agent that changed this Space, in its color. Tapping it offers
/// to revert that Agent's last change; the clock opens the Space's history.
struct AgentsBar: View {
    let session: SpaceSession
    let link: LinkSync
    @Binding var showHistory: Bool

    var body: some View {
        HStack(spacing: 8) {
            ForEach(session.agentsHere, id: \.self) { agent in
                let info = link.agents[agent]
                let name = info?.name ?? agent
                Menu {
                    if let last = session.lastChange(of: agent) {
                        Text(History.describe(last, link: link, person: link.person?.id))
                        Button(role: .destructive) { session.revert(agent, name: name) } label: {
                            Label("Revert \(Self.short(name))'s last change", systemImage: "arrow.uturn.backward.circle")
                        }
                        .accessibilityIdentifier("revert-\(agent)")
                    } else {
                        Text("Nothing of \(Self.short(name))'s to revert")
                    }
                    Button { showHistory = true } label: { Label("History", systemImage: "clock") }
                } label: {
                    HStack(spacing: 6) {
                        Circle().fill(Palette.color(info?.color ?? "violet")).frame(width: 12, height: 12)
                        Text(Self.short(name)).lineLimit(1)
                    }
                    .font(.system(size: 14, weight: .medium))
                    .padding(.horizontal, 12).frame(height: 40)
                    .glassEffect()
                }
                .accessibilityIdentifier("agent-chip-\(agent)")
                .accessibilityLabel("\(name): revert or history")
            }
            Button { showHistory = true } label: {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 16, weight: .medium))
                    .frame(width: 40, height: 40)
                    .glassEffect()
            }
            .accessibilityIdentifier("history-button")
            .accessibilityLabel("History")
        }
    }

    /// "Claude Code · reflex repo" shows as "Claude Code".
    nonisolated static func short(_ name: String) -> String {
        name.components(separatedBy: " · ").first ?? name
    }
}

/// The Space's history: who did what, newest first.
struct HistorySheet: View {
    let session: SpaceSession
    let link: LinkSync
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                let rows = Array(session.timeline.reversed().enumerated())
                if rows.isEmpty { Text("Nothing has happened in this Space yet.").foregroundStyle(.secondary) }
                ForEach(rows, id: \.offset) { _, entry in
                    let agent = (entry["by"] as? [String: Any])?["agent"] as? String
                    let latest = agent.flatMap { session.lastChange(of: $0)?["batch"] as? String } == entry["batch"] as? String
                    HistoryRow(entry: entry, link: link, person: link.person?.id, timeline: session.timeline, latest: latest) { agent, name in
                        session.revert(agent, name: name)
                    }
                    .opacity(History.isUndone(entry) ? 0.45 : 1)
                }
            }
            .navigationTitle("History of \(session.id)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .accessibilityIdentifier("history-sheet")
    }
}

struct HistoryRow: View {
    let entry: [String: Any]
    let link: LinkSync
    let person: String?
    let timeline: [[String: Any]]
    /// Whether this is its Agent's latest change, the one its chip reverts.
    let latest: Bool
    let revert: (String, String) -> Void

    var body: some View {
        let by = entry["by"] as? [String: Any] ?? [:]
        let agent = by["agent"] as? String
        let info = agent.flatMap { link.agents[$0] }
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(agent != nil ? Palette.color(info?.color ?? "violet") : Color.gray)
                .frame(width: 12, height: 12).padding(.top, 5)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(History.who(entry, link: link, person: person)).font(.headline)
                    Text(History.state(entry)).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text(History.when(entry)).font(.caption).foregroundStyle(.secondary)
                }
                Text(History.describe(entry, link: link, person: person, timeline: timeline)).font(.callout).foregroundStyle(.secondary)
            }
            if let agent, latest, entry["kind"] as? String == "batch" {
                Button("Revert") { revert(agent, info?.name ?? agent) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("history-revert-\(agent)")
            }
        }
    }
}

/// Words for timeline entries (the kernel's `timeline`).
@MainActor
enum History {
    static func who(_ e: [String: Any], link: LinkSync, person: String?) -> String {
        let by = e["by"] as? [String: Any] ?? [:]
        if let a = by["agent"] as? String { return link.agents[a]?.name ?? a }
        if let p = by["person"] as? String { return p == person ? "You" : p }
        return "Someone"
    }

    static func isUndone(_ e: [String: Any]) -> Bool {
        ["undone", "abandoned", "reverted"].contains(e["state"] as? String ?? "")
    }

    static func state(_ e: [String: Any]) -> String {
        switch e["state"] as? String {
        case "reverted": return "reverted"
        case "undone", "abandoned": return "undone"
        default: return ""
        }
    }

    static func when(_ e: [String: Any]) -> String {
        guard let at = e["at"] as? Double ?? (e["at"] as? Int).map(Double.init) else { return "" }
        return Date(timeIntervalSince1970: at / 1000).formatted(date: .omitted, time: .shortened)
    }

    /// "added n-auth, moved n-db" or "drew a stroke".
    static func describe(_ e: [String: Any], link: LinkSync, person: String?, timeline: [[String: Any]] = []) -> String {
        let kind = e["kind"] as? String ?? ""
        let changes = e["changes"] as? [[String: Any]] ?? []
        let ids = (e["ids"] as? [String] ?? []).map(label)
        switch kind {
        case "add_stroke": return "drew a stroke"
        case "erase": return "erased \(count(ids.count, "stroke"))"
        case "erase_precise": return "erased part of a stroke"
        case "revert":
            let batch = timeline.first { $0["batch"] as? String == e["batch"] as? String && $0["kind"] as? String == "batch" }
            let agent = (batch?["by"] as? [String: Any])?["agent"] as? String
            let name = agent.map { link.agents[$0]?.name ?? $0 } ?? "an Agent"
            return "reverted \(AgentsBar.short(name))'s change" + (ids.isEmpty ? "" : ": " + ids.prefix(4).joined(separator: ", "))
        case "add_file": return "added a file"
        case "add": return "added " + ids.prefix(3).joined(separator: ", ")
        case "move": return "moved " + ids.prefix(3).joined(separator: ", ")
        case "patch": return "changed " + ids.prefix(3).joined(separator: ", ")
        default: break
        }
        if changes.isEmpty { return kind == "batch" ? "changed nothing" : kind.replacingOccurrences(of: "_", with: " ") }
        var parts: [String] = []
        for c in changes.prefix(5) {
            let id = label(c["id"] as? String ?? "")
            switch c["kind"] as? String {
            case "added": parts.append("added \(c["type"] as? String ?? "") \(id)")
            case "removed": parts.append("removed \(id)")
            case "moved": parts.append("moved \(id)")
            case "resized": parts.append("resized \(id)")
            case "edited": parts.append("edited \(id)")
            default: parts.append("\(c["kind"] as? String ?? "changed") \(id)")
            }
        }
        if changes.count > 5 { parts.append("and \(changes.count - 5) more") }
        return parts.joined(separator: ", ")
    }

    /// An Agent's Element ids carry the Agent ("a_cbea6b8f86/n-cache", or
    /// "a_cbea6b8f86:n-cache" in a revert); people read the last part.
    private static func label(_ id: String) -> String {
        guard id.hasPrefix("a_"), let cut = id.firstIndex(where: { $0 == "/" || $0 == ":" }) else { return id }
        return String(id[id.index(after: cut)...])
    }

    private static func count(_ n: Int, _ noun: String) -> String { "\(n) \(noun)\(n == 1 ? "" : "s")" }
}
