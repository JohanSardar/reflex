import CryptoKit
import Foundation

/// The Link's wire protocol, byte for byte as `link/pairing/crypto.ts` and
/// `handshake.ts` speak it.
public let linkProtocol = "reflex-link/v0"

enum B64 {
    /// base64url without padding, as Node's `base64url`.
    static func encode(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
}

extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

func sha256(_ parts: Data...) -> Data {
    var h = SHA256()
    for p in parts { h.update(data: p) }
    return Data(h.finalize())
}

/// The device ID that belongs to an Ed25519 public key.
func deviceID(for publicKey: Data) -> String {
    "dev-" + sha256(publicKey).prefix(8).hex
}

/// One direction of an encrypted session: ChaCha20-Poly1305 with a counter
/// nonce (4 zero bytes, then the count as a big-endian u64) and the handshake
/// transcript as associated data. A dropped, reordered or replayed frame fails.
struct FrameCipher {
    let key: SymmetricKey
    let aad: Data
    var n: UInt64 = 0

    mutating func nonce() throws -> ChaChaPoly.Nonce {
        var bytes = Data(count: 4)
        withUnsafeBytes(of: n.bigEndian) { bytes.append(contentsOf: $0) }
        n += 1
        return try ChaChaPoly.Nonce(data: bytes)
    }

    mutating func seal(_ plain: Data) throws -> Data {
        let box = try ChaChaPoly.seal(plain, using: key, nonce: nonce(), authenticating: aad)
        return box.ciphertext + box.tag
    }

    mutating func open(_ sealed: Data) throws -> Data {
        guard sealed.count >= 16 else { throw LinkError.protocolError("frame too short") }
        let box = try ChaChaPoly.SealedBox(nonce: nonce(), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
        return try ChaChaPoly.open(box, using: key, authenticating: aad)
    }
}

public enum LinkError: LocalizedError {
    case badCode(String)
    case protocolError(String)
    case refused(String)
    case unreachable(String)

    public var errorDescription: String? {
        switch self {
        case .badCode(let m), .protocolError(let m), .refused(let m), .unreachable(let m): m
        }
    }
}

/// A pairing code: what the Link's QR code carries.
///
///     reflex://pair?v=0&o=<offer>&d=<device>&k=<key>&s=<secret>&h=<host,host>&p=<port>&n=<name>&pi=<person>&pn=<person name>
public struct PairingOffer: Sendable {
    public var offer: String
    public var device: String
    public var key: String
    public var secret: Data
    public var hosts: [String]
    public var port: UInt16
    public var name: String
    public var person: Person

    public init(_ text: String) throws {
        guard let u = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), u.scheme == "reflex", u.host == "pair" else {
            throw LinkError.badCode("That is not a pairing code. It starts with reflex://pair?")
        }
        let q = Dictionary((u.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        func need(_ k: String) throws -> String {
            guard let v = q[k], !v.isEmpty else { throw LinkError.badCode("The pairing code is missing '\(k)'. Copy the whole code.") }
            return v
        }
        guard try need("v") == "0" else { throw LinkError.badCode("This pairing code's version is not supported.") }
        offer = try need("o")
        device = try need("d")
        key = try need("k")
        guard let s = B64.decode(try need("s")), s.count == 32 else { throw LinkError.badCode("The pairing code's secret is damaged.") }
        secret = s
        hosts = try need("h").split(separator: ",").map(String.init)
        guard let p = UInt16(try need("p")) else { throw LinkError.badCode("The pairing code's port is damaged.") }
        port = p
        name = q["n"] ?? ""
        person = Person(id: try need("pi"), name: q["pn"] ?? "")
    }
}

public struct Person: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
}
