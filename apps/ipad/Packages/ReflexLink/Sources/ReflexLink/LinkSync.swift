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

/// The iPad's replicas of every Space, kept in the Rust kernel (through
/// UniFFI), saved on this iPad, and in sync with the paired Link over the
/// local network and Apple peer-to-peer Wi-Fi (ARCHITECTURE §1, §6, §8).
///
/// Both paths stay open when both are up; changes go over the faster one
/// (`PathSet`), and when it drops the other takes over at once, with
/// anti-entropy from scratch. Anything arriving on either path is taken: the
/// same change arriving twice changes nothing.
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
    public private(set) var person: Person?
    public var deviceID: String { identity.device }
    /// The live paths to the Link ("lan", "p2p"), and the one changes go out on.
    public private(set) var transports: [String] = []
    public private(set) var activeTransport: String?

    @ObservationIgnored private var identity: DeviceIdentity
    @ObservationIgnored private var actor: String
    @ObservationIgnored private var paired: Paired?
    @ObservationIgnored private var replicas: [String: Space] = [:]
    @ObservationIgnored private var paths = PathSet()
    /// The path changes go out on.
    private var session: Session? { paths.active }
    @ObservationIgnored private var browser: NWBrowser?
    @ObservationIgnored private var p2p: PeerToPeerBrowser?
    @ObservationIgnored private var discovered: NWEndpoint?
    @ObservationIgnored private var dialing = false
    @ObservationIgnored private var dialingP2P = false
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var pings = 0
    @ObservationIgnored private var assetsWritten: Set<String> = []

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
        if !FileManager.default.fileExists(atPath: url.path()) {
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

    private func assetHashes() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: Self.assetsDir.path())) ?? []).filter { $0.count == 64 }
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
        if p2p == nil, let device = paired?.device {
            let b = PeerToPeerBrowser(device: device) { [weak self] found in
                if found != nil { self?.dialPeerToPeer() }
            }
            b.start()
            p2p = b
        }
        startTicker()
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_reflex-link._tcp", domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self, let device = self.paired?.device else { return }
                for r in results {
                    if case .bonjour(let txt) = r.metadata, txt["dev"] == device {
                        self.discovered = r.endpoint
                        if self.paths.on("lan") == nil { self.reconnectSoon(after: 0) }
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

    /// Reaches the Link over the local network (Bonjour, then the addresses in its pairing code).
    private func reconnect() async {
        guard let paired, paths.on("lan") == nil, !dialing else { return }
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
        if paths.isEmpty { state = .offline("\(paired.name) is not reachable") }
        reconnectSoon(after: paths.isEmpty ? 2 : 5)
    }

    /// Reaches the Link over Apple peer-to-peer Wi-Fi, when its helper has been seen there.
    private func dialPeerToPeer() {
        guard let paired, let found = p2p?.found, paths.on("p2p") == nil, !dialingP2P else { return }
        dialingP2P = true
        Task {
            defer { dialingP2P = false }
            let conn = FramedConnection(endpoint: found.endpoint, peerToPeer: found.interface)
            do {
                try await conn.start(timeout: 6)
                bind(try await handshake(conn, me: identity, pairedKey: paired.key, offer: nil))
            } catch {
                conn.close()
                linkLog.error("Peer-to-peer connect failed: \(error.localizedDescription, privacy: .public)")
                try? await Task.sleep(for: .seconds(3))
                dialPeerToPeer()
            }
        }
    }

    /// Every 2 s: ping each path (RTT for choosing between them), drop paths that went silent,
    /// and redial a path that is missing.
    private func startTicker() {
        guard ticker == nil else { return }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                self?.tick()
            }
        }
    }

    private func tick() {
        let now = Date()
        for s in paths.all {
            if now.timeIntervalSince(s.lastHeard) > PathSet.silent {
                linkLog.error("The \(s.transport, privacy: .public) path went silent; dropping it")
                s.close()
                continue
            }
            pings += 1
            s.send(["t": "ping", "n": pings, "at": Self.now()])
        }
        if paths.on("p2p") == nil { dialPeerToPeer() }
    }

    private func publishPaths() {
        transports = paths.all.map(\.transport)
        activeTransport = paths.active?.transport
    }

    /// A new path. The first one starts anti-entropy from scratch for every Space; a second one
    /// (the other transport) joins as another way to reach the same Link.
    private func bind(_ s: Session) {
        if let old = paths.on(s.transport) {
            old.close()
            _ = paths.remove(old)
        }
        let first = paths.isEmpty
        paths.add(s)
        publishPaths()
        state = .connected(s.peer.name)
        linkLog.info("Connected to \(s.peer.name, privacy: .public) over \(s.transport, privacy: .public) \(s.conn.remote, privacy: .public); \(self.paths.all.count) paths")
        if first || paths.active === s { fresh(s) }
        Task { await loop(s) }
    }

    /// Starts over on the path changes go out on: anti-entropy for every Space, and assets.
    private func fresh(_ s: Session) {
        for (_, space) in replicas { space.resetSync(peer: s.peer.device) }
        s.send(["t": "spaces", "spaces": replicas.map { ["id": $0.key, "kind": $0.value.kind()] }])
        s.send(["t": "assets_have", "hashes": assetHashes()])
        for id in replicas.keys { pump(id, s) }
    }

    private func loop(_ s: Session) async {
        do {
            while let (h, body) = try await s.next() { handle(h, body, s) }
        } catch {
            linkLog.error("Dropping the \(s.transport, privacy: .public) path: \(error.localizedDescription, privacy: .public)")
        }
        s.close()
        let wasActive = paths.remove(s)
        publishPaths()
        if paths.isEmpty {
            for (_, space) in replicas { space.resetSync(peer: s.peer.device) }
            state = .offline("Reconnecting to \(s.peer.name)")
        } else if wasActive, let next = paths.active {
            // What was in flight on the lost path may be gone: start over on the one that is left.
            linkLog.info("Lost the \(s.transport, privacy: .public) path; now sending over \(next.transport, privacy: .public)")
            fresh(next)
        }
        if s.transport == "lan" { reconnectSoon(after: 1) }
    }

    private func pump(_ id: String, _ s: Session) {
        guard paths.active === s, let space = replicas[id], let msg = space.syncMessage(peer: s.peer.device) else { return }
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
                if let a = paths.active { pump(id, a) }
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
            if let a = paths.active { pump(id, a) }
        case "asset_want":
            for hash in h["hashes"] as? [String] ?? [] {
                if let bytes = try? Data(contentsOf: Self.assetsDir.appending(path: hash)), let a = paths.active { sendAsset(hash, bytes, a) }
            }
        case "ping":
            // Answered on the path it came on, so each path's RTT is its own.
            s.send(["t": "pong", "n": h["n"] ?? 0, "at": h["at"] ?? 0])
        case "pong":
            guard let at = (h["at"] as? NSNumber)?.int64Value else { return }
            s.recordRtt(Double(Self.now() - at))
            let from = paths.active
            if let to = paths.evaluate() {
                linkLog.info("Now sending over \(to.transport, privacy: .public) (\(to.rttMs ?? -1) ms) instead of \(from?.transport ?? "-", privacy: .public) (\(from?.rttMs ?? -1) ms)")
                publishPaths()
            }
        case "agent_request":
            guard let id = h["id"] as? String, !agentRequests.contains(where: { $0.id == id }) else { return }
            agentRequests.append(AgentRequest(id: id, name: h["name"] as? String ?? id, color: h["color"] as? String ?? "violet"))
        default:
            return // assets_have, asset, and anything from a newer Link
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
