import CoreGraphics
import CryptoKit
import Foundation
import Network
import Observation
import OSLog

let linkLog = Logger(subsystem: "si.eilmer.reflex", category: "link")

/// An Agent waiting for the person to approve it, sent by the Link.
public struct AgentRequest: Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var color: String
    /// When the Link asked (ms). An answer is for this request only: asked again later, it is a new question.
    public var requestedAt: Int64?
}

/// Another iPad of the person's waiting for "Let … approve Agents?" (asked of approving iPads only).
public struct ApproverRequest: Identifiable, Sendable, Equatable {
    public var device: String
    public var name: String
    public var id: String { device }
}

/// The person's answer to one request, kept until the Link confirms it.
public struct AgentDecision: Codable, Sendable, Equatable {
    public var status: String
    public var requestedAt: Int64?
}

/// An Agent the Link knows: its name and color, for its chip and the history.
public struct AgentInfo: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    /// A named protocol color.
    public var color: String
    public var status: String
    public var requestedAt: Int64?
}

/// Paired transport, approval, local page discovery and durable Send delivery.
@MainActor @Observable
public final class LinkSync {
    public enum State: Equatable {
        case unpaired
        case connecting
        case connected(String)
        case offline(String)
        /// The computer at the paired address answered with another key (its Link was reset): scan its code again.
        /// The iPad stops dialing it until then.
        case linkChanged(String)
    }

    public private(set) var state: State = .unpaired
    /// Spaces this iPad holds, by ID, not counting the Library.
    public private(set) var spaces: [String] = []
    /// Bumps each time a Space changes, from here or from the Link.
    public private(set) var revision: [String: Int] = [:]
    /// Agents waiting for the person's answer. Kept while the Link lists them as pending, through
    /// reconnects and relaunches (rebuilt from the saved `agents`), until the person answers.
    public private(set) var agentRequests: [AgentRequest] = []
    /// Answers the person gave that the Link hasn't confirmed yet (its `agents` list still says pending).
    /// Saved, and sent again on every new path until it does.
    public private(set) var decisions: [String: AgentDecision] = [:]
    /// Whether the Link counts this iPad's Allow (it paired as the person: the first iPad, or by scanning a code in
    /// the Link's terminal). One paired later with `reflex pair` syncs, but approving stays with the other.
    public private(set) var canApprove = true
    /// Why this iPad isn't asked about Agents, when it isn't (`canApprove` is false and one is waiting).
    public private(set) var approvalElsewhere: String?
    /// iPads of the person's waiting for this one to answer "Let … approve Agents?" (it approves).
    public private(set) var approverRequests: [ApproverRequest] = []
    /// A new device of this person's paired with the Link: said once, so a device nobody meant to pair shows.
    public var newDevice: (name: String, approves: Bool)?
    /// Spaces made under another person (an earlier pairing): kept on this iPad only, in their own folder and
    /// under their own key (`local-only:<id>`), so a Space of the new Link with the same ID is its own. By key,
    /// with that person's name.
    public private(set) var localOnly: [String: String] = [:]
    /// Said once after pairing into a new person: how many Spaces stay on this iPad only, and whose they were.
    public private(set) var localOnlyNotice: (count: Int, owner: String)?
    /// Every Agent the Link knows, by ID (sent by the Link, kept for offline use).
    public private(set) var agents: [String: AgentInfo] = [:]
    /// Bumps each time an asset arrives from the Link, so images waiting for it draw.
    public private(set) var assetRevision = 0
    public private(set) var person: Person?
    @ObservationIgnored public var beforeChangingPerson: (() -> Void)?
    public var deviceID: String { identity.device }
    /// The live paths to the Link ("lan", "p2p"), and the one changes go out on.
    public private(set) var transports: [String] = []
    public private(set) var activeTransport: String?

    @ObservationIgnored private var identity: DeviceIdentity
    @ObservationIgnored private var actor: String
    @ObservationIgnored private var paired: Paired?
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
    /// The Relay the Link said to use when the local network can't reach it (RelayConnection.swift).
    @ObservationIgnored private var relay: RelayInfo?
    /// Addresses that answered with another key (a Link reset there, or another computer has that address now):
    /// not dialed again, so that Link's log stays quiet, until the network changes, Bonjour finds the paired Link,
    /// or the person scans again. Other addresses, peer-to-peer and the Relay are still tried.
    @ObservationIgnored private var changedHosts: Set<String> = []
    @ObservationIgnored private var network: NWPathMonitor?
    @ObservationIgnored private var networkSeen: [String] = []

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
    private static let localOnlyDir = root.appending(path: "LocalOnly", directoryHint: .isDirectory)
    static let localPrefix = "local-only:"
    private static let assetsDir = root.appending(path: "Assets", directoryHint: .isDirectory)

    public init(deviceName: String) {
        let fm = FileManager.default
        for d in [Self.linkDir, Self.spacesDir, Self.localOnlyDir, Self.assetsDir] { try? fm.createDirectory(at: d, withIntermediateDirectories: true) }
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
        decisions = (try? Data(contentsOf: Self.linkDir.appending(path: "decisions.json"))).flatMap { try? JSONDecoder().decode([String: AgentDecision].self, from: $0) } ?? [:]
        localOnly = (try? Data(contentsOf: Self.linkDir.appending(path: "local-only.json"))).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
        // Kept by an earlier build in Spaces/ under the Space's own ID: move them to LocalOnly/.
        for (id, owner) in localOnly where !id.hasPrefix(Self.localPrefix) {
            localOnly[id] = nil
            localOnly[Self.keep(id)] = owner
        }
        saveLocalOnly()
        // A question still open when the app last ran is asked again at once, before the Link is back.
        refreshRequests()
        loadPages()
        if paired != nil {
            state = .connecting
            browse()
            reconnectSoon(after: 0)
        }
    }

    // MARK: Spaces

    private func loadPages() {
        var found: [String] = []
        for (root, prefix) in [(Self.spacesDir, ""), (Self.localOnlyDir, Self.localPrefix)] {
            for dir in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])) ?? [] {
                guard (try? dir.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true,
                      dir.lastPathComponent != "library" else { continue }
                found.append(prefix + dir.lastPathComponent)
            }
        }
        spaces = found.sorted()
        if spaces.isEmpty { _ = createPage() }
    }

    @discardableResult
    public func createPage() -> String {
        let id = "page_" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        do {
            try FileManager.default.createDirectory(at: Self.folder(id), withIntermediateDirectories: true)
            spaces.append(id)
        } catch { linkLog.error("Could not create page: \(error.localizedDescription)") }
        return id
    }

    /// Where a replica is saved: Spaces/<id>, or LocalOnly/<id> for one kept from an earlier pairing.
    private static func folder(_ key: String) -> URL {
        key.hasPrefix(localPrefix)
            ? localOnlyDir.appending(path: String(key.dropFirst(localPrefix.count)), directoryHint: .isDirectory)
            : spacesDir.appending(path: key, directoryHint: .isDirectory)
    }

    /// Moves Spaces/<id> to LocalOnly/<id> (another name if one from a still earlier pairing has it); returns its new key.
    @discardableResult
    private static func keep(_ id: String) -> String {
        var name = id
        var n = 2
        while FileManager.default.fileExists(atPath: localOnlyDir.appending(path: name).path(percentEncoded: false)) {
            name = "\(id)-\(n)"
            n += 1
        }
        try? FileManager.default.moveItem(at: spacesDir.appending(path: id, directoryHint: .isDirectory), to: localOnlyDir.appending(path: name, directoryHint: .isDirectory))
        return localPrefix + name
    }

    /// A Space's name to show: its ID, without the key a Space from an earlier pairing is kept under.
    public func title(_ key: String) -> String {
        key.hasPrefix(Self.localPrefix) ? String(key.dropFirst(Self.localPrefix.count)) : key
    }

    // MARK: Send outbox

    private static var outboxDir: URL { root.appending(path: "Sends", directoryHint: .isDirectory) }

    /// Save before returning. Only a Send may export ink or screen images.
    public var destinationKey: String? { paired?.key }

    public func enqueueSend(_ space: String, raw: [String: Any], destination: String?) throws -> [String: Any] {
        guard let paired, let person, paired.key == destination, spaces.contains(space), localOnly[space] == nil, !space.hasPrefix(Self.localPrefix) else {
            throw LinkError.protocolError("Connect this page to your Link before sending.")
        }
        guard let id = raw["send"] as? String, Self.safeID(id) else { throw LinkError.protocolError("Invalid Send ID") }
        var send = raw
        send["space"] = space
        send["by"] = ["person": person.id, "device": identity.device]
        send["at"] = Self.now()
        let item: [String: Any] = ["link": paired.key, "space": space, "send": send]
        try FileManager.default.createDirectory(at: Self.outboxDir, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: item).write(to: Self.outboxDir.appending(path: id + ".json"), options: [.atomic, .completeFileProtection])
        if let session { deliver(item, session) }
        return send
    }

    private static func safeID(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 200 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }

    private func deliver(_ item: [String: Any], _ s: Session) {
        guard item["link"] as? String == paired?.key, let send = item["send"] as? [String: Any], let space = item["space"] as? String else { return }
        for crop in send["crops"] as? [[String: Any]] ?? [] {
            guard let hash = crop["asset"] as? String, let bytes = asset(hash) else { return }
            sendAsset(hash, bytes, s)
        }
        s.send(["t": "send", "space": space, "send": send])
    }

    private func deliverPending(_ s: Session) {
        for file in ((try? FileManager.default.contentsOfDirectory(at: Self.outboxDir, includingPropertiesForKeys: nil)) ?? []).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            guard let data = try? Data(contentsOf: file), let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            deliver(item, s)
        }
    }

    // MARK: Assets

    /// Stores bytes locally before a Send refers to them. Delivery exports them only with that Send.
    public func storeAsset(_ bytes: Data) throws -> String {
        let hash = sha256(bytes).hex
        let url = Self.assetsDir.appending(path: hash)
        if !FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) {
            try bytes.write(to: url, options: [.atomic, .completeFileProtection])
        }
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

    public func asset(_ hash: String) -> Data? {
        guard hash.count == 64, hash.allSatisfy(\.isHexDigit) else { return nil }
        return try? Data(contentsOf: Self.assetsDir.appending(path: hash))
    }

    /// The person's answer. It is kept until the Link's `agents` list shows it, and sent on every live
    /// path now and on every new one, so an answer given while the connection is down or switching lands.
    public func decide(_ agent: String, allow: Bool) {
        let asked = agentRequests.first { $0.id == agent }?.requestedAt ?? agents[agent]?.requestedAt
        agentRequests.removeAll { $0.id == agent }
        decisions[agent] = AgentDecision(status: allow ? "approved" : "denied", requestedAt: asked)
        saveDecisions()
        for s in paths.all { sendDecisions(s, only: agent) }
        if paths.isEmpty { linkLog.info("Kept the answer for \(agent, privacy: .public); it goes out when the Link is back") }
    }

    /// The person's answer to "Let <device> approve Agents?", on this approving iPad.
    public func decideApprover(_ device: String, allow: Bool) {
        approverRequests.removeAll { $0.device == device }
        session?.send(["t": "approver_decision", "device": device, "allow": allow])
    }

    private func sendDecisions(_ s: Session, only: String? = nil) {
        for (id, d) in decisions where only == nil || only == id {
            var m: [String: Any] = ["t": "agent_decision", "id": id, "status": d.status]
            if let at = d.requestedAt { m["requested_at"] = at }
            s.send(m)
        }
    }

    private func saveDecisions() {
        if let data = try? JSONEncoder().encode(decisions) { try? data.write(to: Self.linkDir.appending(path: "decisions.json"), options: .atomic) }
    }

    /// Questions to show: every Agent the Link lists as pending that the person hasn't answered here yet.
    private func refreshRequests() {
        let pending = agents.values.filter { $0.status == "pending" && decisions[$0.id] == nil }
        // An iPad whose Allow wouldn't count isn't asked; it says where to answer instead.
        let shown = canApprove ? pending : []
        var next = agentRequests.filter { r in shown.contains { $0.id == r.id } }
        for a in shown.sorted(by: { $0.id < $1.id }) where !next.contains(where: { $0.id == a.id }) {
            next.append(AgentRequest(id: a.id, name: a.name, color: a.color, requestedAt: a.requestedAt))
        }
        if next != agentRequests { agentRequests = next }
        let elsewhere = !canApprove && !pending.isEmpty
            ? "\(pending.first!.name) wants to use your Spaces. Allow it on your iPad that approves Agents: this one can't yet."
            : nil
        if elsewhere != approvalElsewhere { approvalElsewhere = elsewhere }
    }

    // MARK: Spaces from an earlier pairing

    /// Deletes the Spaces kept from an earlier pairing, from this iPad.
    public func deleteLocalOnly() {
        for id in localOnly.keys {
            try? FileManager.default.removeItem(at: Self.folder(id))
        }
        localOnly = [:]
        saveLocalOnly()
        localOnlyNotice = nil
        loadPages()
    }

    public func dismissLocalOnlyNotice() { localOnlyNotice = nil }

    private func saveLocalOnly() {
        if let data = try? JSONEncoder().encode(localOnly) { try? data.write(to: Self.linkDir.appending(path: "local-only.json"), options: .atomic) }
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
                // Spaces made under another person (an earlier Link) aren't this person's to sync: the new Link
                // would refuse every change in them. They stay here, offered to no Link.
                if let old = person, old.id != offer.person.id {
                    beforeChangingPerson?()
                    // Moved to their own folder and key: the new Link's Library ("library") and any Space of its with
                    // the same ID get fresh replicas, and these are never offered to it.
                    var shown = 0
                    for id in spaces.filter({ localOnly[$0] == nil }) {
                        let key = Self.keep(id)
                        localOnly[key] = old.name.isEmpty ? old.id : old.name
                        shown += 1
                    }
                    saveLocalOnly()
                    loadPages()
                    if shown > 0 { localOnlyNotice = (shown, old.name.isEmpty ? "an earlier pairing" : old.name) }
                    decisions = [:]
                    saveDecisions()
                }
                changedHosts = []
                paired = Paired(device: s.peer.device, key: s.peer.key, name: offer.name, person: offer.person, hosts: offer.hosts, port: offer.port)
                Self.writeSecret(paired!, to: Self.linkDir.appending(path: "paired.json"))
                person = offer.person
                Self.writeSecret(Saved(key: B64.encode(identity.key.rawRepresentation), actor: actor, name: identity.name, person: offer.person), to: Self.linkDir.appending(path: "identity.json"))
                linkLog.info("Paired with \(offer.name, privacy: .public) at \(host, privacy: .public)")
                // The peer-to-peer browser looks for one Link by its device ID: a new Link needs a new one.
                p2p?.stop()
                p2p = nil
                discovered = nil
                browse()
                for old in paths.all where old.peer.device != s.peer.device { old.close() }
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
        watchNetwork()
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_reflex-link._tcp", domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self, let device = self.paired?.device else { return }
                for r in results {
                    if case .bonjour(let txt) = r.metadata, txt["dev"] == device {
                        self.discovered = r.endpoint
                        self.changedHosts = []
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

    /// A new network (another Wi-Fi, a VPN): an address that answered with another key may be this Link's again.
    private func watchNetwork() {
        guard network == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in
            let now = path.availableInterfaces.map(\.name).sorted() + [path.status == .satisfied ? "up" : "down"]
            Task { @MainActor in
                guard let self, now != self.networkSeen else { return }
                let first = self.networkSeen.isEmpty
                self.networkSeen = now
                if first || self.changedHosts.isEmpty { return }
                linkLog.info("The network changed; dialing every address of the Link again")
                self.changedHosts = []
                self.reconnectSoon(after: 0)
            }
        }
        m.start(queue: .main)
        network = m
    }

    private func reconnectSoon(after seconds: Double) {
        Task {
            if seconds > 0 { try? await Task.sleep(for: .seconds(seconds)) }
            await reconnect()
        }
    }

    /// Reaches the Link over the local network (Bonjour, then the addresses in its pairing code), then the Relay.
    private func reconnect() async {
        guard let paired, paths.on("lan") == nil, !dialing else { return }
        dialing = true
        defer { dialing = false }
        var endpoints: [(NWEndpoint, String?)] = discovered.map { [($0, nil)] } ?? []
        // Loopback is never the Link (an older code listed it); on the iPad it is the iPad itself.
        endpoints += paired.hosts.filter { ($0 != "127.0.0.1" || Self.simulator) && !changedHosts.contains($0) }
            .map { (.hostPort(host: .init($0), port: .init(rawValue: paired.port)!), $0) }
        for (e, host) in endpoints {
            let conn = FramedConnection(endpoint: e)
            do {
                try await conn.start(timeout: 3)
                let s = try await handshake(conn, me: identity, pairedKey: paired.key, offer: nil)
                bind(s)
                return
            } catch LinkError.linkChanged {
                // Another Link answers there: not dialed again (it would refuse every 2 s) until the network changes.
                if let host { changedHosts.insert(host) }
                try? await Task.sleep(for: .milliseconds(200)) // let the refusal reach the Link before closing
                conn.close()
            } catch {
                conn.close()
            }
        }
        // Nothing on the LAN reaches the Link: go through the Relay, if it named one. Next to a live LAN or
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
        guard paths.isEmpty else { return reconnectSoon(after: 5) }
        // Another Link answers where this iPad's Link was, and its own Link answered on no path: it was most likely
        // reset or reinstalled. Ask the person to scan its new code; keep trying the other ways meanwhile.
        if !changedHosts.isEmpty, paired.hosts.allSatisfy({ changedHosts.contains($0) || ($0 == "127.0.0.1" && !Self.simulator) }) {
            if state != .linkChanged(paired.name) {
                linkLog.error("The Link at \(paired.name, privacy: .public)'s address has a new key; waiting for the person to scan its code")
            }
            state = .linkChanged(paired.name)
            return reconnectSoon(after: 10)
        }
        state = .offline("\(paired.name) is not reachable")
        reconnectSoon(after: 2)
    }

    /// Reaches the Link over Apple peer-to-peer Wi-Fi, when its helper has been seen there.
    private func dialPeerToPeer() {
        // The Simulator has no peer-to-peer Wi-Fi: it would only time out, over and over.
        guard !Self.simulator, let paired, let found = p2p?.found, paths.on("p2p") == nil, !dialingP2P else { return }
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
        if let session { deliverPending(session) }
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
        deliverPending(s)
        // Answers the Link hasn't confirmed: every new path carries them again.
        sendDecisions(s)

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
            state = .offline("Reconnecting to \(s.peer.name)")
        } else if wasActive, let next = paths.active {
            // What was in flight on the lost path may be gone: start over on the one that is left.
            linkLog.info("Lost the \(s.transport, privacy: .public) path; now sending over \(next.transport, privacy: .public)")
            fresh(next)
        }
        // The ticker redials peer-to-peer; LAN and the Relay are dialed here.
        if s.transport != "p2p" { reconnectSoon(after: 1) }
    }

    private func handle(_ h: [String: Any], _ body: Data, _ s: Session) {
        switch h["t"] as? String {
        case "send_ack":
            guard let id = h["send"] as? String, Self.safeID(id) else { return }
            let file = Self.outboxDir.appending(path: id + ".json")
            guard let data = try? Data(contentsOf: file), let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any], item["link"] as? String == paired?.key else { return }
            try? FileManager.default.removeItem(at: file)
        case "agents":
            var known: [String: AgentInfo] = [:]
            for a in h["agents"] as? [[String: Any]] ?? [] {
                guard let id = a["id"] as? String else { continue }
                known[id] = AgentInfo(id: id, name: a["name"] as? String ?? id, color: a["color"] as? String ?? "violet", status: a["status"] as? String ?? "approved",
                                      requestedAt: (a["requested_at"] as? NSNumber)?.int64Value)
            }
            agents = known
            canApprove = h["approver"] as? Bool ?? true
            if let data = try? JSONEncoder().encode(known) { try? data.write(to: Self.linkDir.appending(path: "agents.json"), options: .atomic) }
            // An answer is done once the Link no longer lists that Agent as pending, and stale once it was asked
            // again since (the answer was for the earlier request): then the person is asked anew.
            let landed = decisions.filter { id, d in
                known[id]?.status != "pending" || (d.requestedAt != nil && known[id]?.requestedAt != nil && d.requestedAt != known[id]?.requestedAt)
            }.map(\.key)
            if !landed.isEmpty {
                for id in landed { decisions[id] = nil }
                saveDecisions()
            }
            refreshRequests()
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
        case "pong":
            guard let at = (h["at"] as? NSNumber)?.int64Value else { return }
            s.recordRtt(Double(Self.now() - at))
            let from = paths.active
            if let to = paths.evaluate() {
                linkLog.info("Now sending over \(to.transport, privacy: .public) (\(to.rttMs ?? -1) ms) instead of \(from?.transport ?? "-", privacy: .public) (\(from?.rttMs ?? -1) ms)")
                publishPaths()
            }
        case "agent_request":
            guard let id = h["id"] as? String else { return }
            let at = (h["requested_at"] as? NSNumber)?.int64Value
            if let d = decisions[id] {
                // Already answered here, and the Link asks because the answer hasn't reached it: send it again.
                if d.requestedAt == nil || at == nil || d.requestedAt == at { return sendDecisions(s, only: id) }
                // Asked again since this answer: it was for the earlier request. Ask the person anew.
                decisions[id] = nil
                saveDecisions()
            }
            guard canApprove, !agentRequests.contains(where: { $0.id == id }) else { return }
            agentRequests.append(AgentRequest(id: id, name: h["name"] as? String ?? id, color: h["color"] as? String ?? "violet", requestedAt: at))
        case "agent_decision_refused":
            // This iPad's answers don't count (it paired with `reflex pair` after another iPad): stop sending it.
            guard let id = h["id"] as? String else { return }
            decisions[id] = nil
            saveDecisions()
            canApprove = false
            refreshRequests()
            if approvalElsewhere == nil { approvalElsewhere = h["reason"] as? String }
        case "approver_requests":
            let list = (h["requests"] as? [[String: Any]] ?? []).compactMap { r -> ApproverRequest? in
                guard let d = r["device"] as? String else { return nil }
                return ApproverRequest(device: d, name: r["name"] as? String ?? d)
            }
            if list != approverRequests { approverRequests = list }
        case "device_paired":
            guard let name = h["name"] as? String else { return }
            newDevice = (name, h["approves"] as? Bool ?? false)
        default:
            return // anything from a newer Link
        }
    }

    // MARK: Helpers

    static func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    #if targetEnvironment(simulator)
    static let simulator = true
    #else
    static let simulator = false
    #endif

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
