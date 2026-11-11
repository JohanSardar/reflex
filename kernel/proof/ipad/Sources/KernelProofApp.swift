// The Swift replica of the proof Space, calling the Rust kernel through UniFFI.
//
// It keeps its replica in the app's Documents folder, so closing and reopening
// the app is a real restart, and syncs with the Node hub (kernel/proof/node)
// over the kernel's sync protocol.
import ReflexKernel
import SwiftUI

@main
struct KernelProofApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct Row: Identifiable {
    let id: String
    let type: String
    let by: String
    let text: String
    let bounds: [Double]
    let points: [[Double]]
    let from: String?
    let to: String?
}

@MainActor
final class Model: ObservableObject {
    static let hub = URL(string: "http://127.0.0.1:7311")!
    let person = "p_ana"
    let device = "ipad-sim"
    let actor = "697061642d73696d" // "ipad-sim": this replica's actor, kept across restarts
    let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("proof.automerge")

    @Published var rows: [Row] = []
    @Published var digest = ""
    @Published var headCount = 0
    @Published var log: [String] = []
    private var space: Space
    private var strokeCount = 0

    init() {
        if let bytes = try? Data(contentsOf: file), let s = try? Space.load(bytes: bytes, actorHex: actor) {
            space = s
            log = ["Loaded replica from disk (\(bytes.count) bytes)"]
        } else {
            space = try! Space.create(spaceId: "proof", kind: "space", actorHex: actor)
            log = ["Created a new replica of Space 'proof'"]
        }
        refresh()
    }

    private var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private func note(_ s: String) {
        log.insert(s, at: 0)
        if log.count > 8 { log.removeLast() }
    }

    func persist() {
        try? space.save().write(to: file, options: .atomic)
    }

    func refresh() {
        digest = space.digest()
        headCount = ((try? JSONSerialization.jsonObject(with: Data(space.heads().utf8))) as? [Any])?.count ?? 0
        guard let json = try? space.scene(queryJson: "{}"),
              let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let els = obj["elements"] as? [[String: Any]] else { return }
        rows = els.map { e in
            let by = (e["by"] as? [String: String]).map { $0.map { "\($0.key):\($0.value)" }.joined() } ?? "?"
            let pts = ((e["stroke"] as? [String: Any])?["points"] as? [[Double]]) ?? []
            return Row(id: e["id"] as? String ?? "", type: e["type"] as? String ?? "", by: by,
                       text: e["text"] as? String ?? "", bounds: (e["bounds"] as? [Double]) ?? [0, 0, 0, 0],
                       points: pts, from: e["from"] as? String, to: e["to"] as? String)
        }
    }

    private func intent(_ json: String) {
        do {
            let r = try space.applyUserIntent(person: person, device: device, intentJson: json, nowMs: now)
            note("intent → \(r.prefix(90))")
        } catch {
            note("intent failed: \(error)")
        }
        persist()
        refresh()
    }

    /// Ana's edits, made while the iPad is not syncing: a text insert on the
    /// Agent's node, an erase, and a finished stroke.
    func anaEdits() {
        intent(#"{"intent":"patch","id":"claude/n-auth","text_insert":{"at":0,"text":"New "}}"#)
        intent(#"{"intent":"erase","ids":["claude/n-cache"]}"#)
        drawStroke()
    }

    func drawStroke() {
        strokeCount += 1
        let id = "stroke-\(device)-\(now)"
        let x = 80 + strokeCount * 40
        intent(#"{"intent":"add_stroke","id":"\#(id)","stroke":{"points":[[\#(x),420],[\#(x + 30),470],[\#(x + 70),430],[\#(x + 90),480]],"width":4}}"#)
    }

    func roundTwo() {
        intent(#"{"intent":"move","ids":["claude/e1","claude/n-db"],"by":[40,0]}"#)
    }

    func undo() {
        do {
            note("undo → \(try space.undo(person: person, device: device, nowMs: now).prefix(90))")
        } catch {
            note("undo failed: \(error)")
        }
        persist()
        refresh()
    }

    func send() {
        let raw = #"{"send":"s-\#(now)","trigger":"button","said":"look at these"}"#
        do {
            let r = try space.freezeSend(person: person, device: device, rawJson: raw, nowMs: now)
            let strokes = ((try? JSONSerialization.jsonObject(with: Data(r.utf8))) as? [String: Any])?["strokes"] as? [Any]
            note("send frozen, \(strokes?.count ?? 0) strokes claimed")
        } catch {
            note("send failed: \(error)")
        }
        persist()
        refresh()
    }

    private func post(_ path: String, _ body: Data) async throws -> (Int, Data) {
        var req = URLRequest(url: Self.hub.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.httpBody = body
        let (data, resp) = try await URLSession.shared.data(for: req)
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    /// Sync with the hub: send our sync message, take its reply, until both are quiet.
    func sync() async {
        do {
            space.resetSync(peer: "hub")
            _ = try await post("reset/ipad", Data())
            var rounds = 0
            while rounds < 50 {
                rounds += 1
                let out = space.syncMessage(peer: "hub")
                let (status, data) = try await post("sync/ipad", out ?? Data())
                if status == 200 { try space.receiveSyncMessage(peer: "hub", msg: data) }
                if out == nil && status == 204 { break }
            }
            persist()
            refresh()
            note("synced with hub in \(rounds) rounds")
        } catch {
            note("sync failed: \(error)")
        }
    }
}

struct SceneCanvas: View {
    let rows: [Row]
    var body: some View {
        Canvas { ctx, _ in
            let byId = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            func rect(_ r: Row) -> CGRect { CGRect(x: r.bounds[0], y: r.bounds[1], width: r.bounds[2], height: r.bounds[3]) }
            for r in rows where r.type == "connector" {
                guard let f = r.from.flatMap({ byId[$0] }), let t = r.to.flatMap({ byId[$0] }) else { continue }
                var p = Path()
                p.move(to: CGPoint(x: rect(f).midX, y: rect(f).midY))
                p.addLine(to: CGPoint(x: rect(t).midX, y: rect(t).midY))
                ctx.stroke(p, with: .color(.gray), lineWidth: 2)
            }
            for r in rows {
                switch r.type {
                case "shape", "note":
                    let path = RoundedRectangle(cornerRadius: 10).path(in: rect(r))
                    ctx.fill(path, with: .color(r.type == "note" ? .yellow.opacity(0.35) : .blue.opacity(0.12)))
                    ctx.stroke(path, with: .color(r.type == "note" ? .orange : .blue), lineWidth: 2)
                    ctx.draw(Text(r.text).font(.system(size: 15, weight: .medium)), at: CGPoint(x: rect(r).midX, y: rect(r).midY))
                case "ink":
                    var p = Path()
                    for (i, pt) in r.points.enumerated() where pt.count >= 2 {
                        let c = CGPoint(x: pt[0], y: pt[1])
                        if i == 0 { p.move(to: c) } else { p.addLine(to: c) }
                    }
                    ctx.stroke(p, with: .color(.red), style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
                default:
                    break
                }
            }
        }
    }
}

struct ContentView: View {
    @StateObject private var m = Model()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Reflex kernel · Swift replica").font(.title2.bold())
                Spacer()
                Text("digest \(String(m.digest.prefix(12)))").font(.system(.title3, design: .monospaced)).accessibilityIdentifier("digest")
                Text("· \(m.rows.count) elements · \(m.headCount) head(s)").foregroundStyle(.secondary)
            }
            HStack {
                Button("Sync") { Task { await m.sync() } }.accessibilityIdentifier("sync")
                Button("Ana edits") { m.anaEdits() }.accessibilityIdentifier("ana-edits")
                Button("Draw stroke") { m.drawStroke() }.accessibilityIdentifier("draw")
                Button("Move e1 + n-db") { m.roundTwo() }.accessibilityIdentifier("round-two")
                Button("Undo") { m.undo() }.accessibilityIdentifier("undo")
                Button("Send") { m.send() }.accessibilityIdentifier("send")
            }
            .buttonStyle(.borderedProminent)
            SceneCanvas(rows: m.rows)
                .frame(maxWidth: .infinity, minHeight: 360, maxHeight: 520)
                .background(Color(white: 0.97))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(m.rows) { r in
                        Text("\(r.id)  \(r.type)  by \(r.by)  \(r.text.isEmpty ? "" : "“\(r.text)”")  \(r.bounds.map { String(Int($0)) }.joined(separator: ","))")
                            .font(.system(.footnote, design: .monospaced))
                    }
                    Divider()
                    ForEach(Array(m.log.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(24)
    }
}
