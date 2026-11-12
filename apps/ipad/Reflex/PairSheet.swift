import ReflexLink
import SwiftUI
import VisionKit

/// Pairs this iPad with a Link: scan the QR code `reflex link` shows, or type
/// the code printed under it where there is no camera (such as the Simulator).
struct PairSheet: View {
    let link: LinkSync
    @State var code: String
    @State private var scanning = false
    @State private var busy = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    private var canScan: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if case .connected(let name) = link.state {
                        Label("Connected to \(name)", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else if case .offline(let why) = link.state {
                        Label(why, systemImage: "wifi.exclamationmark").foregroundStyle(.secondary)
                    } else if case .linkChanged = link.state {
                        Label("This Mac's Link changed. Scan its code again.", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(.orange)
                    }
                    Text("Run `reflex setup` on your computer (or `reflex pair` for a new code). It shows a QR code and the same code as text.")
                        .foregroundStyle(.secondary)
                }
                if canScan {
                    Section {
                        Button { scanning = true } label: { Label("Scan the QR code", systemImage: "qrcode.viewfinder") }
                    }
                }
                Section("Or type the code, or an invite someone sent you") {
                    TextField("reflex://pair?… or reflex://invite?…", text: $code, axis: .vertical)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .lineLimit(3 ... 8)
                        .accessibilityIdentifier("pair-code")
                    Button {
                        Task { await pair(code) }
                    } label: {
                        if busy { ProgressView() } else { Text(isInvite ? "Join" : "Pair") }
                    }
                    .disabled(busy || code.isEmpty)
                    .accessibilityIdentifier("pair-button")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("pair-error") }
                }
            }
            .navigationTitle("Connect to your Link")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .sheet(isPresented: $scanning) {
                QRScanner { found in
                    scanning = false
                    code = found
                    Task { await pair(found) }
                }
                .ignoresSafeArea()
            }
        }
    }

    private var isInvite: Bool { code.trimmingCharacters(in: .whitespaces).hasPrefix("reflex://invite") }

    private func pair(_ text: String) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            // An invite to someone's shared Space: this iPad's Link presents it to theirs.
            if text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("reflex://invite") {
                _ = try await link.join(invite: text)
            } else {
                try await link.pair(code: text)
            }
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The camera, looking for a reflex://pair code.
struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        var done = false
        init(found: @escaping (String) -> Void) { self.found = found }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in items {
                if case .barcode(let b) = item, let s = b.payloadStringValue, s.hasPrefix("reflex://pair") || s.hasPrefix("reflex://invite"), !done {
                    done = true
                    scanner.stopScanning()
                    found(s)
                }
            }
        }
    }
}
