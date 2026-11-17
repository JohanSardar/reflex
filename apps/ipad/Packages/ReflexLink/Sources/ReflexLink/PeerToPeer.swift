import Foundation
import Network

/// Finds the paired Link over Apple peer-to-peer Wi-Fi (AWDL): its helper
/// advertises `_reflex-p2p._tcp` (`link/transports/p2p/`). Only results seen
/// on a peer-to-peer interface count, so this path never rides the same Wi-Fi
/// network as LAN, and it works with no shared network at all. Discovery is
/// never authentication: the handshake proves the Link's key.
@MainActor
final class PeerToPeerBrowser {
    struct Found {
        var endpoint: NWEndpoint
        var interface: NWInterface
    }

    private var browser: NWBrowser?
    private let device: String
    private let onChange: @MainActor (Found?) -> Void
    private(set) var found: Found?

    init(device: String, onChange: @escaping @MainActor (Found?) -> Void) {
        self.device = device
        self.onChange = onChange
    }

    static func isPeerToPeer(_ i: NWInterface) -> Bool {
        i.name.hasPrefix("awdl") || i.name.hasPrefix("llw")
    }

    func start() {
        guard browser == nil else { return }
        let params = NWParameters()
        params.includePeerToPeer = true
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_reflex-p2p._tcp", domain: nil), using: params)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in self?.update(results) }
        }
        // iPadOS ends a backgrounded app's Bonjour browsing (DefunctConnection): start over.
        b.stateUpdateHandler = { [weak self] state in
            guard case .failed(let e) = state else { return }
            Task { @MainActor in
                guard let self, self.browser === b else { return }
                linkLog.error(
                    "Peer-to-peer browsing failed: \(e.localizedDescription, privacy: .public); browsing again")
                b.cancel()
                self.browser = nil
                try? await Task.sleep(for: .seconds(1))
                self.start()
            }
        }
        b.start(queue: .main)
        browser = b
    }

    private func update(_ results: Set<NWBrowser.Result>) {
        var next: Found?
        for r in results {
            guard case .bonjour(let txt) = r.metadata, txt["dev"] == device,
                let i = r.interfaces.first(where: Self.isPeerToPeer)
            else { continue }
            next = Found(endpoint: r.endpoint, interface: i)
        }
        let changed = (next == nil) != (found == nil) || next.map { "\($0.endpoint)" } != found.map { "\($0.endpoint)" }
        found = next
        if changed {
            linkLog.info(
                "Peer-to-peer: \(next.map { "found the Link on \($0.interface.name)" } ?? "the Link is out of range", privacy: .public)"
            )
            onChange(next)
        }
    }

    func stop() {
        browser?.cancel()
        browser = nil
        found = nil
    }
}
