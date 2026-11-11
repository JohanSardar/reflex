import CryptoKit
import Foundation
import Network
import Observation
import OSLog
import ReflexKernel

let linkLog = Logger(subsystem: "si.eilmer.reflex", category: "link")

/// An Agent waiting for the person to approve it, sent by the Link.
public struct AgentRequest: Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var color: String
}

/// An Agent the Link knows: its name and color, for its chip and the history.
public struct AgentInfo: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    /// A named protocol color.
    public var color: String
    public var status: String
}

/// The iPad's replicas of every Space, kept in the Rust kernel (through
/// UniFFI), saved on this iPad, and in sync with the paired Link over the
/// local network (ARCHITECTURE §1, §8).
///
/// Messages after the handshake are the Link coordinator's
/// (`link/sync/coordinator.ts`): `spaces`, `sync` (one Automerge sync
/// conversation per Space), `assets_have` / `asset_want` / `asset`,
/// `ping` / `pong`, and `agent_request` / `agent_decision`.
@MainActor @Observable
public final class LinkSync {
    public enum State: Equatable {
        case unpaired
        case connecting
        case connected(String)
        case offline(String)
    }

    public private(set) var state: State = .unpaired
    /// Spaces this iPad holds, by ID, not counting the Library.
    public private(set) var spaces: [String] = []
    /// Bumps each time a Space changes, from here or from the Link.
    public private(set) var revision: [String: Int] = [:]
    public private(set) var agentRequests: [AgentRequest] = []
    /// Every Agent the Link knows, by ID (sent by the Link, kept for offline use).
    public private(set) var agents: [String: AgentInfo] = [:]
    /// Bumps each time an asset arrives from the Link, so images waiting for it draw.
    public private(set) var assetRevision = 0
    public private(set) var person: Person?
    public var deviceID: String { identity.device }

    @ObservationIgnored private var identity: DeviceIdentity
    @ObservationIgnored private var actor: String
    @ObservationIgnored private var paired: Paired?
    @ObservationIgnored private var replicas: [String: Space] = [:]
    @ObservationIgnored private var session: Session?
    @ObservationIgnored private var browser: NWBrowser?
    @ObservationIgnored private var discovered: NWEndpoint?
    @ObservationIgnored private var dialing = false
    /// Assets arriving in parts from the Link, by hash.
    @ObservationIgnored private var incoming: [String: (size: Int, data: Data)] = [:]

    struct Paired: Codable {
        var device: String
        var key: String
        var name: String
        var person: Person
        var hosts: [String]
        var port: UInt16
    }

    private struct Saved: Codable {
        var key: String
        var actor: String
        var name: String
        var person: Person?
    }

    private static let root = URL.applicationSupportDirectory.appending(path: "Reflex", directoryHint: .isDirectory)
    private static let linkDir = root.appending(path: "Link", directoryHint: .isDirectory)
    private static let spacesDir = root.appending(path: "Spaces", directoryHint: .isDirectory)
    private static let assetsDir = root.appending(path: "Assets", directoryHint: .isDirectory)

    public init(deviceName: String) {
        let fm = FileManager.default
        for d in [Self.linkDir, Self.spacesDir, Self.assetsDir] { try? fm.createDirectory(at: d, withIntermediateDirectories: true) }
        let idURL = Self.linkDir.appending(path: "identity.json")
        let saved = (try? Data(contentsOf: idURL)).flatMap { try? JSONDecoder().decode(Saved.self, from: $0) }
        if let saved, let raw = B64.decode(saved.key), let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw) {
            identity = DeviceIdentity(key: key, person: saved.person ?? Person(id: "p_unpaired", name: ""), name: saved.name)
            actor = saved.actor
            person = saved.person
        } else {
            let key = Curve25519.Signing.PrivateKey()
            actor = Data((0 ..< 16).map { _ in UInt8.random(in: 0 ... 255) }).hex
            identity = DeviceIdentity(key: key, person: Person(id: "p_unpaired", name: ""), name: deviceName)
            Self.writeSecret(Saved(key: B64.encode(key.rawRepresentation), actor: actor, name: deviceName, person: nil), to: idURL)
        }
        paired = (try? Data(contentsOf: Self.linkDir.appending(path: "paired.json"))).flatMap { try? JSONDecoder().decode(Paired.self, from: $0) }
        agents = (try? Data(contentsOf: Self.linkDir.appending(path: "agents.json"))).flatMap { try? JSONDecoder().decode([String: AgentInfo].self, from: $0) } ?? [:]
        loadReplicas()
        if paired != nil {
            state = .connecting
            browse()
            reconnectSoon(after: 0)
        }
    }

    // MARK: Spaces

    private func loadReplicas() {
        let dirs = (try? FileManager.default.contentsOfDirectory(at: Self.spacesDir, includingPropertiesForKeys: nil)) ?? []
        for dir in dirs {
            let file = dir.appending(path: "space.automerge")
            guard let bytes = try? Data(contentsOf: file) else { continue }
            do {
                replicas[dir.lastPathComponent] = try Space.load(bytes: bytes, actorHex: actor)
            } catch {
                linkLog.error("Could not load Space \(dir.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
        publishSpaces()
    }

    private func publishSpaces() {
        spaces = replicas.filter { $0.value.kind() == "space" }.keys.sorted()
    }

    /// Writes a Space to disk before anything reads it as done: atomic, so a crash leaves the old or the new copy.
    private func persist(_ id: String) {
        guard let space = replicas[id] else { return }
        let dir = Self.spacesDir.appending(path: id, directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try space.save().write(to: dir.appending(path: "space.automerge"), options: [.atomic, .completeFileProtection])
        } catch {
            linkLog.error("Could not save Space \(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private func changed(_ id: String) {
        persist(id)
        revision[id, default: 0] += 1
        if let session { pump(id, session) }
    }

    /// The kernel's scene for this person, as JSON.
    public func scene(_ id: String) -> String? {
        guard let space = replicas[id] else { return nil }
        let q: [String: Any] = ["detail": "full", "viewer": ["person": person?.id ?? identity.person.id]]
        return try? space.scene(queryJson: Self.json(q))
    }

    /// Raw strokes (`scene({detail: "strokes"})`) for these Ink IDs: ID -> `[x, y, t, pressure]` points.
    public func strokes(_ id: String, ids: [String]) -> [String: [[Double]]] {
        guard let space = replicas[id], !ids.isEmpty else { return [:] }
        let q: [String: Any] = ["detail": "strokes", "ids": ids, "viewer": ["person": person?.id ?? identity.person.id]]
        guard let out = try? space.scene(queryJson: Self.json(q)), let r = Self.object(out) else { return [:] }
        var points: [String: [[Double]]] = [:]
        for s in r["elements"] as? [[String: Any]] ?? [] {
            if let sid = s["id"] as? String, let p = s["points"] as? [[Double]] { points[sid] = p }
        }
        return points
    }

    /// Every Agent batch and person's action in this Space, oldest first (the kernel's `timeline`).
    public func timeline(_ id: String) -> [[String: Any]] {
        guard let space = replicas[id] else { return [] }
        let q: [String: Any] = ["viewer": ["person": person?.id ?? identity.person.id], "limit": 300]
        guard let out = try? space.timeline(queryJson: Self.json(q)) else { return [] }
        return Self.object(out)?["entries"] as? [[String: Any]] ?? []
    }

    /// The person reverts an Agent's latest change. It is the person's own action, so their undo brings it back.
    @discardableResult
    public func revert(_ space: String, agent: String) -> [String: Any]? {
        intent(space, ["intent": "revert", "agent": agent])
    }

    /// One finished user action (`apply_user_intent`), made durable and synced.
    @discardableResult
    public func intent(_ space: String, _ intent: [String: Any]) -> [String: Any]? {
        guard let replica = replicas[space], let person else { return nil }
        do {
            let out = try replica.applyUserIntent(person: person.id, device: identity.device, intentJson: Self.json(intent), nowMs: Self.now())
            let r = Self.object(out)
            if r?["ok"] as? Bool == false { linkLog.error("Intent rejected: \(out, privacy: .public)") }
            changed(space)
            return r
        } catch {
            linkLog.error("Intent failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func undo(_ space: String) {
        guard let replica = replicas[space], let person else { return }
        _ = try? replica.undo(person: person.id, device: identity.device, nowMs: Self.now())
        changed(space)
    }

    public func redo(_ space: String) {
        guard let replica = replicas[space], let person else { return }
        _ = try? replica.redo(person: person.id, device: identity.device, nowMs: Self.now())
        changed(space)
    }

    /// Freezes a Send (`freeze_send`): pins the frontier and claims this person's
    /// unsent strokes and changes. It is saved on this iPad before this returns.
    public func freezeSend(_ space: String, raw: [String: Any]) throws -> [String: Any] {
        guard let replica = replicas[space], let person else { throw LinkError.protocolError("This iPad is not paired with a Link yet.") }
        let out = try replica.freezeSend(person: person.id, device: identity.device, rawJson: Self.json(raw), nowMs: Self.now())
        guard let r = Self.object(out), r["ok"] as? Bool != false else { throw LinkError.protocolError("The Send was rejected: \(out)") }
        changed(space)
        return r
    }

    // MARK: Assets

    /// Stores bytes as an asset, durably, before anything refers to them, and offers them to the Link.
    public func storeAsset(_ bytes: Data) throws -> String {
        let hash = sha256(bytes).hex
        let url = Self.assetsDir.appending(path: hash)
        if !FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) {
            try bytes.write(to: url, options: [.atomic, .completeFileProtection])
        }
        // Pushed now, ahead of the Send that refers to it, on the same ordered connection.
        if let session { sendAsset(hash, bytes, session) }
        return hash
    }

    private func sendAsset(_ hash: String, _ bytes: Data, _ s: Session) {
        let part = 1024 * 1024
        var off = 0
        repeat {
            s.send(["t": "asset", "hash": hash, "off": off, "size": bytes.count], bytes.subdata(in: off ..< min(bytes.count, off + part)))
            off += part
        } while off < bytes.count
    }

    /// An asset's bytes, if this iPad has them. The Link offers every asset it holds (`assets_have`), and the iPad fetches the ones it lacks.
    public func asset(_ hash: String) -> Data? {
        guard hash.count == 64, hash.allSatisfy(\.isHexDigit) else { return nil }
        if let bytes = try? Data(contentsOf: Self.assetsDir.appending(path: hash)) { return bytes }
        return nil
    }

    private func receiveAsset(_ h: [String: Any], _ body: Data) {
        guard let hash = h["hash"] as? String, hash.count == 64, hash.allSatisfy(\.isHexDigit),
              let off = h["off"] as? Int, let size = h["size"] as? Int, size >= 0, size <= 512 * 1024 * 1024 else { return }
        let url = Self.assetsDir.appending(path: hash)
        if FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) { return }
        if off == 0 { incoming[hash] = (size, Data()) }
        guard var inc = incoming[hash], inc.data.count == off, inc.size == size, off + body.count <= size else {
            incoming[hash] = nil
            linkLog.error("Dropped a malformed part of asset \(hash, privacy: .public)")
            return
        }
        inc.data.append(body)
        guard inc.data.count == size else {
            incoming[hash] = inc
            return
        }
        incoming[hash] = nil
        guard sha256(inc.data).hex == hash else {
            linkLog.error("Asset \(hash, privacy: .public) does not match its hash")
            return
        }
        try? inc.data.write(to: url, options: [.atomic, .completeFileProtection])
        assetRevision += 1
    }

    private func assetHashes() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: Self.assetsDir.path(percentEncoded: false))) ?? []).filter { $0.count == 64 }
    }

    // MARK: Agent approval

    public func decide(_ agent: String, allow: Bool) {
        agentRequests.removeAll { $0.id == agent }
        session?.send(["t": "agent_decision", "id": agent, "status": allow ? "approved" : "denied"])
    }

    // MARK: Pairing and connecting

    /// Pairs with the Link whose code was scanned or typed, then stays connected.
    public func pair(code: String) async throws {
        let offer = try PairingOffer(code)
        state = .connecting
        // A device that holds nothing of its own yet becomes the offering person's device (ADR-0008).
        identity.person = offer.person
        var errors: [String] = []
        for host in offer.hosts {
            let conn = FramedConnection(endpoint: .hostPort(host: .init(host), port: .init(rawValue: offer.port)!))
            do {
                try await conn.start()
                let s = try await handshake(conn, me: identity, pairedKey: nil, offer: offer)
                paired = Paired(device: s.peer.device, key: s.peer.key, name: offer.name, person: offer.person, hosts: offer.hosts, port: offer.port)
                Self.writeSecret(paired!, to: Self.linkDir.appending(path: "paired.json"))
                person = offer.person
                Self.writeSecret(Saved(key: B64.encode(identity.key.rawRepresentation), actor: actor, name: identity.name, person: offer.person), to: Self.linkDir.appending(path: "identity.json"))
                linkLog.info("Paired with \(offer.name, privacy: .public) at \(host, privacy: .public)")
                browse()
                bind(s)
                return
            } catch {
                conn.close()
                errors.append("\(host): \(error.localizedDescription)")
            }
        }
        state = .offline("Could not pair")
        throw LinkError.unreachable("Could not reach the Link. \(errors.joined(separator: "; "))")
    }

    /// Finds the paired Link again over Bonjour; discovery is never authentication.
    private func browse() {
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_reflex-link._tcp", domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self, let device = self.paired?.device else { return }
                for r in results {
                    if case .bonjour(let txt) = r.metadata, txt["dev"] == device {
                        self.discovered = r.endpoint
                        if self.session == nil { self.reconnectSoon(after: 0) }
                    }
                }
            }
        }
        b.start(queue: .main)
        browser = b
    }

    private func reconnectSoon(after seconds: Double) {
        Task {
            if seconds > 0 { try? await Task.sleep(for: .seconds(seconds)) }
            await reconnect()
        }
    }

    private func reconnect() async {
        guard let paired, session == nil, !dialing else { return }
        dialing = true
        defer { dialing = false }
        var endpoints: [NWEndpoint] = discovered.map { [$0] } ?? []
        endpoints += paired.hosts.map { .hostPort(host: .init($0), port: .init(rawValue: paired.port)!) }
        for e in endpoints {
            let conn = FramedConnection(endpoint: e)
            do {
                try await conn.start(timeout: 3)
                let s = try await handshake(conn, me: identity, pairedKey: paired.key, offer: nil)
                bind(s)
                return
            } catch {
                conn.close()
            }
        }
        state = .offline("\(paired.name) is not reachable")
        reconnectSoon(after: 2)
    }

    /// A new session: anti-entropy from scratch for every Space, then the receive loop.
    private func bind(_ s: Session) {
        session = s
        state = .connected(s.peer.name)
        linkLog.info("Connected to \(s.peer.name, privacy: .public) over \(s.conn.remote, privacy: .public)")
        for (_, space) in replicas { space.resetSync(peer: s.peer.device) }
        s.send(["t": "spaces", "spaces": replicas.map { ["id": $0.key, "kind": $0.value.kind()] }])
        s.send(["t": "assets_have", "hashes": assetHashes()])
        for id in replicas.keys { pump(id, s) }
        Task { await loop(s) }
    }

    private func loop(_ s: Session) async {
        do {
            while let (h, body) = try await s.next() { handle(h, body, s) }
        } catch {
            linkLog.error("Dropping the Link session: \(error.localizedDescription, privacy: .public)")
        }
        s.close()
        if session === s {
            session = nil
            for (_, space) in replicas { space.resetSync(peer: s.peer.device) }
            state = .offline("Reconnecting to \(s.peer.name)")
            reconnectSoon(after: 1)
        }
    }

    private func pump(_ id: String, _ s: Session) {
        guard session === s, let space = replicas[id], let msg = space.syncMessage(peer: s.peer.device) else { return }
        s.send(["t": "sync", "space": id], msg)
    }

    private func handle(_ h: [String: Any], _ body: Data, _ s: Session) {
        switch h["t"] as? String {
        case "spaces":
            for item in h["spaces"] as? [[String: Any]] ?? [] {
                guard let id = item["id"] as? String, let kind = item["kind"] as? String else { continue }
                if replicas[id] == nil, let space = try? Space.create(spaceId: id, kind: kind, actorHex: actor) {
                    replicas[id] = space
                    persist(id)
                    publishSpaces()
                }
                pump(id, s)
            }
        case "sync":
            guard let id = h["space"] as? String, let space = replicas[id] else { return }
            let before = space.heads()
            do {
                // The Link is trusted for every principal: it hosts the Agents and relays this person's other devices.
                try space.receiveSyncMessage(peer: s.peer.device, msg: body)
            } catch {
                linkLog.error("Bad sync message for \(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
                return
            }
            if space.heads() != before {
                persist(id)
                revision[id, default: 0] += 1
            }
            pump(id, s)
        case "assets_have":
            let have = Set(assetHashes())
            let want = (h["hashes"] as? [String] ?? []).filter { $0.count == 64 && !have.contains($0) && incoming[$0] == nil }
            if !want.isEmpty { s.send(["t": "asset_want", "hashes": want]) }
        case "asset":
            receiveAsset(h, body)
        case "agents":
            var known: [String: AgentInfo] = [:]
            for a in h["agents"] as? [[String: Any]] ?? [] {
                guard let id = a["id"] as? String else { continue }
                known[id] = AgentInfo(id: id, name: a["name"] as? String ?? id, color: a["color"] as? String ?? "violet", status: a["status"] as? String ?? "approved")
            }
            agents = known
            if let data = try? JSONEncoder().encode(known) { try? data.write(to: Self.linkDir.appending(path: "agents.json"), options: .atomic) }
        case "asset_want":
            for hash in h["hashes"] as? [String] ?? [] {
                if let bytes = try? Data(contentsOf: Self.assetsDir.appending(path: hash)) { sendAsset(hash, bytes, s) }
            }
        case "ping":
            s.send(["t": "pong", "n": h["n"] ?? 0, "at": h["at"] ?? 0])
        case "agent_request":
            guard let id = h["id"] as? String, !agentRequests.contains(where: { $0.id == id }) else { return }
            agentRequests.append(AgentRequest(id: id, name: h["name"] as? String ?? id, color: h["color"] as? String ?? "violet"))
        default:
            return // pong, and anything from a newer Link
        }
    }

    // MARK: Helpers

    static func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    static func json(_ v: Any) -> String {
        (try? JSONSerialization.data(withJSONObject: v)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    static func object(_ s: String) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any]
    }

    private static func writeSecret<T: Encodable>(_ v: T, to url: URL) {
        do {
            try JSONEncoder().encode(v).write(to: url, options: [.atomic, .completeFileProtection])
        } catch {
            linkLog.error("Could not save \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }
}
