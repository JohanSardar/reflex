import CryptoKit
import Foundation

/// A Relay's pairing room (`link/transports/relay.ts`, `PAIRING_ROOM`): where a Link with a live typed code
/// waits, and where this iPad tries the code when it finds no Mac nearby. One WebSocket, under a relay
/// identity made for this pairing only (its relay hello isn't this iPad's device ID), and one channel per Link
/// tried. The Relay sees who opened a channel to whom and the handshake's public values: the code is checked with CPace inside
/// (Cpace.swift), and a stranger in the room learns nothing from it.
final class RelayLobby: @unchecked Sendable {
    /// SHA-256("reflex-relay/v0 pairing room"), its first 32 hex digits.
    static let room = sha256(Data("reflex-relay/v0 pairing room".utf8)).hex.prefix(32).description
    private static let opener: UInt32 = 0x8000_0000

    let url: String
    private let task: URLSessionWebSocketTask
    private let key = Curve25519.Signing.PrivateKey()
    private var me: String { deviceID(for: key.publicKey.rawRepresentation) }
    private let lock = NSLock()
    private var online: [String] = []
    private var channels: [UInt32: LobbyChannel] = [:]
    private var nextChannel: UInt32 = 1
    private var ready: CheckedContinuation<Void, Error>?
    private var closed = false
    /// Once pairing is done: the socket closes with its last channel (the session's).
    private var released = false

    init(url: String) throws {
        guard var c = URLComponents(string: url), c.scheme == "ws" || c.scheme == "wss" else {
            throw LinkError.unreachable("The Relay address '\(url)' is not ws:// or wss://.")
        }
        c.path = "/v0/connect"
        c.queryItems = [URLQueryItem(name: "room", value: Self.room)]
        guard let u = c.url else { throw LinkError.unreachable("Bad Relay address.") }
        self.url = url
        task = URLSession.shared.webSocketTask(with: u)
        task.maximumMessageSize = 8 * 1024 * 1024
    }

    /// Connects and says hello; throws after `timeout` seconds.
    func start(timeout: Double = 6) async throws {
        task.resume()
        receive()
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
            lock.lock()
            ready = k
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finishStart(.failure(LinkError.unreachable("The relay at \(self?.url ?? "") did not answer.")))
            }
        }
    }

    private func finishStart(_ r: Result<Void, Error>) {
        lock.lock()
        let k = ready
        ready = nil
        lock.unlock()
        k?.resume(with: r)
    }

    /// The Links in the room, after giving them `seconds` to show up.
    func devices(after seconds: Double) async -> [String] {
        try? await Task.sleep(for: .seconds(seconds))
        return lock.withLock { online }
    }

    /// A new channel to one device in the room.
    func channel(to device: String) -> LobbyChannel {
        lock.lock()
        let ch = nextChannel
        nextChannel += 1
        let c = LobbyChannel(lobby: self, device: device, channel: ch)
        channels[ch] = c
        lock.unlock()
        return c
    }

    /// Pairing is done: keep the socket for the session's channel only.
    func release() {
        lock.lock()
        released = true
        lock.unlock()
    }

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let e):
                self.finishStart(.failure(LinkError.unreachable(e.localizedDescription)))
                self.close()
            case .success(.string(let text)):
                self.control(text)
                self.receive()
            case .success(.data(let data)):
                self.data(data)
                self.receive()
            @unknown default:
                self.receive()
            }
        }
    }

    private func control(_ text: String) {
        guard let m = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return }
        switch m["t"] as? String {
        case "challenge":
            guard let nonce = m["nonce"] as? String,
                let sig = try? key.signature(for: Data("reflex-relay/v0 hello \(Self.room) \(nonce)".utf8))
            else { return }
            sendJSON([
                "t": "hello", "device": me, "key": B64.encode(key.publicKey.rawRepresentation), "sig": B64.encode(sig),
            ])
        case "welcome":
            sendJSON(["t": "watch", "devices": ["*"]])
            finishStart(.success(()))
        case "presence":
            guard let d = m["device"] as? String else { return }
            lock.lock()
            online.removeAll { $0 == d }
            if m["online"] as? Bool == true { online.append(d) }
            let gone = m["online"] as? Bool != true || m["joined"] as? Bool == true
            let hit = gone ? channels.values.filter { $0.device == d } : []
            lock.unlock()
            for c in hit { c.finish() }
        case "close", "undeliverable":
            guard let d = m["device"] as? String, let ch = (m["ch"] as? NSNumber)?.uint32Value else { return }
            lock.lock()
            let c = channels[ch & ~Self.opener]
            lock.unlock()
            if let c, c.device == d { c.finish() }
        default:
            return
        }
    }

    private func data(_ d: Data) {
        let b = [UInt8](d)
        guard b.count >= 5, b.count >= 1 + Int(b[0]) + 4 else { return }
        let n = Int(b[0])
        let device = String(decoding: b[1..<1 + n], as: UTF8.self)
        let ch = b[(1 + n)..<(5 + n)].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        // The Link answers on this side's channel, without the opener bit.
        lock.lock()
        let c = channels[ch]
        lock.unlock()
        guard let c, c.device == device, ch & Self.opener == 0 else { return }
        c.deliver(Data(b[(5 + n)...]))
    }

    private func sendJSON(_ m: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: m), let s = String(data: d, encoding: .utf8) else {
            return
        }
        task.send(.string(s)) { _ in }
    }

    fileprivate func send(_ frame: Data, to device: String, channel: UInt32) {
        let id = Array(device.utf8)
        var out = Data([UInt8(id.count)] + id)
        withUnsafeBytes(of: (channel | Self.opener).bigEndian) { out.append(contentsOf: $0) }
        out.append(frame)
        task.send(.data(out)) { _ in }
    }

    fileprivate func closeChannel(_ c: LobbyChannel) {
        sendJSON(["t": "close", "device": c.device, "ch": c.channel | Self.opener])
        lock.lock()
        channels[c.channel] = nil
        let last = released && channels.isEmpty
        lock.unlock()
        if last { close() }
    }

    func close() {
        lock.lock()
        let was = closed
        closed = true
        let all = Array(channels.values)
        channels = [:]
        lock.unlock()
        if was { return }
        for c in all { c.finish() }
        task.cancel(with: .normalClosure, reason: nil)
    }
}

/// One channel to one Link through the pairing room: the path the handshake (and then the session) runs on.
final class LobbyChannel: FrameChannel, @unchecked Sendable {
    let device: String
    let channel: UInt32
    let frames: AsyncThrowingStream<Data, Error>
    let remote: String
    let transport = "relay"
    private let lobby: RelayLobby
    private var continuation: AsyncThrowingStream<Data, Error>.Continuation!
    private let lock = NSLock()
    private var done = false

    fileprivate init(lobby: RelayLobby, device: String, channel: UInt32) {
        self.lobby = lobby
        self.device = device
        self.channel = channel
        remote = "\(lobby.url) pairing room → \(device)"
        var k: AsyncThrowingStream<Data, Error>.Continuation!
        frames = AsyncThrowingStream { k = $0 }
        continuation = k
    }

    fileprivate func deliver(_ d: Data) { continuation.yield(d) }

    fileprivate func finish() {
        lock.lock()
        let was = done
        done = true
        lock.unlock()
        if !was { continuation.finish() }
    }

    func send(_ frame: Data) { lobby.send(frame, to: device, channel: channel) }

    func close() {
        finish()
        lobby.closeChannel(self)
    }
}
