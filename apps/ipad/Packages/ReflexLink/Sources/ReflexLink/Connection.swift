import CryptoKit
import Foundation
import Network

/// Ordered, reliable frames to one Link, over any path: the LAN or Apple
/// peer-to-peer Wi-Fi (`FramedConnection`), or the Relay (`RelayConnection`).
/// The handshake and the session don't care which.
protocol FrameChannel: AnyObject, Sendable {
    var frames: AsyncThrowingStream<Data, Error> { get }
    var remote: String { get }
    /// "lan", "p2p" or "relay", as the Link names its transports.
    var transport: String { get }
    func send(_ frame: Data)
    func close()
}

/// TCP with length-prefixed frames (u32, big-endian), as the Link's LAN and
/// peer-to-peer transports (`link/transports/framed.ts`). The same frames go
/// over the local network or over Apple peer-to-peer Wi-Fi.
final class FramedConnection: FrameChannel, @unchecked Sendable {
    private let conn: NWConnection
    private let queue = DispatchQueue(label: "si.eilmer.reflex.link-connection")
    private var buffer = Data()
    private var continuation: AsyncThrowingStream<Data, Error>.Continuation!
    let frames: AsyncThrowingStream<Data, Error>
    let remote: String
    /// "lan" or "p2p".
    let transport: String
    static let maxFrame = 16 * 1024 * 1024

    /// Over the local network, or, given `peerToPeer`, only over that peer-to-peer interface.
    init(endpoint: NWEndpoint, peerToPeer: NWInterface? = nil) {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 10
        let params = NWParameters(tls: nil, tcp: tcp)
        if let peerToPeer {
            params.includePeerToPeer = true
            params.requiredInterface = peerToPeer
        }
        conn = NWConnection(to: endpoint, using: params)
        transport = peerToPeer == nil ? "lan" : "p2p"
        remote = peerToPeer.map { "\(endpoint) via \($0.name)" } ?? "\(endpoint)"
        var c: AsyncThrowingStream<Data, Error>.Continuation!
        frames = AsyncThrowingStream { c = $0 }
        continuation = c
    }

    /// Connects, or throws after `timeout` seconds.
    func start(timeout: Double = 4) async throws {
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
            let once = Once(k)
            conn.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    once.resume(.success(()))
                    self?.receive()
                case .failed(let e), .waiting(let e):
                    once.resume(.failure(LinkError.unreachable(e.localizedDescription)))
                    self?.conn.cancel()
                case .cancelled:
                    once.resume(.failure(LinkError.unreachable("cancelled")))
                    self?.continuation.finish()
                default: break
                }
            }
            conn.start(queue: queue)
            queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
                once.resume(.failure(LinkError.unreachable("timed out")))
                if case .ready = self?.conn.state {} else { self?.conn.cancel() }
            }
        }
    }

    private func receive() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
            guard let self else { return }
            if let data { self.buffer.append(data) }
            while self.buffer.count >= 4 {
                let n = self.buffer.prefix(4).reduce(0) { $0 << 8 | Int($1) }
                if n > Self.maxFrame {
                    self.continuation.finish(throwing: LinkError.protocolError("a frame of \(n) bytes is over the limit"))
                    return self.conn.cancel()
                }
                guard self.buffer.count >= 4 + n else { break }
                let frame = self.buffer.subdata(in: self.buffer.startIndex + 4 ..< self.buffer.startIndex + 4 + n)
                self.buffer = Data(self.buffer.dropFirst(4 + n))
                self.continuation.yield(frame)
            }
            if done || error != nil {
                self.continuation.finish()
                self.conn.cancel()
            } else {
                self.receive()
            }
        }
    }

    func send(_ frame: Data) {
        var head = Data(count: 4)
        let n = UInt32(frame.count).bigEndian
        withUnsafeBytes(of: n) { head = Data($0) }
        conn.send(content: head + frame, completion: .contentProcessed { _ in })
    }

    func close() {
        conn.cancel()
    }

    /// The IPv4 address and port a Bonjour endpoint resolved to, once connected: kept to dial the Link directly later.
    var resolvedIPv4: (host: String, port: UInt16)? {
        guard case .hostPort(let host, let port) = conn.currentPath?.remoteEndpoint, case .ipv4(let a) = host else { return nil }
        return ("\(a)".split(separator: "%").first.map(String.init) ?? "\(a)", port.rawValue)
    }
}

/// Resumes a continuation at most once.
private final class Once<T: Sendable>: @unchecked Sendable {
    private var k: CheckedContinuation<T, Error>?
    private let lock = NSLock()
    init(_ k: CheckedContinuation<T, Error>) { self.k = k }
    func resume(_ r: Result<T, Error>) {
        lock.lock()
        let k = self.k
        self.k = nil
        lock.unlock()
        k?.resume(with: r)
    }
}

/// An authenticated, encrypted connection to one Link. Messages are a JSON
/// header plus optional bytes (`link/pairing/handshake.ts`, `Session`).
@MainActor
final class Session {
    let conn: any FrameChannel
    var peer: PeerInfo
    var transport: String { conn.transport }
    /// Smoothed round trip from this side's pings, as on the Link (`FramedPath.recordRtt`).
    private(set) var rttMs: Double?
    /// When anything last arrived; a path that goes quiet is dropped.
    var lastHeard = Date()
    private var tx: FrameCipher
    private var rx: FrameCipher
    private var iterator: AsyncThrowingStream<Data, Error>.AsyncIterator

    init(conn: any FrameChannel, peer: PeerInfo, tx: FrameCipher, rx: FrameCipher, iterator: AsyncThrowingStream<Data, Error>.AsyncIterator) {
        self.conn = conn
        self.peer = peer
        self.tx = tx
        self.rx = rx
        self.iterator = iterator
    }

    func send(_ header: [String: Any], _ body: Data = Data()) {
        guard let head = try? JSONSerialization.data(withJSONObject: header) else { return }
        var len = Data(count: 4)
        withUnsafeBytes(of: UInt32(head.count).bigEndian) { len = Data($0) }
        // Sealing happens in call order, so nonces match the order frames reach the wire.
        guard let sealed = try? tx.seal(len + head + body) else { return }
        conn.send(sealed)
    }

    func next() async throws -> (header: [String: Any], body: Data)? {
        // Only the session's one receive loop reads, so the copy never races.
        var it = iterator
        let next = try await it.next(isolation: MainActor.shared)
        iterator = it
        guard let f = next else { return nil }
        lastHeard = Date()
        let plain = try rx.open(f)
        let n = plain.prefix(4).reduce(0) { $0 << 8 | Int($1) }
        guard plain.count >= 4 + n, let h = try JSONSerialization.jsonObject(with: plain.subdata(in: plain.startIndex + 4 ..< plain.startIndex + 4 + n)) as? [String: Any] else {
            throw LinkError.protocolError("a malformed message")
        }
        return (h, plain.subdata(in: plain.startIndex + 4 + n ..< plain.endIndex))
    }

    func recordRtt(_ ms: Double) {
        rttMs = rttMs.map { (($0 * 0.7 + ms * 0.3) * 10).rounded() / 10 } ?? ms
    }

    func close() {
        conn.close()
    }
}

struct PeerInfo {
    var device: String
    var key: String
    var person: Person
    var name: String
}

/// This iPad's long-term identity: an Ed25519 key, the device ID derived from
/// it, and the person it belongs to.
struct DeviceIdentity {
    var key: Curve25519.Signing.PrivateKey
    var person: Person
    var name: String
    var publicRaw: Data { key.publicKey.rawRepresentation }
    var device: String { deviceID(for: publicRaw) }
}

/// Set once this side has revealed a digit of a typed code to the other device (`handshake` with a code).
final class CodeExposure: @unchecked Sendable { var revealed = false }

/// In the default Relay's pairing room, a Link that waits on the person's own Relay: try the code there.
struct RelayMoved: Error { var relay: String }

/// The handshake, as the side that dials (`link/pairing/handshake.ts`):
///
///     I → R  hello  { device, key, eph, person, name, kind, pair? }
///     R → I  hello
///     I → R  auth   { sig: Ed25519(transcript), mac?: HMAC(pairing secret, transcript) }
///     R → I  auth   { sig, mac? }
///
/// `pairedKey` is the Link's key when already paired; `offer` when pairing; `relayCode` for a typed code tried
/// in a Relay's pairing room, checked with CPace (Cpace.swift). Over a Relay the hellos carry no names; with
/// `relayCode`, each side says who it is inside the session once the code is proven:
///
///     I → R  cpace  { y }      R → I  cpace  { y }
///     I → R  auth   { sig, mac }      R → I  auth (only once it checked this side's)
///     R → I  who    { person, name }  sealed; this iPad becomes that person's
///     I → R  who    { person, name }  sealed
@MainActor
func handshake(_ conn: any FrameChannel, me: DeviceIdentity, pairedKey: String?, offer: PairingOffer?, exposure: CodeExposure? = nil, relayCode: String? = nil) async throws -> Session {
    var it = conn.frames.makeAsyncIterator()
    func next() async throws -> (raw: Data, msg: [String: Any]) {
        // A Link that never answers is cut off; its stream then ends.
        let timer = Task { [conn] in
            try await Task.sleep(for: .seconds(10))
            conn.close()
        }
        defer { timer.cancel() }
        let raw = try await it.next(isolation: MainActor.shared)
        guard let raw else { throw LinkError.unreachable("the Link closed the connection during the handshake") }
        guard let msg = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else { throw LinkError.protocolError("a malformed handshake frame") }
        if msg["t"] as? String == "refused" { throw LinkError.refused("The Link refused: \(msg["reason"] as? String ?? "no reason given")") }
        return (raw, msg)
    }

    let eph = Curve25519.KeyAgreement.PrivateKey()
    let relay = conn.transport == "relay"
    var hello: [String: Any] = [
        "t": "hello", "v": 0, "protocol": linkProtocol, "device": me.device, "key": B64.encode(me.publicRaw),
        "eph": B64.encode(eph.publicKey.rawRepresentation),
        "person": ["id": relayCode != nil ? "" : me.person.id, "name": relay ? "" : me.person.name],
        "name": relay ? "" : me.name, "kind": "ipad",
    ]
    if relayCode != nil { hello["pair"] = "cpace" } else if let offer { hello["pair"] = offer.code != nil ? "code" : offer.offer }
    let mine = try JSONSerialization.data(withJSONObject: hello)
    conn.send(mine)
    let (theirsRaw, theirs) = try await next()
    if theirs["t"] as? String == "moved", let to = theirs["relay"] as? String { throw RelayMoved(relay: to) }
    guard theirs["t"] as? String == "hello", theirs["v"] as? Int == 0, theirs["protocol"] as? String == linkProtocol,
          let key = theirs["key"] as? String, let keyRaw = B64.decode(key), let device = theirs["device"] as? String,
          let ephRaw = (theirs["eph"] as? String).flatMap(B64.decode)
    else { throw LinkError.protocolError("The other device does not speak \(linkProtocol).") }
    guard deviceID(for: keyRaw) == device else { throw LinkError.protocolError("The Link's device ID does not belong to its key.") }
    if let offer, offer.device != device || offer.key != key {
        throw LinkError.refused("The device that answered is not the one in the pairing code.")
    }
    if offer == nil, relayCode == nil, pairedKey != key {
        // Say why before closing, so the Link's log names the cause instead of "closed during the handshake".
        if let why = try? JSONSerialization.data(withJSONObject: ["t": "refused", "reason": "this iPad is paired with another Link identity at this address (the Link changed); it stops dialing and asks the person to scan this Link's code"]) {
            conn.send(why)
        }
        throw LinkError.linkChanged(theirs["name"] as? String ?? "")
    }

    let transcript = sha256(Data(linkProtocol.utf8), mine, theirsRaw)
    let label = { (s: String) in Data("\(linkProtocol) \(s) ".utf8) + transcript }
    if let code = relayCode {
        let cp = try Cpace(code: code, transcript: transcript)
        conn.send(try JSONSerialization.data(withJSONObject: ["t": "cpace", "y": B64.encode(cp.share)]))
        let (_, c) = try await next()
        guard c["t"] as? String == "cpace", let y = (c["y"] as? String).flatMap(B64.decode) else { throw LinkError.protocolError("The Link broke off the code check.") }
        let secret = try cp.secret(theirs: y, initiator: true, transcript: transcript)
        let auth: [String: Any] = [
            "t": "auth", "sig": B64.encode(try me.key.signature(for: label("auth i"))),
            "mac": B64.encode(Data(HMAC<SHA256>.authenticationCode(for: label("pair i"), using: SymmetricKey(data: secret)))),
        ]
        conn.send(try JSONSerialization.data(withJSONObject: auth))
        // A wrong code: the Link answers `refused` (next() throws) instead of its auth.
        let (_, a) = try await next()
        let want = Data(HMAC<SHA256>.authenticationCode(for: label("pair r"), using: SymmetricKey(data: secret)))
        guard a["t"] as? String == "auth", let mac = (a["mac"] as? String).flatMap(B64.decode), mac == want else { throw LinkError.refused("The Link refused: wrong pairing code") }
        guard let sig = (a["sig"] as? String).flatMap(B64.decode), try Curve25519.Signing.PublicKey(rawRepresentation: keyRaw).isValidSignature(sig, for: label("auth r"))
        else { throw LinkError.refused("The Link did not prove its key.") }
        let s = try session(conn, eph: eph, ephRaw: ephRaw, transcript: transcript, peer: PeerInfo(device: device, key: key, person: Person(id: "", name: ""), name: ""), it: it)
        // Who the Link is, inside the session; this iPad becomes its person's.
        let timer = Task { [conn] in
            try await Task.sleep(for: .seconds(10))
            conn.close()
        }
        defer { timer.cancel() }
        guard let (w, _) = try await s.next(), w["t"] as? String == "who", let p = w["person"] as? [String: Any], let pid = p["id"] as? String, !pid.isEmpty else {
            throw LinkError.protocolError("The Link didn't say who it is after the code check.")
        }
        let person = Person(id: pid, name: p["name"] as? String ?? "")
        s.send(["t": "who", "person": ["id": person.id, "name": person.name], "name": me.name])
        s.peer = PeerInfo(device: device, key: key, person: person, name: w["name"] as? String ?? "Reflex Link")
        return s
    }
    // A typed code is checked digit by digit first (link/pairing/handshake.ts), then makes the secret the MACs use.
    var secret = offer?.secret ?? Data()
    if let code = offer?.code {
        for (round, digit) in code.enumerated() {
            let commit = { (n: Data, who: String) in
                Data(HMAC<SHA256>.authenticationCode(for: Data("\(linkProtocol) code \(who) \(round) \(digit) ".utf8) + transcript, using: SymmetricKey(data: n)))
            }
            let n = SymmetricKey(size: .bits128).withUnsafeBytes { Data($0) }
            conn.send(try JSONSerialization.data(withJSONObject: ["t": "commit", "c": B64.encode(commit(n, "i"))]))
            let (_, c) = try await next()
            guard c["t"] as? String == "commit", let theirC = (c["c"] as? String).flatMap(B64.decode) else { throw LinkError.protocolError("The Link broke off the code check.") }
            exposure?.revealed = true
            conn.send(try JSONSerialization.data(withJSONObject: ["t": "reveal", "n": B64.encode(n)]))
            let (_, r) = try await next()
            guard r["t"] as? String == "reveal", let theirN = (r["n"] as? String).flatMap(B64.decode) else { throw LinkError.protocolError("The Link broke off the code check.") }
            guard commit(theirN, "r") == theirC else { throw LinkError.refused("The Link refused: wrong pairing code") }
        }
        secret = Data(SHA256.hash(data: Data(linkProtocol.utf8) + Data(" code secret ".utf8) + Data(code.utf8) + transcript))
    }
    var auth: [String: Any] = ["t": "auth", "sig": B64.encode(try me.key.signature(for: label("auth i")))]
    if offer != nil {
        auth["mac"] = B64.encode(Data(HMAC<SHA256>.authenticationCode(for: label("pair i"), using: SymmetricKey(data: secret))))
    }
    conn.send(try JSONSerialization.data(withJSONObject: auth))
    let (_, a) = try await next()
    guard a["t"] as? String == "auth", let sig = (a["sig"] as? String).flatMap(B64.decode),
          try Curve25519.Signing.PublicKey(rawRepresentation: keyRaw).isValidSignature(sig, for: label("auth r"))
    else { throw LinkError.refused("The Link did not prove its key.") }
    if let offer {
        let want = Data(HMAC<SHA256>.authenticationCode(for: label("pair r"), using: SymmetricKey(data: secret)))
        guard let mac = (a["mac"] as? String).flatMap(B64.decode), mac == want else { throw LinkError.refused("The Link does not know this pairing code's secret.") }
    }

    let person = theirs["person"] as? [String: Any]
    let peer = PeerInfo(device: device, key: key, person: Person(id: person?["id"] as? String ?? "", name: person?["name"] as? String ?? ""), name: theirs["name"] as? String ?? "Reflex Link")
    return try session(conn, eph: eph, ephRaw: ephRaw, transcript: transcript, peer: peer, it: it)
}

/// The session keys from the X25519 exchange, once the handshake proved both sides.
@MainActor
private func session(_ conn: any FrameChannel, eph: Curve25519.KeyAgreement.PrivateKey, ephRaw: Data, transcript: Data, peer: PeerInfo, it: AsyncThrowingStream<Data, Error>.AsyncIterator) throws -> Session {
    let shared = try eph.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: ephRaw))
    let okm = shared.withUnsafeBytes { Data($0) }
    let keys = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: okm), salt: transcript, info: Data("\(linkProtocol) session keys".utf8), outputByteCount: 64)
        .withUnsafeBytes { Data($0) }
    let i2r = SymmetricKey(data: keys.prefix(32)), r2i = SymmetricKey(data: keys.suffix(32))
    return Session(conn: conn, peer: peer, tx: FrameCipher(key: i2r, aad: transcript), rx: FrameCipher(key: r2i, aad: transcript), iterator: it)
}
