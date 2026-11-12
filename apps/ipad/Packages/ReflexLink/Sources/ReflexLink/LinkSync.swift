import CoreGraphics
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

/// A shared Space (ADR-0008): who owns it, who is in it, and this person's role.
public struct ShareInfo: Sendable, Equatable {
    public struct Member: Sendable, Equatable, Identifiable {
        public var person: Person
        public var role: String
        public var id: String { person.id }
    }
    public var space: String
    public var owner: Person
    /// "owner", "editor", "viewer", or nil once the owner removed this person.
    public var role: String?
    public var members: [Member]
    public var epoch: Int
}

/// Someone else's device in a Space right now: its person, cursor and selection (link/here.ts).
/// Short-lived, never part of the Space.
public struct HereEntry: Sendable, Equatable, Identifiable {
    public var device: String
    public var space: String
    public var person: Person
    public var name: String
    /// In Space coordinates.
    public var cursor: CGPoint?
    public var selection: [String]
    public var at: Date
    public var id: String { device }
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
/// `ping` / `pong`, `agent_request` / `agent_decision`, and `agents` (each
/// Agent's name and color, for the chips). The iPad also sends `presence`
/// (which Space is on screen and whether the pen is down) and `hints` (its
/// handwriting recognizer's lines for the person's Ink in a watched Region).
///
/// Shared Spaces: the Link sends `shares` (each shared Space, its people and
/// this person's role) and `here` (other devices' cursors, names and
/// selections). The iPad asks it for an invite (`invite_create`, answered by
/// `invite`), to change someone's role or remove them (`member_set`), and to
/// join with an invite (`join_invite`, answered by `joined`). When the Link
/// refuses this iPad's changes to a Space (`refused`, a viewer drew), the iPad
/// starts that Space over from the Link and says so (`reset`).
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
    /// Shared Spaces, by Space.
    public private(set) var shares: [String: ShareInfo] = [:]
    /// Other devices in each Space now, by device.
    public private(set) var here: [String: HereEntry] = [:]
    /// The latest invite the Link made for this iPad, and anything it said went wrong with sharing.
    public private(set) var invite: (space: String, role: String, uri: String)?
    public var shareError: String?
    /// Bumps each time the Link refused this iPad's changes to a Space and it started over, with why.
    public private(set) var resets: [String: Int] = [:]
    public private(set) var refusal: (space: String, reason: String)?
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
    /// The Relay the Link said to use when the local network can't reach it (RelayConnection.swift).
    @ObservationIgnored private var relay: RelayInfo?
    /// Assets arriving in parts from the Link, by hash.
    @ObservationIgnored private var incoming: [String: (size: Int, data: Data)] = [:]
    @ObservationIgnored private var joining: CheckedContinuation<String, Error>?

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
        relay = (try? Data(contentsOf: Self.linkDir.appending(path: "relay.json"))).flatMap { try? JSONDecoder().decode(RelayInfo.self, from: $0) }
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

    /// The person's Library (the Space of kind `library`): its ID and revision, so a view can tell when it changed.
    public var library: (id: String, revision: Int)? {
        guard let id = replicas.first(where: { $0.value.kind() == "library" })?.key else { return nil }
        return (id, revision[id] ?? 0)
    }

    /// The Embed Templates saved in the person's Library: name, HTML, extra hosts and, for an MCP App view, its `ui://` source.
    public func embedTemplates() -> [(name: String, html: String, allow: [String], source: String?)] {
        guard let id = library?.id, let space = replicas[id],
              let out = try? space.scene(queryJson: Self.json(["detail": "full", "ids": [String]()])),
              let entries = Self.object(out)?["library"] as? [[String: Any]] else { return [] }
        return entries.compactMap { e in
            guard e["kind"] as? String == "embed", let name = e["name"] as? String, let html = e["template"] as? String else { return nil }
            return (name, html, e["allow"] as? [String] ?? [], e["source"] as? String)
        }
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
        let q: [String: Any] = ["viewer": ["person": person?.id ?? identity.person.id], "limit": 300, "names": agents.mapValues(\.name)]
        guard let out = try? space.timeline(queryJson: Self.json(q)) else { return [] }
        return Self.object(out)?["entries"] as? [[String: Any]] ?? []
    }

    /// The person reverts an Agent's latest change. It is the person's own action, so their undo brings it back.
    @discardableResult
    /// The person reverts an Agent's latest batch here (the kernel's `revert`).
    /// It goes into the person's history, so undo brings the batch back.
    public func revert(_ space: String, agent: String) -> [String: Any]? {
        guard let replica = replicas[space], let person else { return nil }
        do {
            let by = Self.json(["person": person.id, "device": identity.device])
            let names = Self.json(["agent": agent, "last": 1, "names": agents.mapValues(\.name)])
            let out = try replica.revert(byJson: by, requestId: "r_" + UUID().uuidString.prefix(12).lowercased(), selectorJson: names, nowMs: Self.now())
            let r = Self.object(out)
            if r?["ok"] as? Bool == false { linkLog.error("Revert rejected: \(out, privacy: .public)") }
            changed(space)
            return r
        } catch {
            linkLog.error("Revert failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
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

    // MARK: Presence and handwriting

    /// What this iPad shows and does now, sent again on every new session.
    @ObservationIgnored private var presence: (space: String?, pen: Bool) = (nil, false)
    /// Where the person's pen or finger is, in Space coordinates, and what they picked.
    @ObservationIgnored private var cursor: CGPoint?
    @ObservationIgnored private var selection: [String] = []
    @ObservationIgnored private var cursorSent = Date.distantPast
    @ObservationIgnored private var cursorTimer: Task<Void, Never>?
    /// The latest recognized lines per watched Region, by Space and Region.
    @ObservationIgnored private var watchHints: [String: [String: [[String: Any]]]] = [:]

    /// The Space on screen (nil when none is, or the app is in the background) and
    /// whether the pen is down, for `request_attention` and watch mode's `user_still_writing`.
    public func reportPresence(space: String?, pen: Bool) {
        guard presence.space != space || presence.pen != pen else { return }
        presence = (space, pen)
        if let session { sendPresence(session) }
    }

    private func sendPresence(_ s: Session) {
        var m: [String: Any] = ["t": "presence", "space": presence.space ?? NSNull(), "pen": presence.pen, "selection": selection]
        m["cursor"] = cursor.map { [($0.x * 10).rounded() / 10, ($0.y * 10).rounded() / 10] } ?? NSNull()
        s.send(m)
    }

    /// Where the pen or finger is now (nil when it left), and what the person picked, for the
    /// other people in a shared Space. At most ten updates a second; the last one always goes.
    public func reportCursor(_ point: CGPoint?, selection: [String]? = nil) {
        cursor = point
        if let selection { self.selection = selection }
        cursorTimer?.cancel()
        let wait = 0.1 - Date().timeIntervalSince(cursorSent)
        guard wait > 0 else {
            cursorSent = Date()
            if let session { sendPresence(session) }
            return
        }
        cursorTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self, !Task.isCancelled else { return }
            self.cursorSent = Date()
            if let session = self.session { self.sendPresence(session) }
        }
    }

    // MARK: Shared Spaces

    /// This person's role in a Space: "owner" for one nobody shared with them, nil once removed.
    public func role(_ space: String) -> String? {
        shares[space].map(\.role) ?? "owner"
    }

    /// Asks the Link for a single-use invite to a Space this person owns; it arrives as `invite`.
    public func createInvite(_ space: String, role: String) {
        invite = nil
        shareError = nil
        session?.send(["t": "invite_create", "space": space, "role": role])
    }

    /// Makes someone an editor or a viewer, or removes them ("remove").
    public func setMember(_ space: String, person: String, role: String) {
        shareError = nil
        session?.send(["t": "member_set", "space": space, "person": person, "role": role])
    }

    /// Joins someone's Space with the invite they sent: the Link presents it to theirs. Returns the Space.
    public func join(invite code: String) async throws -> String {
        guard let session else { throw LinkError.unreachable("This iPad isn't connected to its Link.") }
        joining?.resume(throwing: LinkError.refused("Replaced by a newer invite."))
        return try await withCheckedThrowingContinuation { c in
            joining = c
            session.send(["t": "join_invite", "uri": code.trimmingCharacters(in: .whitespacesAndNewlines)])
        }
    }

    /// The Link refused this iPad's changes to a Space: start it over from the Link, dropping them.
    private func startOver(_ id: String, reason: String, _ s: Session) {
        guard let old = replicas[id], let fresh = try? Space.create(spaceId: id, kind: old.kind(), actorHex: actor) else { return }
        replicas[id] = fresh
        persist(id)
        revision[id, default: 0] += 1
        resets[id, default: 0] += 1
        refusal = (id, reason)
        linkLog.error("The Link refused changes to \(id, privacy: .public): \(reason, privacy: .public)")
        s.send(["t": "reset", "space": id])
        if let a = paths.active { pump(id, a) }
    }

    private func readShares(_ list: [[String: Any]]) {
        var next: [String: ShareInfo] = [:]
        for x in list {
            guard let space = x["space"] as? String, let o = x["owner"] as? [String: Any], let oid = o["id"] as? String else { continue }
            let members = (x["members"] as? [[String: Any]] ?? []).compactMap { m -> ShareInfo.Member? in
                guard let p = m["person"] as? [String: Any], let id = p["id"] as? String else { return nil }
                return .init(person: Person(id: id, name: p["name"] as? String ?? id), role: m["role"] as? String ?? "viewer")
            }
            next[space] = ShareInfo(space: space, owner: Person(id: oid, name: o["name"] as? String ?? oid), role: x["role"] as? String, members: members, epoch: x["epoch"] as? Int ?? 0)
        }
        shares = next
    }

    private func readHere(_ h: [String: Any]) {
        guard let device = h["device"] as? String, device != identity.device else { return }
        if h["gone"] as? Bool == true {
            here[device] = nil
            return
        }
        guard let space = h["space"] as? String, let p = h["person"] as? [String: Any], let pid = p["id"] as? String else { return }
        let c = h["cursor"] as? [Double]
        here[device] = HereEntry(
            device: device, space: space, person: Person(id: pid, name: p["name"] as? String ?? pid), name: h["name"] as? String ?? "",
            cursor: c.flatMap { $0.count == 2 ? CGPoint(x: $0[0], y: $0[1]) : nil }, selection: h["selection"] as? [String] ?? [], at: Date()
        )
    }

    /// The recognizer's lines for the person's Ink in a watched Region, so the
    /// Link's watch snapshots carry real recognized text. Replaces what was sent before for that Region.
    public func reportHints(space: String, region: String, hints: [[String: Any]]) {
        watchHints[space, default: [:]][region] = hints
        session?.send(["t": "hints", "space": space, "region": region, "hints": hints])
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
        // iPadOS ends a backgrounded app's Bonjour browsing (DefunctConnection): start over.
        b.stateUpdateHandler = { [weak self] state in
            guard case .failed(let e) = state else { return }
            Task { @MainActor in
                guard let self, self.browser === b else { return }
                linkLog.error("LAN browsing failed: \(e.localizedDescription, privacy: .public); browsing again")
                b.cancel()
                self.browser = nil
                try? await Task.sleep(for: .seconds(1))
                self.browse()
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
        // Nothing reaches the Link: go through the Relay, if it named one. Next to a live LAN or
        // peer-to-peer path the Relay isn't needed.
        if paths.isEmpty, let relay, let conn = try? RelayConnection(relay: relay, me: identity, link: paired.device) {
            do {
                try await conn.start()
                let s = try await handshake(conn, me: identity, pairedKey: paired.key, offer: nil)
                bind(s)
                reconnectSoon(after: 5)
                return
            } catch {
                conn.close()
                linkLog.info("Relay path to \(paired.name, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
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
        incoming = [:] // parts of an asset from an earlier path never complete
        for (_, space) in replicas { space.resetSync(peer: s.peer.device) }
        s.send(["t": "spaces", "spaces": replicas.map { ["id": $0.key, "kind": $0.value.kind()] }])
        s.send(["t": "assets_have", "hashes": assetHashes()])
        for id in replicas.keys { pump(id, s) }
        sendPresence(s)
        for (space, regions) in watchHints {
            for (region, hints) in regions { s.send(["t": "hints", "space": space, "region": region, "hints": hints]) }
        }
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
            here = [:] // who is here comes again with the next session
            for (_, space) in replicas { space.resetSync(peer: s.peer.device) }
            state = .offline("Reconnecting to \(s.peer.name)")
        } else if wasActive, let next = paths.active {
            // What was in flight on the lost path may be gone: start over on the one that is left.
            linkLog.info("Lost the \(s.transport, privacy: .public) path; now sending over \(next.transport, privacy: .public)")
            fresh(next)
        }
        // The ticker redials peer-to-peer; LAN and the Relay are dialed here.
        if s.transport != "p2p" { reconnectSoon(after: 1) }
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
                if let bytes = try? Data(contentsOf: Self.assetsDir.appending(path: hash)), let a = paths.active { sendAsset(hash, bytes, a) }
            }
        case "ping":
            // Answered on the path it came on, so each path's RTT is its own.
            s.send(["t": "pong", "n": h["n"] ?? 0, "at": h["at"] ?? 0])
        case "relay":
            guard let url = h["url"] as? String, let room = h["room"] as? String else { return }
            let info = RelayInfo(url: url, room: room)
            if info != relay {
                relay = info
                Self.writeSecret(info, to: Self.linkDir.appending(path: "relay.json"))
                linkLog.info("The Link syncs through the Relay at \(url, privacy: .public)")
            }
        case "shares":
            readShares(h["shares"] as? [[String: Any]] ?? [])
            // An invite is single use: once someone joined with it, it is no longer worth showing.
            if let live = h["invites"] as? [String], let inv = invite,
               let id = URLComponents(string: inv.uri)?.queryItems?.first(where: { $0.name == "i" })?.value, !live.contains(id) {
                invite = nil
            }
        case "here":
            readHere(h)
        case "invite":
            if let space = h["space"] as? String, let uri = h["uri"] as? String { invite = (space, h["role"] as? String ?? "editor", uri) }
        case "share_error":
            let message = h["message"] as? String ?? "The Link could not do that."
            if let j = joining {
                joining = nil
                j.resume(throwing: LinkError.refused(message))
            } else {
                shareError = message
            }
        case "joined":
            joining?.resume(returning: h["space"] as? String ?? "")
            joining = nil
        case "refused":
            guard let id = h["space"] as? String else { return }
            startOver(id, reason: h["reason"] as? String ?? "", s)
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
            return // anything from a newer Link
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
