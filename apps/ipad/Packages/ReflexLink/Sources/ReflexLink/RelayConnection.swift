import CryptoKit
import Foundation

/// Where this person's devices meet on a Reflex Relay, as the Link said
/// (`{t:"relay", url, room}`). Saved, so the iPad can reach the Link through
/// the Relay when the local network can't.
struct RelayInfo: Codable, Equatable {
    var url: String
    var room: String
}

/// One logical path to the paired Link through a Reflex Relay
/// (`relay/domain/wire.ts`, `reflex-relay/v0`): a WebSocket to the person's
/// room, a signed hello, then frames to the Link on one channel. The Relay
/// only forwards; the end-to-end handshake runs inside, exactly as on the LAN,
/// so the Relay never sees a key or a change.
///
///     relay → iPad  {t:"challenge", nonce}
///     iPad → relay  {t:"hello", device, key, sig}   sig = Ed25519("reflex-relay/v0 hello <room> <nonce>")
///     relay → iPad  {t:"welcome"}
///     iPad → relay  {t:"watch", devices:[link]}     accept frames only from the Link
///     relay → iPad  {t:"presence", device, online}
///     frames        [u8 n][device][u32 BE channel][payload], channel bit 31 set by the side that opened it
final class RelayConnection: FrameChannel, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let me: DeviceIdentity
    private let room: String
    private let link: String
    private let lock = NSLock()
    private var continuation: AsyncThrowingStream<Data, Error>.Continuation!
    private var ready: CheckedContinuation<Void, Error>?
    private var welcomed = false
    private var closed = false
    let frames: AsyncThrowingStream<Data, Error>
    let remote: String
    /// This side opens channel 1 to the Link.
    private static let channel: UInt32 = 1
    private static let opener: UInt32 = 0x8000_0000

    init(relay: RelayInfo, me: DeviceIdentity, link: String) throws {
        guard var c = URLComponents(string: relay.url), c.scheme == "ws" || c.scheme == "wss" else { throw LinkError.unreachable("The Relay address '\(relay.url)' is not ws:// or wss://.") }
        c.path = "/v0/connect"
        c.queryItems = [URLQueryItem(name: "room", value: relay.room)]
        guard let url = c.url else { throw LinkError.unreachable("Bad Relay address.") }
        task = URLSession.shared.webSocketTask(with: url)
        task.maximumMessageSize = 8 * 1024 * 1024
        self.me = me
        room = relay.room
        self.link = link
        remote = "\(relay.url) → \(link)"
        var k: AsyncThrowingStream<Data, Error>.Continuation!
        frames = AsyncThrowingStream { k = $0 }
        continuation = k
    }

    /// Connects, says hello, and waits until the Link is in the room. Throws after `timeout` seconds.
    func start(timeout: Double = 6) async throws {
        task.resume()
        receive()
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
            lock.lock()
            ready = k
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finishStart(.failure(LinkError.unreachable("The Link is not on the Relay.")))
            }
        }
    }

    private var started = false
    private var isStarted: Bool { lock.lock(); defer { lock.unlock() }; return started }

    private func finishStart(_ r: Result<Void, Error>) {
        lock.lock()
        let k = ready
        ready = nil
        if k != nil, case .success = r { started = true }
        lock.unlock()
        k?.resume(with: r)
        if case .failure = r, k != nil { close() }
    }

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let e):
                self.finishStart(.failure(LinkError.unreachable(e.localizedDescription)))
                self.finish()
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
                  let sig = try? me.key.signature(for: Data("reflex-relay/v0 hello \(room) \(nonce)".utf8)) else { return }
            sendJSON(["t": "hello", "device": me.device, "key": B64.encode(me.publicRaw), "sig": B64.encode(sig)])
        case "welcome":
            welcomed = true
            sendJSON(["t": "watch", "devices": [link]])
        case "presence":
            guard m["device"] as? String == link else { return }
            if m["online"] as? Bool != true { return finish() }
            // The Link connected anew after this path was up: its end of channel 1 is gone.
            if m["joined"] as? Bool == true, isStarted { return finish() }
            finishStart(.success(()))
        case "close", "undeliverable":
            if m["device"] as? String == link { finish() }
        default:
            return
        }
    }

    private func data(_ d: Data) {
        let b = [UInt8](d)
        guard b.count >= 5, b.count >= 1 + Int(b[0]) + 4 else { return }
        let n = Int(b[0])
        guard String(decoding: b[1 ..< 1 + n], as: UTF8.self) == link else { return }
        let ch = b[(1 + n) ..< (5 + n)].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        // The Link answers on this side's channel, without the opener bit.
        guard ch == Self.channel else { return }
        continuation.yield(Data(b[(5 + n)...]))
    }

    private func sendJSON(_ m: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: m), let s = String(data: d, encoding: .utf8) else { return }
        task.send(.string(s)) { _ in }
    }

    func send(_ frame: Data) {
        let id = Array(link.utf8)
        var out = Data([UInt8(id.count)] + id)
        withUnsafeBytes(of: (Self.channel | Self.opener).bigEndian) { out.append(contentsOf: $0) }
        out.append(frame)
        // URLSessionWebSocketTask sends in call order, so frames stay in the order they were sealed.
        task.send(.data(out)) { _ in }
    }

    private func finish() {
        lock.lock()
        let was = closed
        closed = true
        lock.unlock()
        if !was { continuation.finish() }
    }

    func close() {
        if welcomed { sendJSON(["t": "close", "device": link, "ch": Self.channel | Self.opener]) }
        task.cancel(with: .normalClosure, reason: nil)
        finish()
    }
}
