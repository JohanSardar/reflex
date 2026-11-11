import CoreImage.CIFilterBuiltins
import ReflexLink
import ReflexRender
import SwiftUI

/// Sharing a Space (ADR-0008): its owner invites people as editors or viewers
/// with a single-use invite (a QR code and the same code as text), changes their
/// role, or removes them. Someone it was shared with sees whose it is and what
/// they may do.
struct ShareSheet: View {
    let link: LinkSync
    let space: String
    @State private var role = "editor"
    @Environment(\.dismiss) private var dismiss

    private var share: ShareInfo? { link.shares[space] }
    private var mine: Bool { link.role(space) == "owner" }

    var body: some View {
        NavigationStack {
            Form {
                if mine {
                    Section {
                        Picker("Invite as", selection: $role) {
                            Text("Editor: draws and sends").tag("editor")
                            Text("Viewer: only looks").tag("viewer")
                        }
                        .accessibilityIdentifier("invite-role")
                        Button("Make an invite") { link.createInvite(space, role: role) }
                            .accessibilityIdentifier("invite-make")
                        if let inv = link.invite, inv.space == space {
                            VStack(alignment: .leading, spacing: 12) {
                                if let qr = QR.image(inv.uri) {
                                    Image(uiImage: qr).interpolation(.none).resizable().scaledToFit().frame(width: 220, height: 220)
                                        .accessibilityLabel("Invite QR code")
                                }
                                Text("Invite as \(inv.role == "editor" ? "an editor" : "a viewer"). They open it on their iPad, or paste it in Connect. Single use, 24 hours.")
                                    .font(.callout).foregroundStyle(.secondary)
                                Text(inv.uri).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                                    .accessibilityIdentifier("invite-code")
                                HStack {
                                    Button("Copy") { UIPasteboard.general.string = inv.uri }
                                    ShareLink(item: inv.uri) { Label("Send", systemImage: "square.and.arrow.up") }
                                }
                            }
                        }
                    } header: {
                        Text("Invite someone")
                    }
                } else if let share {
                    Section {
                        Text(share.role == nil ? "\(share.owner.name) removed you from this Space. You keep what you had; nothing new arrives."
                            : "\(share.owner.name)'s Space. You can \(share.role == "editor" ? "draw and send" : "look, but not draw").")
                            .accessibilityIdentifier("share-role")
                    }
                }
                Section("People") {
                    Label("\(share?.owner.name ?? link.person?.name ?? "You") · owner", systemImage: "person.crop.circle.fill")
                    ForEach(share?.members ?? []) { m in
                        HStack {
                            Label(m.person.name, systemImage: "person.crop.circle")
                            Spacer()
                            if mine {
                                Menu(m.role == "editor" ? "Editor" : "Viewer") {
                                    Button("Editor") { link.setMember(space, person: m.person.id, role: "editor") }
                                    Button("Viewer") { link.setMember(space, person: m.person.id, role: "viewer") }
                                    Divider()
                                    Button("Remove from this Space", role: .destructive) { link.setMember(space, person: m.person.id, role: "remove") }
                                }
                                .accessibilityIdentifier("member-\(m.person.name)")
                            } else {
                                Text(m.role == "editor" ? "Editor" : "Viewer").foregroundStyle(.secondary)
                            }
                        }
                    }
                    if share?.members.isEmpty ?? true { Text("Only you so far.").foregroundStyle(.secondary) }
                }
                if let e = link.shareError {
                    Section { Text(e).foregroundStyle(.red).accessibilityIdentifier("share-error") }
                }
            }
            .navigationTitle("Share \(space)")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }
}

enum QR {
    static func image(_ text: String) -> UIImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage, let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// A person's color, the same on every device for the same person.
func personColor(_ id: String) -> Color {
    let palette: [Color] = [.purple, .teal, .blue, .orange, .pink, .green]
    let n = id.unicodeScalars.reduce(UInt32(7)) { $0 &* 31 &+ $1.value }
    return palette[Int(n % UInt32(palette.count))]
}

/// Who else is in this Space now, by name.
struct HereChips: View {
    let people: [HereEntry]

    var body: some View {
        let byPerson = Dictionary(grouping: people, by: \.person.id)
        HStack(spacing: 6) {
            ForEach(byPerson.keys.sorted(), id: \.self) { id in
                let p = byPerson[id]!.first!.person
                Text(p.name.isEmpty ? id : p.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10).frame(height: 28)
                    .background(personColor(id), in: Capsule())
                    .accessibilityIdentifier("here-\(p.name)")
            }
        }
    }
}

/// Other people's cursors and selections, where they are in the Space.
struct HereOverlay: View {
    let people: [HereEntry]
    let scene: SceneDocument
    let offset: CGPoint
    let zoom: CGFloat

    var body: some View {
        let frames = Dictionary(scene.elements.compactMap { e in e.frame.map { (e.id, $0) } }, uniquingKeysWith: { a, _ in a })
        ZStack(alignment: .topLeading) {
            ForEach(people) { h in
                let color = personColor(h.person.id)
                ForEach(h.selection, id: \.self) { id in
                    if let f = frames[id] {
                        RoundedRectangle(cornerRadius: 6).stroke(color, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                            .frame(width: f.width * zoom + 8, height: f.height * zoom + 8)
                            .offset(x: f.minX * zoom - offset.x - 4, y: f.minY * zoom - offset.y - 4)
                    }
                }
                if let c = h.cursor {
                    HStack(alignment: .top, spacing: 4) {
                        Circle().fill(color).frame(width: 14, height: 14).overlay(Circle().stroke(.white, lineWidth: 2))
                        Text(h.person.name.isEmpty ? h.person.id : h.person.name)
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(color, in: Capsule())
                            .offset(y: 8)
                    }
                    .fixedSize()
                    .offset(x: c.x * zoom - offset.x - 7, y: c.y * zoom - offset.y - 7)
                    .accessibilityIdentifier("cursor-\(h.person.name)")
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .allowsHitTesting(false)
    }
}
