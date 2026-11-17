import CryptoKit
import Foundation

/// CPace over X25519: a typed code checked through a Relay's pairing room, byte for byte as
/// `link/pairing/cpace.ts`. Every try costs someone without the code one guess and tells them nothing.
///
///     g  = the first hash of (code, transcript, i) that is a u-coordinate on Curve25519 (not its twist)
///     Y  = X25519(y, g)  sent;   K = X25519(y, their Y)
///     secret = SHA-256(protocol " cpace secret " K Ya Yb transcript), for the auth MACs
struct Cpace {
    private let y = Curve25519.KeyAgreement.PrivateKey()
    let share: Data

    init(code: String, transcript: Data) throws {
        share = try Self.x25519(y, Self.generator(code: code, transcript: transcript))
    }

    /// The pairing secret, once the other side's share arrived. Throws on a low-order share (an all-zero K).
    func secret(theirs: Data, initiator: Bool, transcript: Data) throws -> Data {
        guard theirs.count == 32 else { throw LinkError.protocolError("a malformed CPace share") }
        let k = try Self.x25519(y, theirs)
        let (ya, yb) = initiator ? (share, theirs) : (theirs, share)
        return sha256(Data("\(linkProtocol) cpace secret ".utf8), k, ya, yb, transcript)
    }

    private static func x25519(_ k: Curve25519.KeyAgreement.PrivateKey, _ u: Data) throws -> Data {
        let s = try k.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: u))
        let d = s.withUnsafeBytes { Data($0) }
        guard d.contains(where: { $0 != 0 }) else { throw LinkError.refused("The Link refused: wrong pairing code") }
        return d
    }

    /// The generator: try-and-increment, keeping the first u with u³ + Au² + u a square mod p.
    static func generator(code: String, transcript: Data) throws -> Data {
        for i in 0..<1000 {
            var h = sha256(
                Data("\(linkProtocol) cpace generator \(i) ".utf8), Data(code.utf8), Data(" ".utf8), transcript)
            h[h.startIndex + 31] &= 0x7f
            let u = Fe(h)
            guard !u.isZero, !u.isOne, u.lessThanP else { continue }
            let rhs = u.mul(u.mul(u.add(Fe.a)).add(Fe.one))
            if rhs.pow(Fe.halfPMinusOne).isOne { return h }
        }
        throw LinkError.protocolError("no CPace generator found")
    }
}

/// An element of GF(2²⁵⁵ − 19), four little-endian 64-bit limbs. Only what the generator needs: add,
/// multiply, power. Values stay below 2²⁵⁶ between steps and are reduced fully before a comparison.
struct Fe {
    var l: [UInt64]

    static let p = Fe(limbs: [
        0xffff_ffff_ffff_ffed, 0xffff_ffff_ffff_ffff, 0xffff_ffff_ffff_ffff, 0x7fff_ffff_ffff_ffff,
    ])
    static let one = Fe(limbs: [1, 0, 0, 0])
    static let a = Fe(limbs: [486_662, 0, 0, 0])
    /// (p − 1) / 2 = 2²⁵⁴ − 10.
    static let halfPMinusOne = Fe(limbs: [
        0xffff_ffff_ffff_fff6, 0xffff_ffff_ffff_ffff, 0xffff_ffff_ffff_ffff, 0x3fff_ffff_ffff_ffff,
    ])

    init(limbs: [UInt64]) { l = limbs }

    /// 32 bytes, little-endian.
    init(_ d: Data) {
        let b = [UInt8](d)
        var limbs = [UInt64](repeating: 0, count: 4)
        for i in 0..<32 { limbs[i / 8] |= UInt64(b[i]) << UInt64(8 * (i % 8)) }
        l = limbs
    }

    var lessThanP: Bool {
        for i in (0..<4).reversed() where l[i] != Fe.p.l[i] { return l[i] < Fe.p.l[i] }
        return false
    }

    /// Fully reduced (below p).
    var reduced: Fe {
        var r = self
        while !r.lessThanP {
            var borrow = false
            for i in 0..<4 {
                let (d1, o1) = r.l[i].subtractingReportingOverflow(Fe.p.l[i])
                let (d2, o2) = d1.subtractingReportingOverflow(borrow ? 1 : 0)
                r.l[i] = d2
                borrow = o1 || o2
            }
        }
        return r
    }

    var isZero: Bool { reduced.l == [0, 0, 0, 0] }
    var isOne: Bool { reduced.l == [1, 0, 0, 0] }

    /// Folds a carry above 2²⁵⁶ back in: 2²⁵⁶ ≡ 38 (mod p).
    private static func fold(_ r: inout [UInt64], _ carry: UInt64) {
        var c = carry
        while c != 0 {
            let (hi, lo) = c.multipliedFullWidth(by: 38)
            var add = lo
            var next = hi
            for i in 0..<4 {
                let (s, o) = r[i].addingReportingOverflow(add)
                r[i] = s
                add = o ? 1 : 0
                if add == 0 { break }
            }
            next &+= add
            c = next
        }
    }

    func add(_ b: Fe) -> Fe {
        var r = [UInt64](repeating: 0, count: 4)
        var carry: UInt64 = 0
        for i in 0..<4 {
            let (s1, o1) = l[i].addingReportingOverflow(b.l[i])
            let (s2, o2) = s1.addingReportingOverflow(carry)
            r[i] = s2
            carry = (o1 ? 1 : 0) + (o2 ? 1 : 0)
        }
        Fe.fold(&r, carry)
        return Fe(limbs: r)
    }

    func mul(_ b: Fe) -> Fe {
        var t = [UInt64](repeating: 0, count: 8)
        for i in 0..<4 {
            var carry: UInt64 = 0
            for j in 0..<4 {
                let (hi, lo) = l[i].multipliedFullWidth(by: b.l[j])
                let (s1, o1) = t[i + j].addingReportingOverflow(lo)
                let (s2, o2) = s1.addingReportingOverflow(carry)
                t[i + j] = s2
                carry = hi &+ (o1 ? 1 : 0) &+ (o2 ? 1 : 0)
            }
            t[i + 4] = carry
        }
        // low + 38 · high
        var r = [UInt64](repeating: 0, count: 4)
        var carry: UInt64 = 0
        for i in 0..<4 {
            let (hi, lo) = t[i + 4].multipliedFullWidth(by: 38)
            let (s1, o1) = t[i].addingReportingOverflow(lo)
            let (s2, o2) = s1.addingReportingOverflow(carry)
            r[i] = s2
            carry = hi &+ (o1 ? 1 : 0) &+ (o2 ? 1 : 0)
        }
        Fe.fold(&r, carry)
        return Fe(limbs: r)
    }

    func pow(_ e: Fe) -> Fe {
        var result = Fe.one
        for i in (0..<4).reversed() {
            for bit in (0..<64).reversed() {
                result = result.mul(result)
                if (e.l[i] >> UInt64(bit)) & 1 == 1 { result = result.mul(self) }
            }
        }
        return result
    }
}
