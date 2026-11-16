// reflex-p2p: listens over Apple peer-to-peer Wi-Fi (AWDL) and pipes every
// connection's bytes to the Link on stdin/stdout. It never looks inside the
// bytes: framing, the handshake and encryption all happen in the Link
// (link/transports/p2p.ts), exactly as on the LAN transport.
//
//   reflex-p2p --device <id> [--port <n>] [--any-interface]
//
// Messages both ways are length-prefixed: u32 BE length, then u8 kind,
// u32 BE connection, payload.
//   helper → Link  1 ready {port}   2 open {remote, interface}   3 data
//                  4 closed reason  5 log text   6 sent u32 (bytes the network took)
//   Link → helper  3 data   4 close
//
// Only connections that arrive on a peer-to-peer interface (awdl*, llw*) are
// passed on, so this path never quietly rides the same Wi-Fi network as LAN.
// `--any-interface` lifts that, for trying it on one machine.
// When stdin closes (the Link is gone) the helper exits.
import Foundation
import Network

enum Kind: UInt8 {
    case ready = 1, open, data, closed, log, sent
}

final class Helper: @unchecked Sendable {
    let queue = DispatchQueue(label: "si.eilmer.reflex.p2p")
    let out = FileHandle.standardOutput
    let device: String
    let port: UInt16
    let anyInterface: Bool
    var listener: NWListener?
    var conns: [UInt32: NWConnection] = [:]
    var nextID: UInt32 = 1

    init(device: String, port: UInt16, anyInterface: Bool) {
        self.device = device
        self.port = port
        self.anyInterface = anyInterface
    }

    func emit(_ kind: Kind, _ conn: UInt32, _ payload: Data = Data()) {
        var msg = Data()
        msg.append(be32(UInt32(5 + payload.count)))
        msg.append(kind.rawValue)
        msg.append(be32(conn))
        msg.append(payload)
        out.write(msg)
    }

    func log(_ s: String) { emit(.log, 0, Data(s.utf8)) }

    func json(_ v: [String: Any]) -> Data { (try? JSONSerialization.data(withJSONObject: v)) ?? Data("{}".utf8) }

    func start() {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 10
        let params = NWParameters(tls: nil, tcp: tcp)
        params.includePeerToPeer = true
        let l: NWListener
        do {
            l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port) ?? .any)
        } catch {
            log("could not listen on port \(port): \(error)")
            exit(2)
        }
        // Bonjour only says where the Link might be; the Link authenticates every connection.
        l.service = NWListener.Service(name: "Reflex Link \(device)", type: "_reflex-p2p._tcp", txtRecord: txt(extraTXT().merging(["dev": device, "v": "0"]) { _, mine in mine }))
        l.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.emit(.ready, 0, self.json(["port": Int(l.port?.rawValue ?? 0)]))
            case .failed(let e):
                self.log("listener failed: \(e)")
                exit(3)
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        l.start(queue: queue)
        listener = l
    }

    func txt(_ d: [String: String]) -> NWTXTRecord {
        var r = NWTXTRecord()
        for (k, v) in d { r[k] = v }
        return r
    }

    func accept(_ c: NWConnection) {
        let id = nextID
        nextID += 1
        c.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                let names = c.currentPath?.availableInterfaces.map(\.name) ?? []
                let iface = names.first ?? "?"
                let p2p = names.contains { $0.hasPrefix("awdl") || $0.hasPrefix("llw") }
                if !p2p && !self.anyInterface {
                    self.log("refused \(c.endpoint) on \(iface): not a peer-to-peer interface")
                    c.cancel()
                    return
                }
                self.conns[id] = c
                self.emit(.open, id, self.json(["remote": "\(c.endpoint)", "interface": iface]))
                self.receive(id, c)
            case .failed(let e):
                self.finish(id, c, "failed: \(e)")
            case .cancelled:
                self.finish(id, c, "closed")
            default: break
            }
        }
        c.start(queue: queue)
    }

    func receive(_ id: UInt32, _ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
            guard let self else { return }
            if let data, !data.isEmpty { self.emit(.data, id, data) }
            if done || error != nil {
                c.cancel()
            } else {
                self.receive(id, c)
            }
        }
    }

    func finish(_ id: UInt32, _ c: NWConnection, _ reason: String) {
        guard conns.removeValue(forKey: id) != nil else { return }
        emit(.closed, id, Data(reason.utf8))
    }

    /// One message from the Link.
    func handle(_ kind: UInt8, _ id: UInt32, _ payload: Data) {
        guard let c = conns[id] else { return }
        switch Kind(rawValue: kind) {
        case .data:
            let n = UInt32(payload.count)
            c.send(content: payload, completion: .contentProcessed { [weak self] _ in self?.emit(.sent, id, be32(n)) })
        case .closed:
            c.cancel()
        default:
            return
        }
    }
}

func be32(_ n: UInt32) -> Data {
    withUnsafeBytes(of: n.bigEndian) { Data($0) }
}

/// More of the Bonjour record, from the Link (REFLEX_P2P_TXT, a JSON object of strings): its key, name and person,
/// so an iPad with a typed pairing code knows whose Link it found. An environment variable, not an argument, so an
/// older helper simply ignores it.
func extraTXT() -> [String: String] {
    guard let raw = ProcessInfo.processInfo.environment["REFLEX_P2P_TXT"]?.data(using: .utf8),
          let d = try? JSONSerialization.jsonObject(with: raw) as? [String: String] else { return [:] }
    return d
}

func readBE32(_ d: Data, _ at: Int) -> UInt32 {
    d[d.startIndex + at ..< d.startIndex + at + 4].reduce(0) { $0 << 8 | UInt32($1) }
}

var device = ""
var port: UInt16 = 0
var anyInterface = false
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    switch a {
    case "--device": device = args.next() ?? ""
    case "--port": port = UInt16(args.next() ?? "") ?? 0
    case "--any-interface": anyInterface = true
    default:
        FileHandle.standardError.write(Data("unknown argument \(a)\n".utf8))
        exit(64)
    }
}
guard !device.isEmpty else {
    FileHandle.standardError.write(Data("usage: reflex-p2p --device <id> [--port <n>] [--any-interface]\n".utf8))
    exit(64)
}

let helper = Helper(device: device, port: port, anyInterface: anyInterface)
helper.queue.async { helper.start() }

// Messages from the Link, on a thread of their own; each one is handled on the helper's queue.
Thread.detachNewThread {
    var buf = Data()
    let input = FileHandle.standardInput
    while true {
        let chunk = input.availableData
        if chunk.isEmpty { exit(0) } // the Link closed our stdin: it is gone
        buf.append(chunk)
        while buf.count >= 4 {
            let n = Int(readBE32(buf, 0))
            guard n >= 5 else { exit(65) }
            guard buf.count >= 4 + n else { break }
            let kind = buf[buf.startIndex + 4]
            let id = readBE32(buf, 5)
            let payload = buf.subdata(in: buf.startIndex + 9 ..< buf.startIndex + 4 + n)
            buf = Data(buf.dropFirst(4 + n))
            helper.queue.async { helper.handle(kind, id, payload) }
        }
    }
}
dispatchMain()
