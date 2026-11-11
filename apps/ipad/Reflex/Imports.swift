import AVFoundation
import PDFKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Turning what the person adds (photos, camera captures, PDFs, files) into
/// bytes for assets.
enum Imports {
    /// The largest side an imported picture keeps, in pixels.
    static let maxPixels: CGFloat = 2400

    /// A picture as JPEG, or PNG when it has transparency, no larger than `maxPixels`.
    static func encode(_ image: UIImage) -> Data? {
        let px = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let s = min(1, maxPixels / max(px.width, px.height, 1))
        let target = CGSize(width: (px.width * s).rounded(), height: (px.height * s).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let alpha = image.cgImage.map { ![.none, .noneSkipFirst, .noneSkipLast].contains($0.alphaInfo) } ?? false
        format.opaque = !alpha
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return alpha ? resized.pngData() : resized.jpegData(compressionQuality: 0.85)
    }

    /// `size` scaled down to fit `box`, keeping its shape.
    static func fit(_ size: CGSize, in box: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return box }
        let s = min(1, box.width / size.width, box.height / size.height)
        return CGSize(width: (size.width * s).rounded(), height: (size.height * s).rounded())
    }

    enum ModelImport: Error, LocalizedError {
        case unreadable, external
        var errorDescription: String? {
            switch self {
            case .unreadable: "it isn't a glTF 2.0 file"
            case .external: "its buffers or images are separate files; export it as .glb"
            }
        }
    }

    /// A .gltf whose buffers and images are inside it (data: URIs) packed into one .glb, as the Link packs one.
    static func packGLTF(_ data: Data) throws -> Data {
        guard var gltf = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (gltf["asset"] as? [String: Any])?["version"] as? String == "2.0" else { throw ModelImport.unreadable }
        func decode(_ uri: String) throws -> Data {
            guard uri.hasPrefix("data:"), let comma = uri.firstIndex(of: ","), uri[..<comma].hasSuffix(";base64"),
                  let d = Data(base64Encoded: String(uri[uri.index(after: comma)...])) else { throw ModelImport.external }
            return d
        }
        let pad4 = { (n: Int) in (n + 3) & ~3 }
        var bin = Data()
        var offsets: [Int] = []
        for b in gltf["buffers"] as? [[String: Any]] ?? [] {
            guard let uri = b["uri"] as? String else { throw ModelImport.external }
            offsets.append(bin.count)
            bin.append(try decode(uri))
            bin.append(Data(count: pad4(bin.count) - bin.count))
        }
        var views = gltf["bufferViews"] as? [[String: Any]] ?? []
        for i in views.indices {
            let buf = views[i]["buffer"] as? Int ?? 0
            views[i]["byteOffset"] = (views[i]["byteOffset"] as? Int ?? 0) + (buf < offsets.count ? offsets[buf] : 0)
            views[i]["buffer"] = 0
        }
        var images = gltf["images"] as? [[String: Any]] ?? []
        for i in images.indices {
            guard let uri = images[i]["uri"] as? String else { continue }
            let d = try decode(uri)
            views.append(["buffer": 0, "byteOffset": bin.count, "byteLength": d.count])
            bin.append(d)
            bin.append(Data(count: pad4(bin.count) - bin.count))
            images[i]["bufferView"] = views.count - 1
            images[i]["mimeType"] = uri.hasPrefix("data:image/png") ? "image/png" : "image/jpeg"
            images[i]["uri"] = nil
        }
        gltf["bufferViews"] = views
        if !images.isEmpty { gltf["images"] = images }
        gltf["buffers"] = bin.isEmpty ? [] : [["byteLength": bin.count]]
        var json = try JSONSerialization.data(withJSONObject: gltf)
        json.append(Data(repeating: 0x20, count: pad4(json.count) - json.count))
        var out = Data("glTF".utf8)
        func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { out.append(contentsOf: $0) } }
        u32(2)
        u32(12 + 8 + json.count + (bin.isEmpty ? 0 : 8 + bin.count))
        u32(json.count); out.append(Data("JSON".utf8)); out.append(json)
        if !bin.isEmpty { u32(bin.count); out.append(Data([0x42, 0x49, 0x4E, 0x00])); out.append(bin) }
        return out
    }

    /// Every page of a PDF, rendered on white at up to `maxPixels` (at most 100 pages).
    static func pdfPages(_ data: Data) -> [UIImage]? {
        guard let doc = PDFDocument(data: data), doc.pageCount > 0 else { return nil }
        return (0 ..< min(doc.pageCount, 100)).compactMap { i in
            guard let page = doc.page(at: i) else { return nil }
            let box = page.bounds(for: .mediaBox).size
            let s = min(3, maxPixels / max(box.width, box.height, 1))
            return page.thumbnail(of: CGSize(width: box.width * s, height: box.height * s), for: .mediaBox)
        }
    }
}

/// The + menu: Photos, the camera and Files.
struct ImportMenu: View {
    let session: SpaceSession
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false

    var body: some View {
        Menu {
            Button { showPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
                .accessibilityIdentifier("import-photos")
            Button { showCamera = true } label: { Label("Take Photo", systemImage: "camera") }
                .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
                .accessibilityIdentifier("import-camera")
            Button { showFiles = true } label: { Label("Files", systemImage: "folder") }
                .accessibilityIdentifier("import-files")
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 48, height: 48)
                .glassEffect()
        }
        .accessibilityIdentifier("import-menu")
        .accessibilityLabel("Add photos and files")
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: 10, matching: .any(of: [.images, .screenshots]))
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        session.importImage(data, name: item.itemIdentifier.map { "Photo \($0.prefix(8))" } ?? "Photo")
                    }
                }
            }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { for url in urls { session.importFile(url) } }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                if let image, let data = image.jpegData(compressionQuality: 0.9) {
                    session.importImage(data, name: "Camera photo")
                }
                showCamera = false
            }
            .ignoresSafeArea()
        }
    }
}

/// The system camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
    let done: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (UIImage?) -> Void
        init(done: @escaping (UIImage?) -> Void) { self.done = done }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            done(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { done(nil) }
    }
}

/// Files and pictures dropped on the canvas from another app.
struct CanvasDrop: DropDelegate {
    let session: SpaceSession

    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: [.item]) }

    func performDrop(info: DropInfo) -> Bool {
        let providers = info.itemProviders(for: [.item])
        for p in providers {
            let type = p.registeredContentTypes.first { $0.conforms(to: .pdf) }
                ?? p.registeredContentTypes.first { $0.conforms(to: .image) }
                ?? p.registeredContentTypes.first
            guard let type else { continue }
            let name = p.suggestedName ?? "Dropped file"
            _ = p.loadDataRepresentation(for: type) { data, _ in
                guard let data else { return }
                Task { @MainActor in
                    let ext = type.preferredFilenameExtension.map { name.hasSuffix(".\($0)") ? name : "\(name).\($0)" } ?? name
                    session.importData(data, name: ext, type: type)
                }
            }
        }
        return !providers.isEmpty
    }
}
